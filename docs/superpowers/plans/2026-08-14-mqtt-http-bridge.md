# mqtt-http-bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An HTTP service that exposes an MQTT broker through three operations — GET a topic's last message, POST to publish, and GET `/events` to subscribe over SSE — as specified in `docs/binding.md`.

**Architecture:** One long-lived MQTT connection subscribed to `#` feeds an in-memory map of the last message per topic. HTTP GET reads that map, POST publishes retained through the same connection, and `/events` writes SSE frames to a set of registered clients, sending matching cached messages on connect and live ones after. Pure topic-matching logic is its own module with no I/O.

**Tech Stack:** Node 22, ES modules, `mqtt` v5 for the broker client, `node:http` for the server, `node:test` for tests, `aedes` as an in-process broker in the test suite. No web framework.

## Global Constraints

- Node 22 or later. ES modules throughout (`"type": "module"`), `.js` extensions in every relative import.
- Runtime dependencies: `mqtt` only. Dev dependencies: `aedes` only. Do not add a web framework, a test framework, or a logging library.
- The protocol is `docs/binding.md`. Where this plan and that document disagree, the document wins and the disagreement is a bug in this plan — raise it rather than silently choosing.
- A topic is `<source>/<model>/<id>`; a reading is that plus `/<field>`; an alias topic ends in `$alias`. The bridge never parses or validates topic *shape* beyond MQTT's own rules — those segment counts are a naming convention its clients follow, not something it enforces.
- Payloads pass through byte for byte. The bridge does not normalise, reorder, or strip fields.
- Status codes: `400` malformed topic, filter, or body; `404` GET of a topic with no message; `405` an operation not offered; `503` broker unavailable.
- Every publish is retained, QoS 0.
- Comments are for why, not what, and most code needs none. Documentation changes land in the same commit as the code.
- No `console.log` outside `bin/`.

---

### Task 1: Repo scaffold and topic matching

The only module with real logic and no I/O. Everything else depends on it.

**Files:**
- Create: `/home/john/src/mqtt-http-bridge/package.json`
- Create: `/home/john/src/mqtt-http-bridge/.gitignore`
- Create: `/home/john/src/mqtt-http-bridge/src/topic.js`
- Test: `/home/john/src/mqtt-http-bridge/test/topic.test.js`

**Model:** `sonnet` — small, but it sets the module conventions every later task copies.

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `validTopic(topic: string): boolean`
  - `validFilter(filter: string): boolean`
  - `matchFilter(filter: string, topic: string): boolean`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "mqtt-http-bridge",
  "version": "0.1.0",
  "description": "HTTP binding for an MQTT broker: GET a retained message, POST to publish, SSE to subscribe",
  "type": "module",
  "engines": { "node": ">=22" },
  "bin": { "mqtt-http-bridge": "bin/mqtt-http-bridge.js" },
  "scripts": {
    "test": "node --test test/"
  },
  "dependencies": {
    "mqtt": "^5.10.1"
  },
  "devDependencies": {
    "aedes": "^0.51.3"
  },
  "license": "MIT"
}
```

- [ ] **Step 2: Create `.gitignore`**

```
node_modules/
*.log
```

- [ ] **Step 3: Install dependencies**

Run: `cd /home/john/src/mqtt-http-bridge && npm install`
Expected: `node_modules/` created, `package-lock.json` written, no errors.

- [ ] **Step 4: Write the failing test**

Create `test/topic.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { matchFilter, validFilter, validTopic } from '../src/topic.js'

test('a literal filter matches only its own topic', () => {
  assert.equal(matchFilter('a/b/c', 'a/b/c'), true)
  assert.equal(matchFilter('a/b/c', 'a/b/d'), false)
  assert.equal(matchFilter('a/b/c', 'a/b'), false)
  assert.equal(matchFilter('a/b/c', 'a/b/c/d'), false)
})

test('+ matches exactly one segment', () => {
  assert.equal(matchFilter('a/+/c', 'a/b/c'), true)
  assert.equal(matchFilter('a/+/c', 'a//c'), true)
  assert.equal(matchFilter('a/+/c', 'a/b/d/c'), false)
  assert.equal(matchFilter('a/+', 'a'), false)
})

test('# matches the remainder including nothing', () => {
  assert.equal(matchFilter('a/#', 'a/b/c'), true)
  assert.equal(matchFilter('a/#', 'a'), true)
  assert.equal(matchFilter('#', 'a/b/c'), true)
  assert.equal(matchFilter('a/#', 'b/c'), false)
})

test('a device filter excludes alias topics below it', () => {
  const filter = 'rtl433-a1b2c3/+/+'
  assert.equal(matchFilter(filter, 'rtl433-a1b2c3/Acurite-5n1/1234'), true)
  assert.equal(matchFilter(filter, 'rtl433-a1b2c3/Acurite-5n1/1234/$alias'), false)
  assert.equal(matchFilter('rtl433-a1b2c3/#', 'rtl433-a1b2c3/Acurite-5n1/1234/$alias'), true)
})

