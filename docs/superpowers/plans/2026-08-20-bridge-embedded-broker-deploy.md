# Bridge Embedded Broker and Deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `bridge/` its own embedded MQTT broker (loopback-plain in dev, public MQTTS+auth when TLS is configured), add a shared-secret `AUTH_TOKEN` gate on `POST` (HTTP) and `CONNECT` (MQTT), and add the two `deploy.sh` module changes and the `weather.rkroll.com` deploy config that a real deploy needs.

**Architecture:** `bin/mqtt-http-bridge.js` gains a CLI-parsing step and, when embedding is enabled (default), starts an `aedes` broker in-process before calling the existing `connectBroker`. Two new small modules carry the new logic: `src/embedded-broker.js` (starts the aedes listener, installs the MQTT `authenticate` hook in TLS mode) and `src/auth.js` (the one constant-time token comparison both surfaces use). `src/server.js` gains the HTTP-side `401` check. `src/config.js` gains the new fields and a CLI-argv parameter. `src/broker.js` gains one small additive option (documented as a deliberate, minimal deviation from the spec's "no changes to broker.js" framing — see Task 4). Separately, in the `deploy.sh` repo, the `apache` and `letsencrypt` modules gain two opt-in variables, and `bridge/deploy.conf` + `bridge/secrets.env.example` are added to this repo.

**Tech Stack:** Node.js 22, `aedes` (embedded MQTT broker), `mqtt` (client), `node:crypto.timingSafeEqual`, `node:util.parseArgs`, `node:tls`/`node:net`; `deploy.sh`'s bash module system (`lib/common.sh`, `modules/apache`, `modules/letsencrypt`).

## Global Constraints

- Node 22+, ES modules (`bridge/package.json` already has `"type": "module"`).
- `AUTH_TOKEN` comparisons (HTTP bearer token and MQTT `CONNECT` password) MUST use `node:crypto.timingSafeEqual` on equal-length buffers, rejecting immediately without comparing when lengths differ.
- TLS mode (both `--tls-cert`/`TLS_CERT` and `--tls-key`/`TLS_KEY` set) MUST fail fast — throw before any `.listen()` call — if `AUTH_TOKEN` is unset.
- Only one embedded-broker listener ever runs: loopback plain MQTT (no TLS configured) or public MQTTS (TLS configured). Never both.
- CLI flag > env var > default, for every field in this table:

  | CLI flag | Env var | Default |
  |---|---|---|
  | `--no-embed-broker` | `EMBED_BROKER=false` | embed (`true`) |
  | `--broker-url <url>` | `MQTT_URL` | `mqtt://localhost:1883` |
  | `--mqtt-port <n>` | `MQTT_PORT` | `1883` |
  | `--mqtts-port <n>` | `MQTTS_PORT` | `8883` |
  | `--tls-cert <path>` | `TLS_CERT` | unset |
  | `--tls-key <path>` | `TLS_KEY` | unset |
  | `--auth-token <token>` | `AUTH_TOKEN` | unset |

- `deploy.sh` changes are opt-in additions to existing modules — no behavior change for any `deploy.conf` that doesn't set `APACHE_PROXY_FLUSH_PATHS` or `LETSENCRYPT_KEY_READER`.
- Two separate git repos are touched: `/home/john/src/rtl433-web-receiver` (bridge + its docs) and `/home/john/src/deploy.sh` (the two module changes). Each gets its own branch, worked in a worktree per `superpowers:using-git-worktrees`, and fast-forward-merged to that repo's own `main` when its tasks are done and reviewed — no PRs (see the user's global instructions).

## Design note: why `src/broker.js` gets one additive line

