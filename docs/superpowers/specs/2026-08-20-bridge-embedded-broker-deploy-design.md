# Bridge embedded broker and deploy to weather.rkroll.com

## Why

`bridge/` is currently an HTTP-to-MQTT sidecar with no broker of its own: it
dials out to `MQTT_URL`, which has to be a broker already running somewhere
reachable. Deploying it as a single service means it needs to bring its own
broker. Once it has one, that broker also becomes the target the receiver
firmware can publish straight to over MQTT, without the receiver holding an
HTTP client's worth of buffering or the bridge needing to poll anything.

This spec covers standing the bridge up as one self-contained service at
`weather.rkroll.com`: an embedded MQTT broker, a read-only-public /
authenticated-write split on both the HTTP and MQTT surfaces, and the
`deploy.sh` changes that deployment needs. The receiver firmware's own MQTT
publish path is a separate spec, written after this one lands, since it
depends on the URL and the auth token this work produces.

## Non-goals

- Rewriting `broker.js`/`cache.js` to talk to aedes's JS API directly
  (considered, rejected: the loopback-TCP shape below reuses the existing,
  tested `mqtt`-client code path unchanged).
- MQTT-over-WebSocket through Apache (considered, rejected in favor of a
  direct MQTTS port — see "MQTT transport" below).
- Copying the Let's Encrypt certificate to a second location (considered,
  rejected: an in-place permission grant needs no second copy to keep in
  sync).
- The bridge's own whole-vhost `token_auth` deploy.sh module (wrong shape:
  it gates an entire path behind one Apache-level token; this needs
  per-HTTP-method gating that only the app itself can do).
- The receiver firmware's publish side. Next spec.

## Architecture

### Embedding aedes (Approach A: loopback-or-public TCP, not the in-process JS API)

`bridge/test/helpers/broker.js` already starts a real `aedes` broker on a
TCP port and `bridge/test/helpers/bridge.js` already points the existing
`mqtt`-client `connectBroker` at it — proving the whole existing broker.js
code path works unmodified against an embedded aedes. Production does the
same thing in one process instead of two:

`bin/mqtt-http-bridge.js` gains a startup step, before `connectBroker` is
called: if embedding is enabled (default — see CLI/env below), create an
`aedes` instance, wrap it with `net.createServer(aedes.handle)`, and
`listen()` it. Once it's listening, call the existing `connectBroker({ url:
'mqtt://127.0.0.1:<port>', ... })` exactly as today. No changes to
`broker.js`, `cache.js`, `server.js`, or any existing test — they only ever
see "a broker at a URL," embedded or not.

`aedes` moves from `devDependencies` to `dependencies` in
`bridge/package.json`.

### Two listener modes, chosen by whether TLS is configured

The embedded broker binds exactly one of these, decided at startup by
whether `--tls-cert`/`--tls-key` (or `TLS_CERT`/`TLS_KEY`) are present:

- **No TLS configured (local/dev default):** plain MQTT on
  `127.0.0.1:<mqttPort>` (default port `1883`). Loopback only — never reachable
  off the box — so no `authenticate` hook is installed; the network boundary
  is the whole trust boundary, same as today's dev workflow.
- **TLS configured (the weather.rkroll.com deploy):** MQTTS on
  `0.0.0.0:<mqttsPort>` (default port `8883`), publicly reachable, WITH
  aedes's `authenticate` hook installed and required. Startup fails fast
  (throws before `listen()`) if TLS is configured but no `AUTH_TOKEN` is set
  — a public, unauthenticated broker is not a state this can start into
  silently.

Only one of the two listeners ever runs. There is no flag to run both; if a
future need for a local-loopback debug port alongside the public one shows
up, that's a new decision, not a default.

### Auth: one shared secret, two surfaces

`AUTH_TOKEN` (env or `--auth-token`) is the one secret. Unset = auth
disabled on both surfaces (the existing dev-friendly default — matches how
`MQTT_USERNAME`/`MQTT_PASSWORD` already work today).

- **HTTP:** `GET /<topic>` and `GET /events` are never gated. `POST
  /<topic>` requires `Authorization: Bearer <AUTH_TOKEN>`; missing or wrong
  is `401`.
- **MQTT:** aedes's `authenticate(client, username, password, callback)`
  hook accepts any username and compares `password` to `AUTH_TOKEN`;
  `CONNECT` is refused (and the TCP connection closed) on a mismatch.
  Because auth happens at `CONNECT`, there is no equivalent to "reads are
  free" on the MQTT side within one connection — a client that authenticates
  gets full read+write over `#`, same as the bridge's own internal
  connection does today. Public read access to the data therefore continues
  to come from the HTTP side (`GET`/`/events`), which is intentionally the
  one surface that stays open with no credential at all.

Both comparisons use `node:crypto.timingSafeEqual` on equal-length buffers
(reject immediately, without comparing, when lengths differ) — the same
constant-time discipline `deploy.sh`'s `token_auth` module already applies
to its own token check, for the same reason: a naive `===` leaks the
token's length and prefix through response-timing.

### CLI switches and config precedence

`bin/mqtt-http-bridge.js` parses argv with `node:util.parseArgs` before
building config. Precedence for every overridable field: CLI flag > env var
> default. Only the fields this work adds get CLI flags — `PORT`, `HOST`,
`MQTT_USERNAME`, `MQTT_PASSWORD` stay env-only, unchanged, out of scope.