test('a topic may not be empty or carry a wildcard', () => {
  assert.equal(validTopic('a/b/c'), true)
  assert.equal(validTopic('a/b/c/$alias'), true)
  assert.equal(validTopic(''), false)
  assert.equal(validTopic('a/+/c'), false)
  assert.equal(validTopic('a/#'), false)
  assert.equal(validTopic('a/ /c'), false)
})

test('a filter takes wildcards only as whole segments, # only last', () => {
  assert.equal(validFilter('a/+/c'), true)
  assert.equal(validFilter('#'), true)
  assert.equal(validFilter('a/#'), true)
  assert.equal(validFilter(''), false)
  assert.equal(validFilter('a/#/c'), false)
  assert.equal(validFilter('a/b+/c'), false)
  assert.equal(validFilter('a/#b'), false)
})
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `cd /home/john/src/mqtt-http-bridge && npm test`
Expected: FAIL, `Cannot find module '.../src/topic.js'`.

- [ ] **Step 6: Write the implementation**

Create `src/topic.js`:

```js
export function validTopic(topic) {
  if (typeof topic !== 'string' || topic.length === 0) return false
  return !topic.includes('+') && !topic.includes('#') && !topic.includes(' ')
}

export function validFilter(filter) {
  if (typeof filter !== 'string' || filter.length === 0) return false
  if (filter.includes(' ')) return false
  const segments = filter.split('/')
  return segments.every((segment, i) => {
    if (segment === '#') return i === segments.length - 1
    if (segment === '+') return true
    return !segment.includes('#') && !segment.includes('+')
  })
}

export function matchFilter(filter, topic) {
  const f = filter.split('/')
  const t = topic.split('/')
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true
    if (i >= t.length) return false
    if (f[i] !== '+' && f[i] !== t[i]) return false
  }
  return f.length === t.length
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd /home/john/src/mqtt-http-bridge && npm test`
Expected: PASS, 6 tests.

- [ ] **Step 8: Commit**

```bash
cd /home/john/src/mqtt-http-bridge
git add package.json package-lock.json .gitignore src/topic.js test/topic.test.js docs/binding.md docs/superpowers
git commit -m "Match MQTT topic filters

The one module with logic and no I/O: validation for topics and filters,
and + / # matching. Everything else is built on it."
```

---

### Task 2: The last-message cache

**Files:**
- Create: `/home/john/src/mqtt-http-bridge/src/cache.js`
- Test: `/home/john/src/mqtt-http-bridge/test/cache.test.js`

**Model:** `haiku` — the complete code is below; this is transcription and a test run.

**Interfaces:**
- Consumes: `matchFilter` from `src/topic.js`.
- Produces: `createCache(): { set(topic, payload), get(topic), match(filter), size() }` where
  `get` returns the payload string or `undefined`, and `match` returns an array of
  `[topic, payload]` pairs.

- [ ] **Step 1: Write the failing test**

Create `test/cache.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createCache } from '../src/cache.js'

test('a topic never set has no message', () => {
  const cache = createCache()
  assert.equal(cache.get('a/b/c'), undefined)
  assert.equal(cache.size(), 0)
})

test('set replaces rather than accumulates', () => {
  const cache = createCache()
  cache.set('a/b/c', '{"t":1}')
  cache.set('a/b/c', '{"t":2}')
  assert.equal(cache.get('a/b/c'), '{"t":2}')
  assert.equal(cache.size(), 1)
})

test('match returns every pair the filter selects', () => {
  const cache = createCache()
  cache.set('src/Acurite/1/temperature_C', '21.4')
  cache.set('src/Acurite/2/temperature_C', '19.0')
  cache.set('src/Other/1/humidity', '48')
  const matched = cache.match('src/Acurite/+/temperature_C')
  assert.deepEqual(matched.sort(), [
    ['src/Acurite/1/temperature_C', '21.4'],
    ['src/Acurite/2/temperature_C', '19.0'],
  ].sort())
})

test('a filter matching nothing returns an empty list', () => {
  const cache = createCache()
  cache.set('a/b/c', '1')
  assert.deepEqual(cache.match('x/#'), [])
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/john/src/mqtt-http-bridge && npm test`
Expected: FAIL, `Cannot find module '.../src/cache.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/cache.js`:

```js
import { matchFilter } from './topic.js'

export function createCache() {
  const messages = new Map()

  return {
    set(topic, payload) {
      messages.set(topic, payload)
    },
    get(topic) {
      return messages.get(topic)
    },
    match(filter) {
      const found = []
      for (const [topic, payload] of messages) {
        if (matchFilter(filter, topic)) found.push([topic, payload])
      }
      return found
    },
    size() {
      return messages.size
    },
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /home/john/src/mqtt-http-bridge && npm test`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
cd /home/john/src/mqtt-http-bridge
git add src/cache.js test/cache.test.js
git commit -m "Hold the last message for every topic