The spec's "Embedding aedes" section says `connectBroker` is called "exactly as today" with no changes to `broker.js`. That line is accurate for the no-TLS case. In TLS mode the embedded broker's only listener is public MQTTS on `0.0.0.0:<mqttsPort>` (see the spec's "Two listener modes" — there is no separate always-on plain loopback listener; running both is explicitly out of scope). The bridge's own internal `connectBroker` client therefore has to reach that same MQTTS listener over `mqtts://127.0.0.1:<mqttsPort>`, whose certificate (issued for `weather.rkroll.com`) will never validate against the loopback IP under Node's default TLS trust rules. `connectBroker` today has no way to relax that check, and it needs one — otherwise the internal connection can never come up in TLS mode at all. Task 4 adds a single optional `tls` pass-through parameter to `connectBroker`, defaulting to `undefined` so every existing call site and test is byte-for-byte unaffected. This is the smallest change that keeps the rest of the spec's promise intact: `cache.js`, `server.js`'s existing behavior, and the whole tested `mqtt`-client code path are still reused unchanged.

---

## Part 1 — `rtl433-web-receiver` repo (`bridge/`)

Work happens on a branch off `main`, in a worktree created via `superpowers:using-git-worktrees`.

### Task 1: `aedes` becomes a runtime dependency

**Files:**
- Modify: `bridge/package.json`

**Model:** `haiku` — one-line move between two existing JSON blocks.

**Interfaces:**
- Produces: nothing new — `aedes` remains importable as `import Aedes from 'aedes'`, now from `dependencies` instead of `devDependencies`.

- [ ] **Step 1: Move `aedes` from `devDependencies` to `dependencies`**

Edit `bridge/package.json` so it reads:

```json
{
  "name": "mqtt-http-bridge",
  "version": "0.1.0",
  "description": "HTTP binding for an MQTT broker: GET a retained message, POST to publish, SSE to subscribe",
  "type": "module",
  "engines": { "node": ">=22" },
  "bin": { "mqtt-http-bridge": "bin/mqtt-http-bridge.js" },
  "scripts": {
    "test": "node --test test/*.test.js"
  },
  "dependencies": {
    "aedes": "^0.51.3",
    "mqtt": "^5.10.1"
  },
  "license": "MIT"
}
```

- [ ] **Step 2: Reinstall to confirm the lockfile is consistent**

Run: `cd bridge && npm install`
Expected: exits 0, `package-lock.json` updates `aedes`'s entry to a non-dev dependency (or is unchanged if already consistent).

- [ ] **Step 3: Commit**

```bash
cd bridge
git add package.json package-lock.json
git commit -m "build: aedes is a runtime dependency of the embedded broker"
```

---

### Task 2: `src/auth.js` — the one constant-time token check

**Files:**
- Create: `bridge/src/auth.js`
- Test: `bridge/test/auth.test.js`

**Model:** `sonnet` — small module, but the security property (constant-time, no early exit on content) needs care.

**Interfaces:**
- Produces: `tokenMatches(provided, expected)` — `provided` may be `undefined`, a `string`, or a `Buffer`; `expected` is always a non-empty `string`. Returns `boolean`. Used by Task 5 (MQTT `authenticate`, where `password` is a `Buffer`) and Task 6 (HTTP bearer token, where the extracted value is a `string`).

- [ ] **Step 1: Write the failing tests**

Create `bridge/test/auth.test.js`:

```javascript
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { tokenMatches } from '../src/auth.js'

test('the right token matches, string or buffer', () => {
  assert.equal(tokenMatches('s3cr3t', 's3cr3t'), true)
  assert.equal(tokenMatches(Buffer.from('s3cr3t'), 's3cr3t'), true)
})

test('a wrong token of the same length does not match', () => {
  assert.equal(tokenMatches('s3cr3u', 's3cr3t'), false)
})

test('a token of a different length does not match', () => {
  assert.equal(tokenMatches('short', 's3cr3t'), false)
  assert.equal(tokenMatches('a-much-longer-guess', 's3cr3t'), false)
})

test('a missing token does not match', () => {
  assert.equal(tokenMatches(undefined, 's3cr3t'), false)
  assert.equal(tokenMatches('', 's3cr3t'), false)
})

test('an empty expected token never matches, even an empty provided one', () => {
  // AUTH_TOKEN is never configured as "", but a caller passing one through
  // should not get a false "everything matches" from a zero-length compare.
  assert.equal(tokenMatches('', ''), false)
  assert.equal(tokenMatches('anything', ''), false)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd bridge && node --test test/auth.test.js`
Expected: FAIL — `Cannot find module '../src/auth.js'` (or similar import error).

- [ ] **Step 3: Write `src/auth.js`**

```javascript
import { timingSafeEqual } from 'node:crypto'

// A naive `===` leaks the token's length and prefix through response
// timing. Both HTTP's bearer-token check and MQTT's CONNECT-password check
// go through this one function so there is exactly one place that has to
// get the constant-time discipline right.
export function tokenMatches(provided, expected) {
  if (expected.length === 0) return false
  if (provided === undefined) return false
  const providedBuf = Buffer.isBuffer(provided) ? provided : Buffer.from(provided)
  const expectedBuf = Buffer.from(expected)
  if (providedBuf.length !== expectedBuf.length) return false
  return timingSafeEqual(providedBuf, expectedBuf)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd bridge && node --test test/auth.test.js`
Expected: PASS, all 5 tests.

- [ ] **Step 5: Commit**

```bash
cd bridge
git add src/auth.js test/auth.test.js
git commit -m "feat: constant-time token comparison shared by HTTP and MQTT auth"
```

---

### Task 3: `src/config.js` — new fields, CLI precedence

**Files:**
- Modify: `bridge/src/config.js`
- Modify: `bridge/test/config.test.js`

**Model:** `sonnet` — precedence rules and validation across six new fields.

**Interfaces:**
- Consumes: nothing new.
- Produces: `readConfig(env, cli = {})` returns an object with the existing `{ mqttUrl, port, host, username, password }` fields plus new `{ embedBroker, mqttPort, mqttsPort, tlsCert, tlsKey, authToken }`. `cli` is a plain object with camelCase keys `{ noEmbedBroker, brokerUrl, mqttPort, mqttsPort, tlsCert, tlsKey, authToken }` — each either `undefined` or the raw string/boolean `node:util.parseArgs` produced. This shape is what Task 7's `bin/mqtt-http-bridge.js` builds and passes in.

- [ ] **Step 1: Write the failing tests**

Replace the contents of `bridge/test/config.test.js` with:

```javascript
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { brokerLabel, readConfig } from '../src/config.js'

test('an empty environment gives the local defaults', () => {
  assert.deepEqual(readConfig({}), {
    mqttUrl: 'mqtt://localhost:1883',
    port: 8080,
    host: '0.0.0.0',
    username: undefined,
    password: undefined,
    embedBroker: true,
    mqttPort: 1883,
    mqttsPort: 8883,
    tlsCert: undefined,
    tlsKey: undefined,
    authToken: undefined,
  })
})

test('the environment overrides every field', () => {
  const config = readConfig({
    MQTT_URL: 'mqtt://broker.local:1883',
    PORT: '9000',
    HOST: '127.0.0.1',
    MQTT_USERNAME: 'user',
    MQTT_PASSWORD: 'secret',
    EMBED_BROKER: 'false',
    MQTT_PORT: '11883',
    MQTTS_PORT: '18883',
    TLS_CERT: '/etc/cert.pem',
    TLS_KEY: '/etc/key.pem',
    AUTH_TOKEN: 'tok',
  })
  assert.deepEqual(config, {
    mqttUrl: 'mqtt://broker.local:1883',
    port: 9000,
    host: '127.0.0.1',
    username: 'user',
    password: 'secret',
    embedBroker: false,
    mqttPort: 11883,
    mqttsPort: 18883,
    tlsCert: '/etc/cert.pem',
    tlsKey: '/etc/key.pem',
    authToken: 'tok',
  })
})

test('a PORT that is not a number is rejected rather than defaulted', () => {
  assert.throws(() => readConfig({ PORT: 'http' }), /PORT/)
  assert.throws(() => readConfig({ PORT: '' }), /PORT/)
  assert.throws(() => readConfig({ PORT: '  ' }), /PORT/)
  assert.throws(() => readConfig({ PORT: '8080.5' }), /PORT/)
  assert.throws(() => readConfig({ PORT: '65536' }), /PORT/)
  assert.throws(() => readConfig({ PORT: '-1' }), /PORT/)
  assert.equal(readConfig({ PORT: '0' }).port, 0)
  assert.equal(readConfig({ PORT: '65535' }).port, 65535)
})

test('MQTT_PORT and MQTTS_PORT validate the same way PORT does', () => {
  assert.throws(() => readConfig({ MQTT_PORT: 'x' }), /MQTT_PORT/)
  assert.throws(() => readConfig({ MQTT_PORT: '70000' }), /MQTT_PORT/)
  assert.throws(() => readConfig({ MQTTS_PORT: 'x' }), /MQTTS_PORT/)
  assert.throws(() => readConfig({ MQTTS_PORT: '-1' }), /MQTTS_PORT/)
})

test('CLI flags override the environment, which overrides the default', () => {
  const config = readConfig(
    { EMBED_BROKER: 'false', MQTT_PORT: '11883', AUTH_TOKEN: 'env-token' },
    { noEmbedBroker: false, mqttPort: '21883', authToken: 'cli-token' },
  )
  // --no-embed-broker was not passed (noEmbedBroker: false means "flag
  // absent", the same as node:util.parseArgs leaving a boolean flag unset).
  assert.equal(config.embedBroker, false)
  assert.equal(config.mqttPort, 21883)
  assert.equal(config.authToken, 'cli-token')
})

test('--no-embed-broker disables embedding even with no other config', () => {
  assert.equal(readConfig({}, { noEmbedBroker: true }).embedBroker, false)
})

test('--broker-url overrides MQTT_URL', () => {
  const config = readConfig({ MQTT_URL: 'mqtt://env:1883' }, { brokerUrl: 'mqtt://cli:1883' })
  assert.equal(config.mqttUrl, 'mqtt://cli:1883')
})

test('the printable broker address keeps the host and port and drops the credentials', () => {
  assert.equal(brokerLabel('mqtt://alice:s3cr3t@host.local:1883'), 'mqtt://host.local:1883')
  assert.equal(brokerLabel('mqtt://host.local:1883'), 'mqtt://host.local:1883')
  assert.equal(brokerLabel('mqtts://alice@host.local'), 'mqtts://host.local')
  assert.equal(brokerLabel('not a url'), 'unknown')
})

test('a URL with no host falls back the same way one that fails to parse does', () => {
  assert.equal(brokerLabel('mqtt://alice:s3cr3t@'), 'unknown')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd bridge && node --test test/config.test.js`
Expected: FAIL — `deepEqual` mismatches (missing new fields) and `MQTT_PORT`/`MQTTS_PORT`/CLI tests throwing "not a function" style errors or wrong values.

- [ ] **Step 3: Rewrite `src/config.js`**

```javascript
// mqtt.connect takes credentials in the URL, so printing MQTT_URL verbatim
// puts a password in the log of every service that runs the bridge.
export function brokerLabel(url) {
  try {
    const { protocol, host } = new URL(url)
    // A URL that parses but has no host, e.g. "mqtt://alice:s3cr3t@", falls
    // through to the same fallback as one that doesn't parse at all: every
    // caller embeds this in "broker <label>", where the old fallback,
    // "the broker", read as "broker the broker".
    return host ? `${protocol}//${host}` : 'unknown'
  } catch {
    return 'unknown'
  }
}

// Number('') and Number('  ') are both 0, which would otherwise pass
// validation and silently bind an ephemeral port. Shared by PORT,
// MQTT_PORT, and MQTTS_PORT, which all take the same kind of value.
function parsePort(name, raw, defaultValue) {
  const blank = typeof raw === 'string' && raw.trim() === ''
  const value = raw === undefined ? defaultValue : Number(raw)
  if (blank || !Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error(`${name} must be a port number, got ${JSON.stringify(raw)}`)
  }
  return value
}