| CLI flag | Env var | Default | Meaning |
|---|---|---|---|
| `--no-embed-broker` | `EMBED_BROKER=false` | embed (`true`) | Disable embedding; fall back to dialing `--broker-url`/`MQTT_URL` like today. |
| `--broker-url <url>` | `MQTT_URL` | `mqtt://localhost:1883` | Only consulted when embedding is disabled. |
| `--mqtt-port <n>` | `MQTT_PORT` | `1883` | Embedded broker's plaintext loopback port (no-TLS mode). |
| `--mqtts-port <n>` | `MQTTS_PORT` | `8883` | Embedded broker's public TLS port (TLS mode). |
| `--tls-cert <path>` | `TLS_CERT` | unset | Cert file (PEM). Presence (with `--tls-key`) selects TLS mode. |
| `--tls-key <path>` | `TLS_KEY` | unset | Key file (PEM). |
| `--auth-token <token>` | `AUTH_TOKEN` | unset (auth disabled) | Shared secret for HTTP `POST` and MQTT `CONNECT`. |

`readConfig(env, argv)` in `bridge/src/config.js` gains these fields
alongside the existing ones, following the same validation style already
there (throw with a clear message on a malformed value — e.g. a `--mqtt-port`
that isn't an integer 0–65535, same shape as the existing `PORT` check).
`bin/mqtt-http-bridge.js` throws before calling `.listen()` anywhere if TLS
is configured without `AUTH_TOKEN` (see above).

### `binding.md`

Add one row to the Errors table: `401` — bearer token missing or wrong on a
`POST`, when the implementation has auth enabled. Marked as
implementation-specific (parallel to how CORS is already called out as a
bridge behavior, not a base-binding requirement) — the receiver's own
source-only subset is untouched by this spec and keeps its existing `405`
answer for a non-`$alias` `POST`.

## `deploy.sh` changes (separate repo, same workflow: branch, ff-merge to main)

Both are opt-in additions to existing modules — no behavior change for any
current `deploy.conf` that doesn't set the new variables.

### `apache` module: flush long-lived proxied connections

New variable `APACHE_PROXY_FLUSH_PATHS`, a space-separated list of incoming
paths, parallel to the existing `APACHE_WEBSOCKET_PATHS`-style handling in
`modules/apache/build.sh`. For a proxy rule whose incoming path is in this
list, the generated `ProxyPass` line gets `flushpackets=on` appended, so
Apache streams the backend's response instead of buffering it — needed for
`/events` (SSE) to arrive live rather than in stalled bursts.

### `letsencrypt` module: grant a service user read access to the key, in place

New variable `LETSENCRYPT_KEY_READER="<user>"`. When set, after
obtaining/renewing the certificate:

1. `chgrp <user> /etc/letsencrypt/live/<domain>/privkey.pem` (and the
   `archive/` file it links to) and `chmod 640`. `fullchain.pem` is already
   world-readable by default and needs no change.
2. Install a certbot `--deploy-hook` script (under
   `/etc/letsencrypt/renewal-hooks/deploy/`) that repeats step 1, since
   renewal regenerates the files under default root-only permissions each
   time — this is what makes it survive renewal instead of working only
   until the first one.

No file is copied; the service reads the same file Apache's TLS vhost
would, just with a narrower group grant added.

## Deploy config: `weather.rkroll.com`

`bridge/deploy.conf` (new file):

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

Secrets (not committed — `bridge/secrets.env`, picked up by `node_app`'s
existing `EnvironmentFile` mechanism):

```sh
AUTH_TOKEN=<openssl rand -hex 24>
TLS_CERT=/etc/letsencrypt/live/weather.rkroll.com/fullchain.pem
TLS_KEY=/etc/letsencrypt/live/weather.rkroll.com/privkey.pem
```

`EMBED_BROKER` is left unset — it defaults to `true`, which is what this
deploy wants. `MQTTS_PORT` is left at its default, `8883`.

**Manual prerequisite, not automated by `deploy.sh`:** opening TCP `8883` in
the VPS's firewall. `deploy.sh` has no firewall module; this is a one-time
manual step (or a note for whatever tool manages that VPS's firewall) called
out here so it isn't discovered by a firmware connection failing silently.

## Testing

- `bridge/test/`: new cases for the `AUTH_TOKEN`-gated `POST` (`401` on
  missing/wrong token, `204` unchanged on a correct one or when
  `AUTH_TOKEN` is unset), and for the embedded-broker startup path (aedes
  listening, `connectBroker` reaching it, a publish round-tripping) — using
  the same `startBroker`/`startBridge` test-helper shape already in
  `test/helpers/`, extended to also exercise `EMBED_BROKER=true` rather than
  only the "point at a pre-started broker" case they cover today.
- A focused test for the MQTT `authenticate` hook: a connection with the
  right token succeeds, a wrong or missing one is refused — this needs
  aedes's own client (or the `mqtt` package) as a test client connecting to
  an embedded instance, not the existing HTTP-facing test helpers.
- `deploy.sh`'s two module changes get their own module-level tests
  following that repo's existing `test/` conventions (not detailed here —
  the implementation plan for that repo's change specifies them).
- Deploy verification is manual: after `deploy init`, confirm `GET
  https://weather.rkroll.com/<topic>` answers (public, no token), confirm
  `POST` without a token is `401`, confirm an `mqtt`-client connection to
  `mqtts://weather.rkroll.com:8883` with the right password in the standard
  MQTT.js style succeeds and a publish round-trips through `GET`.

## What this unblocks

The receiver firmware's own MQTT publish path (next spec): it will hold
`weather.rkroll.com:8883`, the shared `AUTH_TOKEN`, and (since MQTTS
terminates real TLS) either the firmware's CA bundle needs to include Let's
Encrypt's root, or the firmware pins the leaf/intermediate — a decision for
that spec, not this one.