GET reads this and a new subscriber is replayed from it, so both answer
without a round trip to the broker."
```

---

### Task 3: The broker connection

**Files:**
- Create: `/home/john/src/mqtt-http-bridge/src/broker.js`
- Create: `/home/john/src/mqtt-http-bridge/test/helpers/broker.js`
- Test: `/home/john/src/mqtt-http-bridge/test/broker.test.js`

**Model:** `sonnet` — async connection lifecycle and a test harness that has to shut down cleanly.

**Interfaces:**
- Consumes: `createCache` from `src/cache.js`.
- Produces:
  - `connectBroker({ url, cache, onMessage, username, password }): Promise<Broker>` resolving once
    subscribed to `#`.
  - `Broker` is `{ publish(topic, payload): Promise<void>, connected(): boolean, end(): Promise<void> }`.
  - Test helper `startBroker(): Promise<{ url, close(): Promise<void> }>`.

- [ ] **Step 1: Write the test helper**

Create `test/helpers/broker.js`:

```js
import { createServer } from 'node:net'

import Aedes from 'aedes'

export async function startBroker() {
  const aedes = new Aedes()
  const server = createServer(aedes.handle)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  return {
    url: `mqtt://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => aedes.close(resolve))
      }),
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `test/broker.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { connectBroker } from '../src/broker.js'
import { createCache } from '../src/cache.js'
import { startBroker } from './helpers/broker.js'

test('a published message reaches the cache and the callback', async () => {
  const broker = await startBroker()
  const cache = createCache()
  const seen = []
  const client = await connectBroker({
    url: broker.url,
    cache,
    onMessage: (topic, payload) => seen.push([topic, payload]),
  })

  await client.publish('src/Acurite/1', '{"temperature_C":21.4}')
  await waitFor(() => cache.get('src/Acurite/1') !== undefined)

  assert.equal(cache.get('src/Acurite/1'), '{"temperature_C":21.4}')
  assert.deepEqual(seen, [['src/Acurite/1', '{"temperature_C":21.4}']])
  assert.equal(client.connected(), true)

  await client.end()
  await broker.close()
})

test('a publish is retained, so a later connection is replayed it', async () => {
  const broker = await startBroker()
  const first = await connectBroker({ url: broker.url, cache: createCache(), onMessage: () => {} })
  await first.publish('src/Acurite/1', '{"temperature_C":21.4}')
  await first.end()

  const cache = createCache()
  const second = await connectBroker({ url: broker.url, cache, onMessage: () => {} })
  await waitFor(() => cache.get('src/Acurite/1') !== undefined)
  assert.equal(cache.get('src/Acurite/1'), '{"temperature_C":21.4}')

  await second.end()
  await broker.close()
})

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for condition')
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd /home/john/src/mqtt-http-bridge && npm test`
Expected: FAIL, `Cannot find module '.../src/broker.js'`.

- [ ] **Step 4: Write the implementation**

Create `src/broker.js`:

```js
import mqtt from 'mqtt'

export async function connectBroker({ url, cache, onMessage, username, password }) {
  const client = await mqtt.connectAsync(url, {
    username,
    password,
    reconnectPeriod: 2000,
    resubscribe: true,
  })

  client.on('message', (topic, payload) => {
    const text = payload.toString('utf8')
    cache.set(topic, text)
    onMessage(topic, text)
  })

  await client.subscribeAsync('#', { qos: 0 })

  return {
    publish: (topic, payload) => client.publishAsync(topic, payload, { qos: 0, retain: true }),
    connected: () => client.connected,
    end: () => client.endAsync(),
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd /home/john/src/mqtt-http-bridge && npm test`
Expected: PASS, 12 tests.

- [ ] **Step 6: Commit**

```bash
cd /home/john/src/mqtt-http-bridge
git add src/broker.js test/broker.test.js test/helpers/broker.js
git commit -m "Connect to the broker and mirror every topic

One subscription to # keeps the cache current, which is what lets GET
answer without a round trip. Publishes are retained so another bridge
sees them the same way."
```

---

### Task 4: GET and POST over HTTP

**Files:**
- Create: `/home/john/src/mqtt-http-bridge/src/server.js`
- Create: `/home/john/src/mqtt-http-bridge/test/helpers/bridge.js`
- Test: `/home/john/src/mqtt-http-bridge/test/http.test.js`

**Model:** `sonnet` — routing, four status codes, and wiring three modules together.

**Interfaces:**
- Consumes: `createCache`, `connectBroker`, `validTopic`.
- Produces:
  - `createBridge({ broker, cache }): { httpServer, broadcast(topic, payload) }`. `broadcast` is a
    no-op stub in this task and gets its body in Task 5.
  - Test helper `startBridge(): Promise<{ base, broker, close() }>` where `base` is the bridge's
    HTTP origin and `broker` is the connected client.