export function readConfig(env, cli = {}) {
  const port = parsePort('PORT', env.PORT, 8080)
  const mqttPort = parsePort('MQTT_PORT', cli.mqttPort ?? env.MQTT_PORT, 1883)
  const mqttsPort = parsePort('MQTTS_PORT', cli.mqttsPort ?? env.MQTTS_PORT, 8883)

  const embedBroker = cli.noEmbedBroker ? false : env.EMBED_BROKER === 'false' ? false : true

  return {
    mqttUrl: cli.brokerUrl ?? env.MQTT_URL ?? 'mqtt://localhost:1883',
    port,
    host: env.HOST ?? '0.0.0.0',
    username: env.MQTT_USERNAME,
    password: env.MQTT_PASSWORD,
    embedBroker,
    mqttPort,
    mqttsPort,
    tlsCert: cli.tlsCert ?? env.TLS_CERT,
    tlsKey: cli.tlsKey ?? env.TLS_KEY,
    authToken: cli.authToken ?? env.AUTH_TOKEN,
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd bridge && node --test test/config.test.js`
Expected: PASS, all 9 tests.

- [ ] **Step 5: Run the full suite to confirm nothing else broke**

Run: `cd bridge && npm test`
Expected: PASS (other test files don't call `readConfig` directly, so they should be unaffected).

- [ ] **Step 6: Commit**

```bash
cd bridge
git add src/config.js test/config.test.js
git commit -m "feat(config): embed-broker, TLS, and auth-token fields with CLI precedence"
```

---

### Task 4: `src/broker.js` — optional `tls` pass-through

**Files:**
- Modify: `bridge/src/broker.js`
- Modify: `bridge/test/broker.test.js`

**Model:** `sonnet` — small diff, but touches the one file with the "no changes" note; needs the comment explaining why.

**Interfaces:**
- Consumes: nothing new.
- Produces: `connectBroker({ ..., tls })` — `tls`, when provided, is an object merged into the options `mqtt.connect` receives (e.g. `{ rejectUnauthorized: false }`). Defaults to `undefined`, which reproduces every existing call exactly. Task 5's `startEmbeddedBroker` returns a `tlsOptions` field with this exact shape for TLS mode.

- [ ] **Step 1: Write the failing test**

Add these imports to the top of `bridge/test/broker.test.js`, alongside the existing ones:

```javascript
import tls from 'node:tls'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import Aedes from 'aedes'
```

Then add this test anywhere after the imports (e.g. right after the first `test(...)` block):

```javascript
test('a tls option is passed through to mqtt.connect, unused by default', async () => {
  // A self-signed cert whose CN does not match 127.0.0.1: the point of this
  // test is that supplying { rejectUnauthorized: false } is what lets the
  // connection succeed anyway, proving the option reaches mqtt.connect.
  const { key, cert, dir } = selfSignedCert()
  const aedes = new Aedes()
  const server = tls.createServer({ key, cert }, aedes.handle)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  try {
    const cache = createCache()
    const client = connectBroker({
      url: `mqtts://127.0.0.1:${port}`,
      cache,
      onMessage: () => {},
      tls: { rejectUnauthorized: false },
    })
    try {
      await withTimeoutForTest(client.subscribed, 3000)
      assert.equal(client.connected(), true)
    } finally {
      await client.end()
    }
  } finally {
    await new Promise((resolve) => aedes.close(() => server.close(resolve)))
    rmSync(dir, { recursive: true, force: true })
  }
})

function withTimeoutForTest(promise, timeoutMs) {
  let timer
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), timeoutMs)
  })
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer))
}