- [ ] **Step 1: Write the test helper**

Create `test/helpers/bridge.js`:

```js
import { connectBroker } from '../../src/broker.js'
import { createCache } from '../../src/cache.js'
import { createBridge } from '../../src/server.js'
import { startBroker } from './broker.js'

export async function startBridge() {
  const mqttBroker = await startBroker()
  const cache = createCache()
  let bridge
  const broker = await connectBroker({
    url: mqttBroker.url,
    cache,
    onMessage: (topic, payload) => bridge.broadcast(topic, payload),
  })
  bridge = createBridge({ broker, cache })

  await new Promise((resolve) => bridge.httpServer.listen(0, '127.0.0.1', resolve))
  const { port } = bridge.httpServer.address()

  let brokerStopped = false
  const stopBroker = async () => {
    if (brokerStopped) return
    brokerStopped = true
    await mqttBroker.close()
  }

  return {
    base: `http://127.0.0.1:${port}`,
    broker,
    cache,
    stopBroker,
    close: async () => {
      for (const client of bridge.clients) client.close()
      bridge.clients.clear()
      await new Promise((resolve) => bridge.httpServer.close(resolve))
      await broker.end()
      await stopBroker()
    },
  }
}

export async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for condition')
}
```

- [ ] **Step 2: Write the failing test**

Create `test/http.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { startBridge, waitFor } from './helpers/bridge.js'

test('a topic with no message is 404, and a POST makes it readable byte for byte', async () => {
  const bridge = await startBridge()
  const body = '{"temperature_C":21.4,"humidity":48}'

  const missing = await fetch(`${bridge.base}/src/Acurite/1234`)
  assert.equal(missing.status, 404)

  const posted = await fetch(`${bridge.base}/src/Acurite/1234`, { method: 'POST', body })
  assert.equal(posted.status, 204)

  await waitFor(async () => (await fetch(`${bridge.base}/src/Acurite/1234`)).status === 200)
  const got = await fetch(`${bridge.base}/src/Acurite/1234`)
  assert.equal(got.headers.get('content-type'), 'application/json')
  assert.equal(await got.text(), body)

  await bridge.close()
})

test('a non-JSON body is 400 and leaves the retained message alone', async () => {
  const bridge = await startBridge()
  await fetch(`${bridge.base}/src/Acurite/1234`, { method: 'POST', body: '{"a":1}' })
  await waitFor(async () => (await fetch(`${bridge.base}/src/Acurite/1234`)).status === 200)

  const bad = await fetch(`${bridge.base}/src/Acurite/1234`, { method: 'POST', body: 'not json' })
  assert.equal(bad.status, 400)

  const got = await fetch(`${bridge.base}/src/Acurite/1234`)
  assert.equal(await got.text(), '{"a":1}')

  await bridge.close()
})

test('a wildcard in a topic is 400 and an unsupported method is 405', async () => {
  const bridge = await startBridge()

  assert.equal((await fetch(`${bridge.base}/src/+/1234`)).status, 400)
  assert.equal((await fetch(`${bridge.base}/`)).status, 400)
  assert.equal((await fetch(`${bridge.base}/src/Acurite/1234`, { method: 'DELETE' })).status, 405)

  await bridge.close()
})

test('an alias round-trips, and a device without one has no alias topic', async () => {
  const bridge = await startBridge()

  const unnamed = await fetch(`${bridge.base}/src/Acurite/1234/$alias`)
  assert.equal(unnamed.status, 404)

  await fetch(`${bridge.base}/src/Acurite/1234/$alias`, { method: 'POST', body: '"Back fence"' })
  await waitFor(async () => (await fetch(`${bridge.base}/src/Acurite/1234/$alias`)).status === 200)

  const got = await fetch(`${bridge.base}/src/Acurite/1234/$alias`)
  assert.equal(await got.text(), '"Back fence"')

  await bridge.close()
})

test('every request is 503 once the broker is gone', async () => {
  const bridge = await startBridge()
  await fetch(`${bridge.base}/src/Acurite/1234`, { method: 'POST', body: '{"a":1}' })
  await waitFor(async () => (await fetch(`${bridge.base}/src/Acurite/1234`)).status === 200)

  await bridge.stopBroker()
  await waitFor(async () => (await fetch(`${bridge.base}/src/Acurite/1234`)).status === 503)

  assert.equal((await fetch(`${bridge.base}/events`)).status, 503)

  await bridge.close()
})
```

`stopBroker` closes the MQTT broker while leaving the HTTP server up, which is the only
way to reach the `503` branch. Add it to the helper in the next step.

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd /home/john/src/mqtt-http-bridge && npm test`
Expected: FAIL, `Cannot find module '.../src/server.js'`.

- [ ] **Step 4: Write the implementation**

Create `src/server.js`:

```js
import http from 'node:http'

import { validTopic } from './topic.js'

export function createBridge({ broker, cache }) {
  const bridge = {
    httpServer: http.createServer((req, res) => handle(req, res, { broker, cache })),
    clients: new Set(),
    broadcast() {},
  }
  return bridge
}

async function handle(req, res, { broker, cache }) {
  const url = new URL(req.url, 'http://bridge.invalid')
  const topic = decodeURIComponent(url.pathname.slice(1))

  if (!broker.connected()) return send(res, 503, 'broker unavailable')
  if (!validTopic(topic)) return send(res, 400, 'malformed topic')

  if (req.method === 'GET') {
    const payload = cache.get(topic)
    if (payload === undefined) return send(res, 404, 'no message')
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(payload)
  }

  if (req.method === 'POST') {
    const body = await readBody(req)
    try {
      JSON.parse(body)
    } catch {
      return send(res, 400, 'body is not JSON')
    }
    await broker.publish(topic, body)
    res.writeHead(204)
    return res.end()
  }

  return send(res, 405, 'method not allowed')
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

function send(res, status, message) {
  res.writeHead(status, { 'content-type': 'text/plain' })
  res.end(`${message}\n`)
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd /home/john/src/mqtt-http-bridge && npm test`
Expected: PASS, 18 tests.

- [ ] **Step 6: Commit**

```bash
cd /home/john/src/mqtt-http-bridge
git add src/server.js test/http.test.js test/helpers/bridge.js
git commit -m "Serve GET and POST for a topic

The body is checked as JSON before it is published, so a malformed one
cannot replace a good retained message."
```

---

### Task 5: Subscribe over SSE

**Files:**
- Modify: `/home/john/src/mqtt-http-bridge/src/server.js`
- Create: `/home/john/src/mqtt-http-bridge/src/sse.js`
- Test: `/home/john/src/mqtt-http-bridge/test/events.test.js`

**Model:** `sonnet` — streaming, client lifecycle, and a test that reads a stream without hanging.

**Interfaces:**
- Consumes: `validFilter`, `matchFilter`, the cache, and `createBridge` from Task 4.
- Produces:
  - `openStream(res, filters): Client` where `Client` is `{ filters, send(topic, payload), close() }`.
  - `createBridge`'s `broadcast(topic, payload)` gains a body: it sends to every client whose
    filters match, once per client.
  - Test helper `readEvents(response, count): Promise<Array<{topic, payload}>>`, added to
    `test/helpers/bridge.js`.

- [ ] **Step 1: Write the failing test**

Create `test/events.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { readEvents, startBridge, waitFor } from './helpers/bridge.js'

test('retained messages arrive on connect, live ones after', async () => {
  const bridge = await startBridge()
  await fetch(`${bridge.base}/src/Acurite/1`, { method: 'POST', body: '{"t":1}' })
  await waitFor(() => bridge.cache.get('src/Acurite/1') !== undefined)

  const stream = await fetch(`${bridge.base}/events?f=src/%23`)
  assert.equal(stream.headers.get('content-type'), 'text/event-stream')
  const reading = readEvents(stream, 2)

  await fetch(`${bridge.base}/src/Acurite/2`, { method: 'POST', body: '{"t":2}' })
  const events = await reading

  assert.deepEqual(events, [
    { topic: 'src/Acurite/1', payload: { t: 1 } },
    { topic: 'src/Acurite/2', payload: { t: 2 } },
  ])

  await bridge.close()
})

test('repeated f delivers from every filter, and a topic matching two arrives once', async () => {
  const bridge = await startBridge()
  const stream = await fetch(`${bridge.base}/events?f=src/Acurite/%2B&f=src/%23`)
  const reading = readEvents(stream, 2)

  await fetch(`${bridge.base}/src/Acurite/1`, { method: 'POST', body: '{"t":1}' })
  await fetch(`${bridge.base}/src/Other/1`, { method: 'POST', body: '{"t":2}' })
  const events = await reading

  assert.deepEqual(events, [
    { topic: 'src/Acurite/1', payload: { t: 1 } },
    { topic: 'src/Other/1', payload: { t: 2 } },
  ])

  await bridge.close()
})

test('a filter matching nothing opens and stays empty', async () => {
  const bridge = await startBridge()
  const stream = await fetch(`${bridge.base}/events?f=nothing/%23`)
  assert.equal(stream.status, 200)

  const raced = await Promise.race([
    readEvents(stream, 1).then(() => 'event'),
    new Promise((resolve) => setTimeout(() => resolve('quiet'), 300)),
  ])
  assert.equal(raced, 'quiet')

  await bridge.close()
})

test('omitting f subscribes to everything, and a malformed filter is 400', async () => {
  const bridge = await startBridge()

  const all = await fetch(`${bridge.base}/events`)
  assert.equal(all.status, 200)
  await all.body.cancel()

  const bad = await fetch(`${bridge.base}/events?f=a/%23/c`)
  assert.equal(bad.status, 400)

  await bridge.close()
})

test('an alias reaches a subscriber like any other topic', async () => {
  const bridge = await startBridge()
  const stream = await fetch(`${bridge.base}/events?f=src/%23`)
  const reading = readEvents(stream, 1)

  await fetch(`${bridge.base}/src/Acurite/1/$alias`, { method: 'POST', body: '"Back fence"' })

  assert.deepEqual(await reading, [{ topic: 'src/Acurite/1/$alias', payload: 'Back fence' }])

  await bridge.close()
})
```