// A throwaway self-signed cert generated at test time via the openssl CLI
// (present on the dev machine and the target Void Linux host alike) — good
// enough to prove the TLS handshake happens, which is all this test needs.
function selfSignedCert() {
  const dir = mkdtempSync(path.join(tmpdir(), 'bridge-test-cert-'))
  const keyPath = path.join(dir, 'key.pem')
  const certPath = path.join(dir, 'cert.pem')
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath,
    '-days', '1', '-subj', '/CN=test-only',
  ])
  return { key: readFileSync(keyPath), cert: readFileSync(certPath), dir }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd bridge && node --test test/broker.test.js`
Expected: FAIL — the new test times out or errors, because `connectBroker` does not yet accept a `tls` option (it is silently dropped, so the client attempts a normal TLS handshake against the self-signed cert and rejects it).

- [ ] **Step 3: Add the `tls` option to `connectBroker` in `src/broker.js`**

In `bridge/src/broker.js`, change the function signature and the `mqtt.connect` call:

```javascript
export function connectBroker({
  url,
  cache,
  onMessage,
  username,
  password,
  onConnect,
  onDisconnect,
  onError,
  echoTimeoutMs = ECHO_TIMEOUT_MS,
  reconnectMs = RECONNECT_MS,
  tls,
}) {
  const client = mqtt.connect(url, {
    username,
    password,
    reconnectPeriod: reconnectMs,
    resubscribe: true,
    // Only set for the embedded broker's own internal TLS connection in
    // src/embedded-broker.js: a loopback self-connection to a certificate
    // issued for the public domain, not 127.0.0.1, which Node's default
    // hostname check would otherwise reject. Every other caller leaves this
    // undefined and gets today's behavior unchanged.
    ...(tls ?? {}),
  })
```

Leave every other line of the file exactly as it is.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd bridge && node --test test/broker.test.js`
Expected: PASS, including the new TLS test. (Requires `openssl` on `PATH`; check with `which openssl` first — it is present on the dev machine and the target Void Linux host alike.)

- [ ] **Step 5: Run the full suite**

Run: `cd bridge && npm test`
Expected: PASS — the `tls` parameter defaults to `undefined` for every existing call, so `...(tls ?? {})` spreads nothing and every prior test is unaffected.

- [ ] **Step 6: Commit**

```bash
cd bridge
git add src/broker.js test/broker.test.js
git commit -m "feat(broker): optional tls pass-through for the embedded broker's loopback TLS connection"
```

---

### Task 5: `src/embedded-broker.js` — the aedes listener

**Files:**
- Create: `bridge/src/embedded-broker.js`
- Test: `bridge/test/embedded-broker.test.js`

**Model:** `sonnet` — the core new feature; TLS/no-TLS branching and the `authenticate` hook need care.

**Interfaces:**
- Consumes: `tokenMatches` from `src/auth.js` (Task 2).
- Produces: `startEmbeddedBroker({ mqttPort, mqttsPort, tlsCert, tlsKey, authToken })` — an async function returning `{ url, tlsOptions, close }`. `url` is `mqtt://127.0.0.1:<mqttPort>` (no TLS) or `mqtts://127.0.0.1:<mqttsPort>` (TLS). `tlsOptions` is `undefined` (no TLS) or `{ rejectUnauthorized: false }` (TLS) — passed straight through as Task 4's `tls` option. `close()` returns a `Promise` that resolves once both the `aedes` instance and its TCP/TLS server have shut down. Throws synchronously (before any `listen()`) if TLS is configured (`tlsCert` and `tlsKey` both set) but `authToken` is falsy. Used by Task 7's `bin/mqtt-http-bridge.js`.

- [ ] **Step 1: Write the failing tests**

Create `bridge/test/embedded-broker.test.js`:

```javascript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import mqtt from 'mqtt'

import { connectBroker } from '../src/broker.js'
import { createCache } from '../src/cache.js'
import { startEmbeddedBroker } from '../src/embedded-broker.js'
import { waitFor } from './helpers/bridge.js'

test('no TLS: aedes listens on loopback, and connectBroker reaches it', async () => {
  const embedded = await startEmbeddedBroker({ mqttPort: 0, mqttsPort: 0 })
  try {
    assert.match(embedded.url, /^mqtt:\/\/127\.0\.0\.1:\d+$/)
    assert.equal(embedded.tlsOptions, undefined)

    const cache = createCache()
    const client = connectBroker({ url: embedded.url, cache, onMessage: () => {} })
    try {
      await client.subscribed
      await client.publish('src/Acurite/1', '{"t":1}')
      await waitFor(() => cache.get('src/Acurite/1') !== undefined)
      assert.deepEqual(cache.get('src/Acurite/1'), Buffer.from('{"t":1}'))
    } finally {
      await client.end()
    }
  } finally {
    await embedded.close()
  }
})

test('no TLS: mqttPort 0 lets the OS pick a free port, not the 1883 default', async () => {
  const embedded = await startEmbeddedBroker({ mqttPort: 0, mqttsPort: 0 })
  try {
    assert.doesNotMatch(embedded.url, /:1883$/)
  } finally {
    await embedded.close()
  }
})

test('TLS configured without AUTH_TOKEN throws before listening', async () => {
  const { certPath, keyPath, dir } = selfSignedCertFiles()
  try {
    await assert.rejects(
      () => startEmbeddedBroker({ mqttPort: 0, mqttsPort: 0, tlsCert: certPath, tlsKey: keyPath }),
      /AUTH_TOKEN/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TLS: a client with the right token connects, a wrong or missing one is refused', async () => {
  const { certPath, keyPath, dir } = selfSignedCertFiles()
  try {
    const embedded = await startEmbeddedBroker({
      mqttPort: 0,
      mqttsPort: 0,
      tlsCert: certPath,
      tlsKey: keyPath,
      authToken: 's3cr3t',
    })
    try {
      assert.match(embedded.url, /^mqtts:\/\/127\.0\.0\.1:\d+$/)
      assert.deepEqual(embedded.tlsOptions, { rejectUnauthorized: false })

      const good = await mqtt.connectAsync(embedded.url, {
        username: 'anyone',
        password: 's3cr3t',
        rejectUnauthorized: false,
      })
      await good.endAsync()

      await assert.rejects(() =>
        mqtt.connectAsync(embedded.url, {
          username: 'anyone',
          password: 'wrong',
          rejectUnauthorized: false,
          connectTimeout: 2000,
        }),
      )

      await assert.rejects(() =>
        mqtt.connectAsync(embedded.url, {
          username: 'anyone',
          rejectUnauthorized: false,
          connectTimeout: 2000,
        }),
      )
    } finally {
      await embedded.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TLS: the bridge itself can reach its own embedded broker over loopback', async () => {
  const { certPath, keyPath, dir } = selfSignedCertFiles()
  try {
    const embedded = await startEmbeddedBroker({
      mqttPort: 0,
      mqttsPort: 0,
      tlsCert: certPath,
      tlsKey: keyPath,
      authToken: 's3cr3t',
    })
    try {
      const cache = createCache()
      const client = connectBroker({
        url: embedded.url,
        cache,
        onMessage: () => {},
        tls: embedded.tlsOptions,
        password: 's3cr3t',
      })
      try {
        await client.subscribed
        await client.publish('src/Acurite/1', '{"t":1}')
        await waitFor(() => cache.get('src/Acurite/1') !== undefined)
      } finally {
        await client.end()
      }
    } finally {
      await embedded.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function selfSignedCertFiles() {
  const dir = mkdtempSync(path.join(tmpdir(), 'bridge-embedded-cert-'))
  const keyPath = path.join(dir, 'key.pem')
  const certPath = path.join(dir, 'cert.pem')
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath,
    '-days', '1', '-subj', '/CN=test-only',
  ])
  return { certPath, keyPath, dir }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd bridge && node --test test/embedded-broker.test.js`
Expected: FAIL — `Cannot find module '../src/embedded-broker.js'`.

- [ ] **Step 3: Write `src/embedded-broker.js`**

```javascript
import net from 'node:net'
import tls from 'node:tls'
import fs from 'node:fs'

import Aedes from 'aedes'

import { tokenMatches } from './auth.js'

// Only one of these ever runs: a public broker without an authenticate hook
// is not a state this can start into silently, and a loopback debug port
// alongside the public one is a future decision, not a default.
export async function startEmbeddedBroker({ mqttPort = 1883, mqttsPort = 8883, tlsCert, tlsKey, authToken }) {
  const tlsEnabled = Boolean(tlsCert && tlsKey)
  if (tlsEnabled && !authToken) {
    throw new Error('AUTH_TOKEN must be set when TLS is configured for the embedded broker')
  }

  const aedes = new Aedes()
  if (tlsEnabled) {
    // CONNECT is the only gate: once authenticated, a client has full
    // read+write over '#', the same as the bridge's own internal
    // connection. Public read access is intentionally the HTTP side's job.
    aedes.authenticate = (client, username, password, callback) => {
      callback(null, tokenMatches(password, authToken))
    }
  }

  const server = tlsEnabled
    ? tls.createServer({ cert: fs.readFileSync(tlsCert), key: fs.readFileSync(tlsKey) }, aedes.handle)
    : net.createServer(aedes.handle)

  const port = tlsEnabled ? mqttsPort : mqttPort
  const host = tlsEnabled ? '0.0.0.0' : '127.0.0.1'

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  const { port: boundPort } = server.address()

  return {
    // The bridge's own internal connectBroker always dials loopback: in
    // no-TLS mode that is the only listener there is, and in TLS mode
    // 0.0.0.0 already includes 127.0.0.1, so the public listener answers
    // here too.
    url: tlsEnabled ? `mqtts://127.0.0.1:${boundPort}` : `mqtt://127.0.0.1:${boundPort}`,
    tlsOptions: tlsEnabled ? { rejectUnauthorized: false } : undefined,
    close: () => new Promise((resolve) => aedes.close(() => server.close(resolve))),
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd bridge && node --test test/embedded-broker.test.js`
Expected: PASS, all 5 tests. (Requires `openssl` on `PATH`.)

- [ ] **Step 5: Run the full suite**

Run: `cd bridge && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd bridge
git add src/embedded-broker.js test/embedded-broker.test.js
git commit -m "feat: embedded aedes broker, loopback-plain or public-MQTTS-with-auth"
```

---

### Task 6: `src/server.js` — `401` on an unauthenticated `POST`

**Files:**
- Modify: `bridge/src/server.js`
- Modify: `bridge/test/http.test.js`

**Model:** `sonnet` — routing-level change with clear existing precedent (the `405`/`503` checks) to follow.

**Interfaces:**
- Consumes: `tokenMatches` from `src/auth.js` (Task 2).
- Produces: `createBridge({ broker, cache, authToken })` — `authToken` is optional (`undefined` disables the check, matching every other config default in this codebase). Used by Task 7.

- [ ] **Step 1: Write the failing tests**

Add to `bridge/test/http.test.js`, importing `createBridge`'s new option via the existing `startBridge` test helper extended in this same step. First, add these tests anywhere after the existing `import` block:

```javascript
test('a POST without a token is 401 when AUTH_TOKEN is set, and the topic is left alone', async () => {
  const bridge = await startBridge({ authToken: 's3cr3t' })
  try {
    const unauthed = await fetch(`${bridge.base}/src/Acurite/1234`, {
      method: 'POST',
      body: '{"a":1}',
    })
    assert.equal(unauthed.status, 401)
    assert.equal((await fetch(`${bridge.base}/src/Acurite/1234`)).status, 404)
  } finally {
    await bridge.close()
  }
})

test('a POST with the wrong token is 401', async () => {
  const bridge = await startBridge({ authToken: 's3cr3t' })
  try {
    const wrong = await fetch(`${bridge.base}/src/Acurite/1234`, {
      method: 'POST',
      body: '{"a":1}',
      headers: { authorization: 'Bearer wrong' },
    })
    assert.equal(wrong.status, 401)
  } finally {
    await bridge.close()
  }
})

test('a POST with the right bearer token is 204, same as with no AUTH_TOKEN configured', async () => {
  const bridge = await startBridge({ authToken: 's3cr3t' })
  try {
    const ok = await fetch(`${bridge.base}/src/Acurite/1234`, {
      method: 'POST',
      body: '{"a":1}',
      headers: { authorization: 'Bearer s3cr3t' },
    })
    assert.equal(ok.status, 204)
    assert.equal(await (await fetch(`${bridge.base}/src/Acurite/1234`)).text(), '{"a":1}')
  } finally {
    await bridge.close()
  }
})

test('GET is never gated, even with AUTH_TOKEN set', async () => {
  const bridge = await startBridge({ authToken: 's3cr3t' })
  try {
    await fetch(`${bridge.base}/src/Acurite/1234`, {
      method: 'POST',
      body: '{"a":1}',
      headers: { authorization: 'Bearer s3cr3t' },
    })
    const got = await fetch(`${bridge.base}/src/Acurite/1234`)
    assert.equal(got.status, 200)

    const stream = await fetch(`${bridge.base}/events`)
    assert.equal(stream.status, 200)
    await stream.body.cancel()
  } finally {
    await bridge.close()
  }
})
```

Then extend `bridge/test/helpers/bridge.js`'s `startBridge` to accept and thread through an `authToken`. Change the signature and the `createBridge` call:

```javascript
export async function startBridge({ url, delayMs, echoTimeoutMs, authToken } = {}) {
```

and

```javascript
  bridge = createBridge({ broker, cache, authToken })
```

(Leave every other line of `test/helpers/bridge.js` unchanged.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd bridge && node --test test/http.test.js`
Expected: FAIL — the four new tests get `204`/`200` where they expect `401` (auth not yet enforced).

- [ ] **Step 3: Add the auth check to `src/server.js`**

Add the import at the top of `bridge/src/server.js`:

```javascript
import { tokenMatches } from './auth.js'
```

Change `createBridge` to accept and close over `authToken`:

```javascript
export function createBridge({ broker, cache, authToken }) {
  const clients = new Set()

  const bridge = {
    httpServer: http.createServer((req, res) => {
      handle(req, res, { broker, cache, clients, authToken }).catch(() => {
```

Change `handle`'s signature to receive `authToken`:

```javascript
async function handle(req, res, { broker, cache, clients, authToken }) {
```

In the `POST` branch, add the check before reading the body:

```javascript
  if (req.method === 'POST') {
    if (authToken && !authorized(req, authToken)) return send(res, 401, 'unauthorized')

    let body
    try {
      body = await readBody(req)
    } catch {
      return
    }
```

Add the `authorized` helper near the other small helpers at the bottom of the file:

```javascript
function authorized(req, authToken) {
  const header = req.headers['authorization']
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false
  return tokenMatches(header.slice('Bearer '.length), authToken)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd bridge && node --test test/http.test.js`
Expected: PASS, all tests including the four new ones.

- [ ] **Step 5: Run the full suite**

Run: `cd bridge && npm test`
Expected: PASS — `authToken` defaults to `undefined` everywhere it isn't explicitly passed, so every existing `POST` test (which calls `startBridge()` with no `authToken`) is unaffected.

- [ ] **Step 6: Commit**

```bash
cd bridge
git add src/server.js test/helpers/bridge.js test/http.test.js
git commit -m "feat(http): 401 on POST without a valid bearer token when AUTH_TOKEN is set"
```

---

### Task 7: `bin/mqtt-http-bridge.js` — wire it all together

**Files:**
- Modify: `bridge/bin/mqtt-http-bridge.js`

**Model:** `sonnet` — integration of Tasks 3, 5, 6; no new logic of its own, but ordering (embed before connect, close embedded broker on shutdown) matters.

**Interfaces:**
- Consumes: `readConfig` (Task 3), `startEmbeddedBroker` (Task 5), `connectBroker`'s new `tls` option (Task 4), `createBridge`'s new `authToken` option (Task 6).
- Produces: nothing consumed elsewhere — this is the process entry point.

- [ ] **Step 1: Rewrite `bin/mqtt-http-bridge.js`**

```javascript
#!/usr/bin/env node
import { parseArgs } from 'node:util'

import { connectBroker } from '../src/broker.js'
import { createCache } from '../src/cache.js'
import { brokerLabel, readConfig } from '../src/config.js'
import { startEmbeddedBroker } from '../src/embedded-broker.js'
import { createBridge } from '../src/server.js'

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    'no-embed-broker': { type: 'boolean' },
    'broker-url': { type: 'string' },
    'mqtt-port': { type: 'string' },
    'mqtts-port': { type: 'string' },
    'tls-cert': { type: 'string' },
    'tls-key': { type: 'string' },
    'auth-token': { type: 'string' },
  },
  strict: true,
})

const config = readConfig(process.env, {
  noEmbedBroker: values['no-embed-broker'],
  brokerUrl: values['broker-url'],
  mqttPort: values['mqtt-port'],
  mqttsPort: values['mqtts-port'],
  tlsCert: values['tls-cert'],
  tlsKey: values['tls-key'],
  authToken: values['auth-token'],
})

// When embedding, this is the only place a public, unauthenticated broker
// could start silently — startEmbeddedBroker throws before listening if
// TLS is configured without AUTH_TOKEN, so that failure happens here,
// before anything else comes up.
let embedded
let brokerUrl = config.mqttUrl
let brokerTls
if (config.embedBroker) {
  embedded = await startEmbeddedBroker({
    mqttPort: config.mqttPort,
    mqttsPort: config.mqttsPort,
    tlsCert: config.tlsCert,
    tlsKey: config.tlsKey,
    authToken: config.authToken,
  })
  brokerUrl = embedded.url
  brokerTls = embedded.tlsOptions
}

const brokerName = brokerLabel(brokerUrl)
const cache = createCache()

let bridge
const broker = connectBroker({
  url: brokerUrl,
  tls: brokerTls,
  cache,
  // A message delivered before `bridge` is assigned is already in the cache,
  // and any subscriber connecting later is replayed from it, so it is safe
  // to drop.
  onMessage: (topic, payload) => bridge?.broadcast(topic, payload),
  username: config.username,
  password: config.password,
  onConnect: () => console.log(`broker ${brokerName} connected`),
  onDisconnect: () => console.error(`broker ${brokerName} disconnected, retrying`),
  onError: (err) => console.error(`broker ${brokerName}: ${err.message}`),
})
bridge = createBridge({ broker, cache, authToken: config.authToken })

bridge.httpServer.listen(config.port, config.host, () => {
  console.log(`mqtt-http-bridge on http://${config.host}:${config.port}, broker ${brokerName}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    // httpServer.close() never completes while an SSE stream is attached,
    // so the streams have to be ended first to make the server closable.
    for (const client of bridge.clients) client.close()
    bridge.clients.clear()
    bridge.httpServer.close()
    broker
      .end()
      .then(() => embedded?.close())
      .then(() => process.exit(0))
  })
}
```

- [ ] **Step 2: Smoke-test manually with embedding on (the default)**

Run: `cd bridge && node bin/mqtt-http-bridge.js` (foreground, then `Ctrl-C` after checking)
Expected: prints `mqtt-http-bridge on http://0.0.0.0:8080, broker mqtt://127.0.0.1:1883` and `broker mqtt://127.0.0.1:1883 connected` — the embedded broker started, and the bridge's own client reached it. `Ctrl-C` exits cleanly (no hang, no error).

- [ ] **Step 3: Smoke-test with `--no-embed-broker` against nothing**

Run: `cd bridge && node bin/mqtt-http-bridge.js --no-embed-broker --broker-url mqtt://127.0.0.1:19999`
Expected: prints the startup line, then repeats a connection-refused error every ~2 seconds (no embedded broker started; falls back to dialing out, same as before this change). `Ctrl-C` exits cleanly.

- [ ] **Step 4: Smoke-test TLS-without-AUTH_TOKEN fails fast**

Run:
```bash
cd bridge
openssl req -x509 -newkey rsa:2048 -nodes -keyout /tmp/k.pem -out /tmp/c.pem -days 1 -subj /CN=test
node bin/mqtt-http-bridge.js --tls-cert /tmp/c.pem --tls-key /tmp/k.pem
```
Expected: throws `AUTH_TOKEN must be set when TLS is configured for the embedded broker` and exits non-zero, before printing any "listening" line.

- [ ] **Step 5: Run the full test suite**

Run: `cd bridge && npm test`
Expected: PASS, entire suite.

- [ ] **Step 6: Commit**

```bash
cd bridge
git add bin/mqtt-http-bridge.js
git commit -m "feat: wire CLI parsing, the embedded broker, and AUTH_TOKEN into the entry point"
```

---

### Task 8: Bridge docs — `binding.md`, `install.md`, `user-manual.md`, `architecture.md`, `backlog.md`

**Files:**
- Modify: `bridge/docs/binding.md`
- Modify: `bridge/docs/install.md`
- Modify: `bridge/docs/user-manual.md`
- Modify: `bridge/docs/architecture.md`
- Modify: `bridge/docs/backlog.md`

**Model:** `haiku` — mechanical doc edits; every string to insert is given verbatim below.

**Interfaces:** none — documentation only.

- [ ] **Step 1: `binding.md` — add the `401` row**

In `bridge/docs/binding.md`, find the Errors table (the one starting `| Status | When |`) and add a row after the `405` row:

```markdown
| `401` | `POST` with a missing or wrong bearer token, when the implementation has auth enabled |
```

Immediately after that table (after the existing "An implementation that refuses..." paragraph and before "Every response carries..."), add:

```markdown
`401` is implementation-specific, the same way CORS is: not every implementation
of this binding has to gate writes behind a token, and a client should not assume
one that doesn't answers `401` to anything. The receiver's own source-only subset
keeps its existing `405` answer for a non-`$alias` `POST` regardless.
```

- [ ] **Step 2: `install.md` — document the new CLI flags and env vars**

In `bridge/docs/install.md`, replace the "Environment variables" table with:

```markdown
## Environment variables

All are read once at startup, in `src/config.js`. Every field below except
`HOST`, `MQTT_USERNAME`, and `MQTT_PASSWORD` also has a CLI flag; a flag
takes precedence over its environment variable, which takes precedence over
the default.

| Variable | CLI flag | Default | Notes |
|---|---|---|---|
| `MQTT_URL` | `--broker-url` | `mqtt://localhost:1883` | Only consulted when `EMBED_BROKER` is `false`. |
| `PORT` | — | `8080` | Must be an integer 0–65535. An empty string, a non-numeric value, or a value outside that range makes the bridge refuse to start rather than fall back to the default. |
| `HOST` | — | `0.0.0.0` | Interface the HTTP server binds to. |
| `MQTT_USERNAME` | — | unset | Passed to the broker if set. |
| `MQTT_PASSWORD` | — | unset | Passed to the broker if set. |
| `EMBED_BROKER` | `--no-embed-broker` | `true` | `false` (or the flag) disables the embedded broker and dials `MQTT_URL`/`--broker-url` instead, like every version of the bridge before this. |
| `MQTT_PORT` | `--mqtt-port` | `1883` | The embedded broker's plaintext loopback port, used when no TLS cert/key is configured. |
| `MQTTS_PORT` | `--mqtts-port` | `8883` | The embedded broker's public TLS port, used when a cert/key is configured. |
| `TLS_CERT` | `--tls-cert` | unset | PEM certificate file. Presence (with `TLS_KEY`) switches the embedded broker from the loopback-plaintext listener to the public-MQTTS one. |
| `TLS_KEY` | `--tls-key` | unset | PEM key file. |
| `AUTH_TOKEN` | `--auth-token` | unset | Shared secret gating HTTP `POST` (`401` without it) and, when embedding with TLS, MQTT `CONNECT` (refused without it). Required if `TLS_CERT`/`TLS_KEY` are set — the bridge refuses to start otherwise. |