- [ ] **Step 2: Add the stream reader to the test helper**

Append to `test/helpers/bridge.js`:

```js
export async function readEvents(response, count) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const events = []
  let buffer = ''

  while (events.length < count) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let split
    while ((split = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, split)
      buffer = buffer.slice(split + 2)
      if (frame.startsWith('data: ')) events.push(JSON.parse(frame.slice(6)))
    }
  }

  await reader.cancel()
  return events
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd /home/john/src/mqtt-http-bridge && npm test`
Expected: FAIL, `Cannot find module '.../src/sse.js'`.

- [ ] **Step 4: Write `src/sse.js`**

```js
import { matchFilter } from './topic.js'

const KEEPALIVE_MS = 15000

export function openStream(res, filters) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  })
  res.write(':open\n\n')

  const keepalive = setInterval(() => res.write(':keepalive\n\n'), KEEPALIVE_MS)
  keepalive.unref()

  return {
    filters,
    send(topic, payload) {
      if (!filters.some((filter) => matchFilter(filter, topic))) return
      res.write(`data: ${JSON.stringify({ topic, payload: decode(payload) })}\n\n`)
    },
    close() {
      clearInterval(keepalive)
      res.end()
    },
  }
}

// A payload that is not JSON is carried as the string it is, so a foreign
// publisher on the broker cannot break the frame.
function decode(payload) {
  try {
    return JSON.parse(payload)
  } catch {
    return payload
  }
}
```

- [ ] **Step 5: Wire it into `src/server.js`**

Replace the whole of `src/server.js` with:

```js
import http from 'node:http'

import { openStream } from './sse.js'
import { validFilter, validTopic } from './topic.js'

export function createBridge({ broker, cache }) {
  const clients = new Set()

  const bridge = {
    httpServer: http.createServer((req, res) => handle(req, res, { broker, cache, clients })),
    clients,
    broadcast(topic, payload) {
      for (const client of clients) client.send(topic, payload)
    },
  }
  return bridge
}

async function handle(req, res, { broker, cache, clients }) {
  const url = new URL(req.url, 'http://bridge.invalid')

  if (!broker.connected()) return send(res, 503, 'broker unavailable')

  if (url.pathname === '/events') {
    if (req.method !== 'GET') return send(res, 405, 'method not allowed')
    return subscribe(req, res, { cache, clients, url })
  }

  const topic = decodeURIComponent(url.pathname.slice(1))
  if (!validTopic(topic)) return send(res, 400, 'malformed topic')

  if (req.method === 'GET') {
    const payload = cache.get(topic)
    if (payload === undefined) return send(res, 404, 'no message')
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(payload)
  }

  if (req.method === 'POST') {
    const body = await readBody(req)
    try {
      JSON.parse(body)
    } catch {
      return send(res, 400, 'body is not JSON')
    }
    await broker.publish(topic, body)
    res.writeHead(204)
    return res.end()
  }

  return send(res, 405, 'method not allowed')
}

function subscribe(req, res, { cache, clients, url }) {
  const filters = url.searchParams.getAll('f')
  if (filters.length === 0) filters.push('#')
  if (!filters.every(validFilter)) return send(res, 400, 'malformed filter')

  const client = openStream(res, filters)
  clients.add(client)
  req.on('close', () => {
    clients.delete(client)
    client.close()
  })

  const replayed = new Set()
  for (const filter of filters) {
    for (const [topic, payload] of cache.match(filter)) {
      if (replayed.has(topic)) continue
      replayed.add(topic)
      client.send(topic, payload)
    }
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

function send(res, status, message) {
  res.writeHead(status, { 'content-type': 'text/plain' })
  res.end(`${message}\n`)
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd /home/john/src/mqtt-http-bridge && npm test`
Expected: PASS, 23 tests.

If the `retained messages arrive on connect` test sees the live message before the retained one,
the replay is racing the broadcast — replay happens synchronously inside `subscribe` before the
handler returns, so any ordering failure means a message was published before the stream opened.
Check the `waitFor` in the test, not the server.

- [ ] **Step 7: Commit**

```bash
cd /home/john/src/mqtt-http-bridge
git add src/sse.js src/server.js test/events.test.js test/helpers/bridge.js
git commit -m "Subscribe to many filters on one stream

Repeating f keeps a dashboard watching dozens of topics inside the
browser's per-origin connection limit. A topic two filters both select is
sent once."
```