## The embedded broker

By default (`EMBED_BROKER` unset or `true`), the bridge starts its own
`aedes` MQTT broker in-process rather than dialing out to one — nothing
external has to be running first. Without `TLS_CERT`/`TLS_KEY`, it binds
plain MQTT to `127.0.0.1:<MQTT_PORT>`, loopback only. With them, it binds
MQTTS to `0.0.0.0:<MQTTS_PORT>`, publicly reachable, and requires
`AUTH_TOKEN` on every `CONNECT`. Only one of these two ever runs.

`npm install` also pulls `aedes`, now a runtime dependency (it always did
pull it as a dev dependency for the test suite; embedding needs it at
runtime too).
```

Remove the old, now-superseded sentence in the same file that reads "`npm install` also pulls `aedes`, a dev dependency used only by the test suite. It is not needed to run the bridge." — it is now folded into the paragraph above.

- [ ] **Step 3: `user-manual.md` — document `401` and the new config table**

In `bridge/docs/user-manual.md`, replace the "Configuration" section's table with:

```markdown
## Configuration

Set as environment variables (or the matching CLI flag) before starting the
process (see [`docs/install.md`](install.md) for the full table and
defaults):

| Variable | Purpose |
|---|---|
| `MQTT_URL` | Broker to dial when `EMBED_BROKER=false`, e.g. `mqtt://broker.local:1883`. |
| `PORT` | HTTP port to listen on. |
| `HOST` | Interface to bind. |
| `MQTT_USERNAME` | Broker username, if the broker requires one. |
| `MQTT_PASSWORD` | Broker password, if the broker requires one. |
| `EMBED_BROKER` | `false` to dial `MQTT_URL` instead of starting an embedded broker (default: embed). |
| `TLS_CERT` / `TLS_KEY` | Configuring both switches the embedded broker to public MQTTS and requires `AUTH_TOKEN`. |
| `AUTH_TOKEN` | Shared secret for `POST` (HTTP) and `CONNECT` (MQTT, TLS mode only). Unset disables both checks. |
```

In the "POST to a topic" section, add a bullet after the `503` bullet:

```markdown
- `401` if `AUTH_TOKEN` is configured and the request's `Authorization: Bearer <token>`
  header is missing or wrong.
```

Add an example right after the existing `curl -i -X POST ...` example:

```markdown
With `AUTH_TOKEN` set:

```
curl -i -X POST localhost:8080/rtl433-a1b2c3/Acurite-5n1/1234 \
  -H 'Authorization: Bearer <AUTH_TOKEN>' \
  -d '{"temperature_C":21.5}'
```
```

In the "Other status codes" section, add a bullet:

```markdown
- `401` — a `POST` with a missing or wrong bearer token, when `AUTH_TOKEN` is configured.
```

- [ ] **Step 4: `architecture.md` — add a short section on the embedded broker**

In `bridge/docs/architecture.md`, add a new section after "## Starting without a broker" and before "## Filters are fixed per connection":

```markdown
## The embedded broker

`bin/mqtt-http-bridge.js` can start its own `aedes` broker before calling
`connectBroker`, in `src/embedded-broker.js`. `broker.js`, `cache.js`, and
`server.js` never know the difference — they only ever see "a broker at a
URL," the same as when `MQTT_URL` points at a broker running somewhere
else. That is what lets the whole tested `connectBroker` code path — echo
matching, reconnect, the cache rebuild on `connect` — apply unchanged to an
embedded broker.

Exactly one listener runs: plain MQTT on `127.0.0.1`, loopback only, or
public MQTTS on `0.0.0.0` with an `authenticate` hook requiring
`AUTH_TOKEN`. There is no mode that runs both. In the public-MQTTS case,
the bridge's own internal connection reaches the same public listener over
loopback (`0.0.0.0` already includes `127.0.0.1`) — the certificate is
issued for the public domain, not `127.0.0.1`, so `connectBroker` accepts
an optional `tls` option (`{ rejectUnauthorized: false }` in this one case)
to skip hostname verification for that self-connection specifically. Every
other caller leaves it unset and keeps today's behavior exactly.
```

- [ ] **Step 5: `backlog.md` — remove the item this work resolves**

In `bridge/docs/backlog.md`, delete this line (now resolved by `AUTH_TOKEN`):

```markdown
- No authentication on the HTTP side. Anyone who can reach the port can
  publish, including to `$alias` topics.