---

### Task 6: The executable and its configuration

**Files:**
- Create: `/home/john/src/mqtt-http-bridge/bin/mqtt-http-bridge.js`
- Create: `/home/john/src/mqtt-http-bridge/src/config.js`
- Test: `/home/john/src/mqtt-http-bridge/test/config.test.js`

**Model:** `haiku` — the complete code is below.

**Interfaces:**
- Consumes: everything above.
- Produces: `readConfig(env): { mqttUrl, port, host, username, password }`.

- [ ] **Step 1: Write the failing test**

Create `test/config.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { readConfig } from '../src/config.js'

test('an empty environment gives the local defaults', () => {
  assert.deepEqual(readConfig({}), {
    mqttUrl: 'mqtt://localhost:1883',
    port: 8080,
    host: '0.0.0.0',
    username: undefined,
    password: undefined,
  })
})

test('the environment overrides every field', () => {
  const config = readConfig({
    MQTT_URL: 'mqtt://broker.local:1883',
    PORT: '9000',
    HOST: '127.0.0.1',
    MQTT_USERNAME: 'user',
    MQTT_PASSWORD: 'secret',
  })
  assert.deepEqual(config, {
    mqttUrl: 'mqtt://broker.local:1883',
    port: 9000,
    host: '127.0.0.1',
    username: 'user',
    password: 'secret',
  })
})

test('a PORT that is not a number is rejected rather than defaulted', () => {
  assert.throws(() => readConfig({ PORT: 'http' }), /PORT/)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/john/src/mqtt-http-bridge && npm test`
Expected: FAIL, `Cannot find module '.../src/config.js'`.

- [ ] **Step 3: Write `src/config.js`**

```js
export function readConfig(env) {
  const port = env.PORT === undefined ? 8080 : Number(env.PORT)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be a port number, got ${JSON.stringify(env.PORT)}`)
  }

  return {
    mqttUrl: env.MQTT_URL ?? 'mqtt://localhost:1883',
    port,
    host: env.HOST ?? '0.0.0.0',
    username: env.MQTT_USERNAME,
    password: env.MQTT_PASSWORD,
  }
}
```

- [ ] **Step 4: Write `bin/mqtt-http-bridge.js`**

```js
#!/usr/bin/env node
import { connectBroker } from '../src/broker.js'
import { createCache } from '../src/cache.js'
import { readConfig } from '../src/config.js'
import { createBridge } from '../src/server.js'

const config = readConfig(process.env)
const cache = createCache()

let bridge
const broker = await connectBroker({
  url: config.mqttUrl,
  cache,
  onMessage: (topic, payload) => bridge.broadcast(topic, payload),
  username: config.username,
  password: config.password,
})
bridge = createBridge({ broker, cache })