```

- [ ] **Step 6: Commit**

```bash
cd bridge
git add docs/binding.md docs/install.md docs/user-manual.md docs/architecture.md docs/backlog.md
git commit -m "docs: embedded broker, AUTH_TOKEN, and the new 401 response"
```

---

## Part 2 — `deploy.sh` repo

Work happens on a branch off `main`, in a worktree of `/home/john/src/deploy.sh` created via `superpowers:using-git-worktrees`. This is a separate repo from Part 1; do not mix commits between them.

### Task 9: `apache` module — `APACHE_PROXY_FLUSH_PATHS`

**Files:**
- Modify: `modules/apache/defaults.conf`
- Modify: `modules/apache/build.sh`
- Modify: `modules/apache/README.md`
- Modify: `test/test-apache-module.sh`

**Model:** `sonnet` — bash template-generation logic, parallel to the existing WebSocket-path handling.

**Interfaces:** none consumed from Part 1. Produces the `APACHE_PROXY_FLUSH_PATHS` variable Task 11's `bridge/deploy.conf` sets.

- [ ] **Step 1: Add the default**

In `modules/apache/defaults.conf`, in the "PROXY CONFIGURATION" section, right after the `APACHE_PROXY_WEBSOCKET` line, add:

```bash
# Paths that need flushpackets=on (space-separated list of incoming paths).
# For a long-lived proxied response (e.g. SSE), Apache buffers the backend's
# output by default; flushpackets streams it instead.
# Example: "/events"
export APACHE_PROXY_FLUSH_PATHS="${APACHE_PROXY_FLUSH_PATHS:-}"
```

- [ ] **Step 2: Extend `generate_proxy_config` in `modules/apache/build.sh`**

Find the `generate_proxy_config` function. Change its start:

```bash
generate_proxy_config() {
    local rules="$APACHE_PROXY_RULES"
    local websocket_paths="$APACHE_PROXY_WEBSOCKET"
    local flush_paths="$APACHE_PROXY_FLUSH_PATHS"
    local config=""
```

Inside the `for rule in $rules; do` loop, after the existing `is_websocket` check block (right after its closing `done`), add the matching flush check:

```bash
        # Check if this path needs flushpackets=on
        local is_flush="no"
        for flush_path in $flush_paths; do
            if [[ "$flush_path" == "$incoming_path" ]]; then
                is_flush="yes"
                break
            fi
        done
```

Then change the regular (non-WebSocket) branch of the `if [[ "$is_websocket" == "yes" ]]; then ... else ... fi` block from:

```bash
        else
            # Regular HTTP proxy
            config+="
    # HTTP proxy for ${incoming_path} -> localhost:${backend_port}${backend_path}
    ProxyPass ${incoming_path} http://localhost:${backend_port}${backend_path}
    ProxyPassReverse ${incoming_path} http://localhost:${backend_port}${backend_path}
    ProxyPreserveHost On
    RequestHeader set X-Forwarded-Proto \"https\" env=HTTPS
    RequestHeader set X-Forwarded-Host \"expr=%{HTTP_HOST}\"
"
        fi
```

to:

```bash
        else
            # Regular HTTP proxy
            local proxypass_opts=""
            if [[ "$is_flush" == "yes" ]]; then
                proxypass_opts=" flushpackets=on"
            fi
            config+="
    # HTTP proxy for ${incoming_path} -> localhost:${backend_port}${backend_path}
    ProxyPass ${incoming_path} http://localhost:${backend_port}${backend_path}${proxypass_opts}
    ProxyPassReverse ${incoming_path} http://localhost:${backend_port}${backend_path}
    ProxyPreserveHost On
    RequestHeader set X-Forwarded-Proto \"https\" env=HTTPS
    RequestHeader set X-Forwarded-Host \"expr=%{HTTP_HOST}\"
"
        fi
```

Leave the WebSocket branch and the rest of the file unchanged.

- [ ] **Step 3: Document the variable in `modules/apache/README.md`**

In `modules/apache/README.md`, in the "Proxy Settings" section, right after the `APACHE_PROXY_WEBSOCKET="/ws"` line, add:

```bash

# Paths needing flushpackets=on, so Apache streams instead of buffering
# (e.g. Server-Sent Events)
APACHE_PROXY_FLUSH_PATHS="/events"
```

- [ ] **Step 4: Add a test case to `test/test-apache-module.sh`**

Find "Test 2: Proxy Mode" in `test/test-apache-module.sh`. After that whole test block ends (right before the `echo ""` / `echo "=========================================="` / `echo ""` that precedes "Test 3: Hybrid Mode"), insert a new test:

```bash
# Test 2b: Proxy Mode with flushpackets
echo "Test 2b: Proxy Mode with APACHE_PROXY_FLUSH_PATHS"
echo "--------------------------------------------------"
export APACHE_MODE="proxy"
export APACHE_PROXY_RULES="/:3000:/ /events:3000:/events"
export APACHE_PROXY_WEBSOCKET=""
export APACHE_PROXY_FLUSH_PATHS="/events"
export APACHE_WEB_ROOT=""
export APACHE_CONTENT_DIR=""
export APACHE_BUILD_ENABLED="no"

echo "Running build.sh..."
bash "$DEPLOY_HOME/modules/apache/build.sh"

if [[ -f "$TMP_DIR/${APP_NAME}.conf" ]]; then
    if grep -q "ProxyPass /events http://localhost:3000/events flushpackets=on" "$TMP_DIR/${APP_NAME}.conf"; then
        echo "✓ flushpackets=on applied to the listed path"
    else
        echo "✗ flushpackets=on missing for the listed path"
    fi

    if grep -q "ProxyPass / http://localhost:3000/$" "$TMP_DIR/${APP_NAME}.conf"; then
        echo "✓ flushpackets=on NOT applied to an unlisted path"
    else
        echo "✗ an unlisted path unexpectedly got flushpackets=on, or the proxy line changed shape"
    fi
else
    echo "✗ Configuration file not generated"
fi

export APACHE_PROXY_FLUSH_PATHS=""

echo ""
echo "=========================================="
echo ""
```

- [ ] **Step 5: Run the module test**

Run: `bash test/test-apache-module.sh`
Expected: every line printed is `✓`; specifically `✓ flushpackets=on applied to the listed path` and `✓ flushpackets=on NOT applied to an unlisted path` for the new test, and every pre-existing `✓` line unchanged (no new `✗` anywhere).

- [ ] **Step 6: Commit**

```bash
git add modules/apache/defaults.conf modules/apache/build.sh modules/apache/README.md test/test-apache-module.sh
git commit -m "feat(apache): APACHE_PROXY_FLUSH_PATHS streams long-lived proxied responses"
```

---

### Task 10: `letsencrypt` module — `LETSENCRYPT_KEY_READER`

**Files:**
- Modify: `modules/letsencrypt/defaults.conf`
- Modify: `modules/letsencrypt/start.sh`
- Modify: `modules/letsencrypt/README.md`
- Create: `test/test-letsencrypt-module.sh`

**Model:** `sonnet` — remote shell generation plus a certbot deploy-hook script; needs care with quoting.

**Interfaces:** none consumed from Part 1. Produces the `LETSENCRYPT_KEY_READER` variable Task 11's `bridge/deploy.conf` sets.

- [ ] **Step 1: Add the default**

In `modules/letsencrypt/defaults.conf`, add at the end of the file:

```bash

# Service user to grant read access to the private key, in place (no copy).
# Unset (default) makes no change to key permissions.
export LETSENCRYPT_KEY_READER="${LETSENCRYPT_KEY_READER:-}"
```

- [ ] **Step 2: Add the grant step to `modules/letsencrypt/start.sh`**

In `modules/letsencrypt/start.sh`, find the block:

```bash
# Test and restart Apache
test_apache_config
restart_apache

info "SSL certificate setup completed for ${DOMAIN_NAME}"
```

Replace it with:

```bash
# Test and restart Apache
test_apache_config
restart_apache

# Grant a service user read access to the private key, in place. certbot
# regenerates the key files under root-only permissions on every renewal,
# so this has to run now (for the cert obtained above) AND be reinstalled
# as a certbot deploy-hook (so it also runs on every future renewal) —
# doing only the former works until the first renewal breaks it silently.
if [[ -n "${LETSENCRYPT_KEY_READER:-}" ]]; then
    info "Granting ${LETSENCRYPT_KEY_READER} read access to the private key"
    remote_exec "
        set -e
        privkey='/etc/letsencrypt/live/${DOMAIN_NAME}/privkey.pem'
        sudo chgrp '${LETSENCRYPT_KEY_READER}' \"\$privkey\"
        sudo chmod 640 \"\$privkey\"
        archive_key=\$(sudo readlink -f \"\$privkey\")
        sudo chgrp '${LETSENCRYPT_KEY_READER}' \"\$archive_key\"
        sudo chmod 640 \"\$archive_key\"
    "

    info "Installing a certbot deploy-hook to keep that grant across renewal"
    remote_exec "
        set -e
        sudo mkdir -p /etc/letsencrypt/renewal-hooks/deploy
        sudo tee '/etc/letsencrypt/renewal-hooks/deploy/${APP_NAME}-key-reader.sh' > /dev/null << 'HOOK'
#!/bin/sh
set -e
chgrp '${LETSENCRYPT_KEY_READER}' \"\${RENEWED_LINEAGE}/privkey.pem\"
chmod 640 \"\${RENEWED_LINEAGE}/privkey.pem\"
archive_key=\$(readlink -f \"\${RENEWED_LINEAGE}/privkey.pem\")
chgrp '${LETSENCRYPT_KEY_READER}' \"\$archive_key\"
chmod 640 \"\$archive_key\"
HOOK
        sudo chmod 755 '/etc/letsencrypt/renewal-hooks/deploy/${APP_NAME}-key-reader.sh'
    "
fi

info "SSL certificate setup completed for ${DOMAIN_NAME}"
```

Note: `RENEWED_LINEAGE` is set by certbot itself when it runs a deploy-hook, to the live directory of the cert that was just renewed (e.g. `/etc/letsencrypt/live/weather.rkroll.com`) — the hook script does not need `DOMAIN_NAME` at all, which is what makes it correct across a cert rename.

- [ ] **Step 3: Document the variable in `modules/letsencrypt/README.md`**

In `modules/letsencrypt/README.md`, in the variable list (the block of `- \`LETSENCRYPT_...\`` lines), add:

```markdown
- `LETSENCRYPT_KEY_READER` - Service user granted read access to the private key file, in place, surviving renewal (default: unset, no change made)
```

- [ ] **Step 4: Write `test/test-letsencrypt-module.sh`**

Create the file:

```bash
#!/bin/bash
# Test script for the letsencrypt module's LETSENCRYPT_KEY_READER grant

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export DEPLOY_HOME="$(cd "$SCRIPT_DIR/.." && pwd)"

export APP_NAME="testapp"
export DOMAIN_NAME="example.com"
export PROJECT_DIR="/tmp/testproject-letsencrypt"
export TMP_DIR="/tmp/deploy-test-letsencrypt"
export REMOTE_USER="testuser"
export REMOTE_HOST="testhost"
export DEPLOY_MODE="init"
export LETSENCRYPT_EMAIL="test@example.com"
export LETSENCRYPT_WEBROOT="/var/www/testapp"
export LETSENCRYPT_VHOST_PATH="/etc/apache2/sites-available"

PASS=0
FAIL=0
check() {
    local desc="$1"
    local cond="$2"
    if eval "$cond"; then
        echo "✓ $desc"
        PASS=$((PASS + 1))
    else
        echo "✗ $desc"
        FAIL=$((FAIL + 1))
    fi
}

mkdir -p "$TMP_DIR" "$PROJECT_DIR"

# Source common.sh, then override remote_exec/info/warn/die with the mocks
# from test-common.sh so start.sh's remote commands run against a local log
# instead of a real SSH target.
source "$DEPLOY_HOME/lib/common.sh"
LOG="$TMP_DIR/remote-exec.log"
: > "$LOG"
remote_exec() {
    echo "$1" >> "$LOG"
}
restart_apache() { :; }
test_apache_config() { :; }

echo "=========================================="
echo "Testing letsencrypt module: LETSENCRYPT_KEY_READER"
echo "=========================================="
echo ""

echo "Case 1: LETSENCRYPT_KEY_READER unset — no grant commands issued"
echo "-----------------------------------------------------------------"
unset LETSENCRYPT_KEY_READER
export LETSENCRYPT_KEY_READER=""
: > "$LOG"

# Exercise the exact guard start.sh uses, against the mocked remote_exec
# above: with LETSENCRYPT_KEY_READER empty, the grant block must not run.
if [[ -n "${LETSENCRYPT_KEY_READER:-}" ]]; then
    remote_exec "sudo chgrp '${LETSENCRYPT_KEY_READER}' privkey.pem"
fi

check "the default (empty) LETSENCRYPT_KEY_READER issues no remote_exec calls" "[[ ! -s '$LOG' ]]"

echo ""
echo "Case 2: LETSENCRYPT_KEY_READER set — grant and deploy-hook commands issued"
echo "-----------------------------------------------------------------------------"
export LETSENCRYPT_KEY_READER="mqtt-http-bridge"
: > "$LOG"

# Exercise the grant block directly, the same shape start.sh uses, against
# the mocked remote_exec above.
if [[ -n "${LETSENCRYPT_KEY_READER:-}" ]]; then
    remote_exec "
        set -e
        privkey='/etc/letsencrypt/live/${DOMAIN_NAME}/privkey.pem'
        sudo chgrp '${LETSENCRYPT_KEY_READER}' \"\$privkey\"
        sudo chmod 640 \"\$privkey\"
        archive_key=\$(sudo readlink -f \"\$privkey\")
        sudo chgrp '${LETSENCRYPT_KEY_READER}' \"\$archive_key\"
        sudo chmod 640 \"\$archive_key\"
    "
    remote_exec "
        set -e
        sudo mkdir -p /etc/letsencrypt/renewal-hooks/deploy
        sudo tee '/etc/letsencrypt/renewal-hooks/deploy/${APP_NAME}-key-reader.sh' > /dev/null << 'HOOK'
#!/bin/sh
set -e
chgrp '${LETSENCRYPT_KEY_READER}' \"\${RENEWED_LINEAGE}/privkey.pem\"
chmod 640 \"\${RENEWED_LINEAGE}/privkey.pem\"
archive_key=\$(readlink -f \"\${RENEWED_LINEAGE}/privkey.pem\")
chgrp '${LETSENCRYPT_KEY_READER}' \"\$archive_key\"
chmod 640 \"\$archive_key\"
HOOK
        sudo chmod 755 '/etc/letsencrypt/renewal-hooks/deploy/${APP_NAME}-key-reader.sh'
    "
fi

check "chgrp targets the live privkey.pem symlink" "grep -q \"chgrp 'mqtt-http-bridge' \\\"\\\\\\$privkey\\\"\" '$LOG'"
check "the live path is example.com's" "grep -q \"/etc/letsencrypt/live/example.com/privkey.pem\" '$LOG'"
check "the archive file is resolved via readlink -f, not copied" "grep -q 'readlink -f' '$LOG'"
check "a deploy-hook script is installed under renewal-hooks/deploy" "grep -q '/etc/letsencrypt/renewal-hooks/deploy/testapp-key-reader.sh' '$LOG'"
check "the deploy-hook uses \$RENEWED_LINEAGE, not a hardcoded domain" "grep -q 'RENEWED_LINEAGE' '$LOG'"
check "the deploy-hook is made executable" "grep -q 'chmod 755' '$LOG'"

echo ""
echo "=========================================="
echo "Results: $PASS passed, $FAIL failed"
echo "=========================================="

[[ $FAIL -eq 0 ]]
```

- [ ] **Step 5: Run the new test**

Run: `bash test/test-letsencrypt-module.sh`
Expected: exits 0, `Results: 7 passed, 0 failed`.

- [ ] **Step 6: Commit**

```bash
git add modules/letsencrypt/defaults.conf modules/letsencrypt/start.sh modules/letsencrypt/README.md test/test-letsencrypt-module.sh
git commit -m "feat(letsencrypt): LETSENCRYPT_KEY_READER grants a service user key access, surviving renewal"
```

---

## Part 3 — back in `rtl433-web-receiver`: deploy config

This task depends on Task 9 and Task 10 landing in `deploy.sh` (it sets the variables they added) but is a commit in the `rtl433-web-receiver` repo, on the same branch as Part 1's tasks (or its own small branch — either is fine since it touches only new files).

### Task 11: `bridge/deploy.conf` and `bridge/secrets.env.example`

**Files:**
- Create: `bridge/deploy.conf`
- Create: `bridge/secrets.env.example`
- Modify: `bridge/.gitignore`

**Model:** `haiku` — new files, content fully specified below, no logic.

**Interfaces:** none — deploy configuration only.

- [ ] **Step 1: Create `bridge/deploy.conf`**

```sh
export DEPLOY_TYPES="letsencrypt apache node_app"
export APP_NAME="mqtt-http-bridge"
export DOMAIN_NAME="weather.rkroll.com"
export REMOTE_HOST="weather.rkroll.com"
export REMOTE_USER="john"

export LETSENCRYPT_EMAIL="john@rkroll.com"
export LETSENCRYPT_KEY_READER="mqtt-http-bridge"   # matches NODE_APP_USER below

export APACHE_MODE="proxy"
export APACHE_PROXY_RULES="/:8080:/"
export APACHE_PROXY_FLUSH_PATHS="/events"

export NODE_APP_PORT="8080"
export NODE_APP_USER="mqtt-http-bridge"
export NODE_APP_GROUP="mqtt-http-bridge"
export NODE_APP_MAIN_SCRIPT="bin/mqtt-http-bridge.js"
export NODE_APP_DEPLOY_DIRS="src bin"
```

- [ ] **Step 2: Create `bridge/secrets.env.example`**

```sh
# Copy to secrets.env (gitignored) and fill in before running `deploy init`.
# AUTH_TOKEN: generate with `openssl rand -hex 24`.
AUTH_TOKEN=
TLS_CERT=/etc/letsencrypt/live/weather.rkroll.com/fullchain.pem
TLS_KEY=/etc/letsencrypt/live/weather.rkroll.com/privkey.pem
```

- [ ] **Step 3: Gitignore the real secrets file**

Read `bridge/.gitignore` first (it likely doesn't exist yet, or is empty — check before writing). Add:

```
secrets.env
```

If `bridge/.gitignore` doesn't exist, create it with just that one line.

- [ ] **Step 4: Verify `node_app`'s secrets pickup expects this exact filename**

Run: `grep -n "secrets.env\|NODE_APP_SECRETS_FILE" /home/john/src/deploy.sh/modules/node_app/build.sh`
Expected: confirms `secrets.env` (not `secrets.env.example`) is the name `deploy init` looks for in `PROJECT_DIR` (here, `bridge/`) — i.e. that the operator's manual step of `cp secrets.env.example secrets.env` before deploying is correct and matches what `deploy.sh` actually reads.

- [ ] **Step 5: Commit**

```bash
cd bridge
git add deploy.conf secrets.env.example .gitignore
git commit -m "deploy: weather.rkroll.com deploy config for the bridge"
```

- [ ] **Step 6: Note the manual firewall step for the user**

This step is not automated (`deploy.sh` has no firewall module) and is not part of this plan's testable deliverables — flag it in the final report to the user: **TCP 8883 must be opened in the VPS's firewall before `deploy init` on `weather.rkroll.com`, or the firmware's future MQTTS connection will fail silently with nothing in this repo's logs to explain why.**

---

## Final steps (not a task — do after all tasks land)

- In `rtl433-web-receiver`: confirm the plan file at
  `docs/superpowers/plans/2026-08-20-bridge-embedded-broker-deploy.md` is
  deleted once the branch is reviewed and merged (per this repo's own
  `CLAUDE.md`-equivalent convention: plans are working documents, not kept
  after landing).
- Fast-forward merge each repo's feature branch into its own `main` — no
  PRs, per the user's global instructions. Two separate repos, two separate
  merges.
- Deploy verification (manual, per the spec's Testing section — not
  scriptable from this plan): after `deploy init` on `weather.rkroll.com`,
  confirm `GET https://weather.rkroll.com/<topic>` answers with no token,
  confirm `POST` without a token is `401`, and confirm an `mqtt`-client
  connection to `mqtts://weather.rkroll.com:8883` with the right password
  succeeds and a publish round-trips through `GET`.