bridge.httpServer.listen(config.port, config.host, () => {
  console.log(`mqtt-http-bridge on http://${config.host}:${config.port}, broker ${config.mqttUrl}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    bridge.httpServer.close()
    broker.end().then(() => process.exit(0))
  })
}
```

- [ ] **Step 5: Make it executable and run the tests**

```bash
cd /home/john/src/mqtt-http-bridge
chmod +x bin/mqtt-http-bridge.js
npm test
```
Expected: PASS, 26 tests.

- [ ] **Step 6: Verify it starts and refuses cleanly with no broker**

Run: `cd /home/john/src/mqtt-http-bridge && timeout 5 env MQTT_URL=mqtt://127.0.0.1:1 node bin/mqtt-http-bridge.js; echo "exit $?"`
Expected: it does not print the listening line, and exits non-zero or is killed by the timeout.
Either is acceptable; the point is that it does not serve traffic it cannot answer.

- [ ] **Step 7: Commit**

```bash
cd /home/john/src/mqtt-http-bridge
git add bin/mqtt-http-bridge.js src/config.js test/config.test.js
git commit -m "Start the bridge from the environment

A bad PORT stops the process rather than silently falling back to the
default, which would leave it listening somewhere nobody expects."
```

---

### Task 7: Documentation

**Files:**
- Create: `/home/john/src/mqtt-http-bridge/README.md`
- Create: `/home/john/src/mqtt-http-bridge/docs/install.md`
- Create: `/home/john/src/mqtt-http-bridge/docs/user-manual.md`
- Create: `/home/john/src/mqtt-http-bridge/docs/architecture.md`
- Create: `/home/john/src/mqtt-http-bridge/docs/development.md`
- Create: `/home/john/src/mqtt-http-bridge/docs/backlog.md`
- Delete: `/home/john/src/mqtt-http-bridge/docs/superpowers/plans/2026-08-14-mqtt-http-bridge.md`

**Model:** `sonnet` — prose written to a house style, not transcription.

**Interfaces:**
- Consumes: the finished implementation.
- Produces: nothing code depends on.

The house rules for this prose: plain words, no marketing, no meaningless
introductions, cut any sentence whose removal loses no information. `docs/binding.md`
already exists and is the protocol reference — link to it rather than restating it.

- [ ] **Step 1: Write `README.md`**

What it is, who it's for, one example, the install one-liner, and links into `docs/`.
Keep it short. The example must be real and copy-pasteable:

```
    MQTT_URL=mqtt://broker.local:1883 npx mqtt-http-bridge

    curl localhost:8080/rtl433-a1b2c3/Acurite-5n1/1234
    curl -N 'localhost:8080/events?f=rtl433-a1b2c3/%23'
```

Note the `%23`: an unescaped `#` in a URL is a fragment and never reaches the server.

- [ ] **Step 2: Write `docs/install.md`**

Node 22 or later, one runtime dependency, a reachable MQTT broker. Cover running it
from a clone, the environment variables from `src/config.js` with their defaults, and
a runit service directory, since the receiver's host runs Void.

- [ ] **Step 3: Write `docs/user-manual.md`**

Every environment variable and every operation, with a `curl` for each. State the
status codes from `src/server.js` and when each occurs. Point at `docs/binding.md` for
the protocol itself.

- [ ] **Step 4: Write `docs/architecture.md`**

The module boundaries: `topic.js` is matching with no I/O, `cache.js` is the last
message per topic, `broker.js` owns the one MQTT connection, `sse.js` owns a stream's
lifetime, `server.js` routes. Record the two decisions a reader will question:

  - The bridge subscribes to `#` and caches everything, which is what lets GET answer
    without a round trip and lets a new subscriber be replayed. On a broker with a
    large topic space that is a real memory cost, and it is the first thing to revisit.
  - Filters are fixed for the life of a connection, so a dashboard changing its watch
    list reconnects. A subscription resource with a PATCH was considered and dropped
    as server-side state the embedded implementation would also have to hold.

- [ ] **Step 5: Write `docs/development.md`**

Repo layout, `npm test` (`node --test`, no framework), that `aedes` runs an in-process
broker so the suite needs nothing installed, and how to add a test.

- [ ] **Step 6: Write `docs/backlog.md`**

Carry forward what this plan knowingly left:

  - Caching every topic through a `#` subscription does not scale to a busy broker.
  - No authentication on the HTTP side. Anyone who can reach the port can publish.
  - A slow SSE reader is never dropped; `res.write` buffers without bound.
  - `503` is answered from `broker.connected()` at request time, so a request in flight
    when the broker drops still gets a `404` or a stale `200`.

- [ ] **Step 7: Verify the tests still pass and the docs match the code**

Run: `cd /home/john/src/mqtt-http-bridge && npm test`
Expected: PASS, 26 tests.

Then read `src/config.js` and `src/server.js` and confirm every variable and status code
named in the docs exists, and that none is missing.

- [ ] **Step 8: Delete the plan and commit**

```bash
cd /home/john/src/mqtt-http-bridge
rm -r docs/superpowers
git add -A
git commit -m "Document the bridge

README, install, manual, architecture, and backlog. The plan is deleted;
what it decided is in architecture.md and what it deferred is in
backlog.md."
```

---

### Task 8: Point the receiver's roadmap at the bridge

**Files:**
- Modify: `/home/john/src/rtl433-web-receiver/docs/backlog.md`
- Delete: `/home/john/src/rtl433-web-receiver/docs/superpowers/specs/2026-08-14-http-mqtt-binding-design.md`

**Model:** `haiku` — a path change and a file deletion.

**Interfaces:**
- Consumes: the bridge repo existing at `/home/john/src/mqtt-http-bridge`.
- Produces: nothing.

- [ ] **Step 1: Update the roadmap's two references**

In `/home/john/src/rtl433-web-receiver/docs/backlog.md`, under
`## 1. The HTTP binding for MQTT (spec)`, replace the path
`docs/superpowers/specs/2026-08-14-http-mqtt-binding-design.md` with
`~/src/mqtt-http-bridge/docs/binding.md`, and replace the paragraph beginning
"It lives in this repo because this is where it was written" with a sentence saying it
now lives beside the bridge. Under `## 2. mqtt-http-bridge`, note that it is built.

- [ ] **Step 2: Delete the spec from this repo**

```bash
cd /home/john/src/rtl433-web-receiver
git rm -r docs/superpowers
```

- [ ] **Step 3: Verify no reference to the old path survives**

Run: `cd /home/john/src/rtl433-web-receiver && grep -rn "superpowers/specs" --include=*.md . || echo "clean"`
Expected: `clean`.

- [ ] **Step 4: Commit**

```bash
cd /home/john/src/rtl433-web-receiver
git add -A
git commit -m "Move the binding spec to the bridge that implements it

Two other projects depend on it and neither is this one."
```
