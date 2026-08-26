# Backlog

- Caching every topic through a `#` subscription does not scale to a busy
  broker. See [`docs/architecture.md`](architecture.md#caching-everything).
- Broker connect, disconnect, and error are printed but nothing exposes them
  over HTTP; there is no status endpoint to ask why the bridge is answering
  `503`.
- `readBody` in `src/server.js` buffers a request body with no size cap and
  no timeout, so a large or slow-drip POST accumulates in memory.
- `PORT` is parsed with `Number` in `src/config.js`, which accepts hex, so
  `PORT=0x1F90` silently becomes 8080 instead of being rejected.
- A slow SSE reader is never dropped; `res.write` in `src/sse.js` buffers
  without bound.
- Clearing the cache on reconnect is invisible to an SSE subscriber: it is
  told nothing about the topics that went away, and the ones that come back
  arrive as ordinary messages, so a subscriber is re-sent every matching
  retained topic on every reconnect whether or not its value changed. See
  [`docs/user-manual.md`](user-manual.md#get-events--subscribe).
- `503` is decided from `broker.connected()` at request time, so a request
  in flight when the broker drops can still get a `404` or a stale `200`.
- A `POST` is held for the broker's round trip, so a publisher's throughput
  is bounded by the link's latency rather than by the bridge. A publish the
  broker never echoes holds it for the full 5 seconds before the `503`.
- An echo is matched by topic and payload, so a `204` is still possible for a
  publish the broker lost on a half-open link: another publisher sending the
  same bytes to that topic inside the wait answers it. The broker and the
  cache then hold those bytes, so the client's next `GET` agrees with its
  `204`; what it does not prove is that the bridge's own packet arrived. The
  same match fires across a reconnect: a publish lost while the link was down
  is answered `204` when the retained replay of that publisher's own earlier
  message comes back and matches the bytes still waiting.
- A `500` is still possible for an error the bridge does not foresee. The
  binding defines no such status; reaching it is a bug, not a contract.
- A retained message deleted by a zero-length publish reaches SSE
  subscribers as an event with an empty payload. Nothing marks it as a
  deletion, so a subscriber cannot tell it apart from an empty message.
- A retained message deleted while the bridge is connected stays in the
  cache as an empty message until the next reconnect, because the broker
  clears the retain flag on what it forwards and the delete is
  indistinguishable from an ordinary empty message. `GET` answers `404` for
  both, but an SSE subscriber is sent the empty message and a `#` replay to a
  later subscriber carries the topic. MQTT 5's retain-as-published
  subscription option would tell them apart, at the cost of requiring an
  MQTT 5 broker; `aedes` is MQTT 3.1.1 only, so the suite could not cover it.
- `matchFilter('#', '$SYS/...')` returns `true`, where MQTT excludes topics
  beginning with `$` from a `#` subscription. Moot against a real broker,
  which never delivers them, but wrong on its own terms.
- `test/helpers/bridge.js` builds the bridge in one synchronous step, so it
  cannot reproduce the startup ordering the `bridge?.broadcast` guard in
  `bin/mqtt-http-bridge.js` exists for. That guard is untested. The `ending`
  guard on the broker's `error` handler in `src/broker.js` is untested for
  the same kind of reason: removing it fails no test, and the out-of-process
  timing it guards against could not be reproduced to write one.
- The package is not published to a registry, so there is no `npx` or
  `npm install -g` path; it runs from a clone. `package.json` declares a
  `bin` entry for a command nothing installs.
- `SIGTERM` while a `POST` is waiting for its echo drops the request with no
  HTTP status at all: the streams and the server are closed and the broker
  connection ended without waiting for the publish to come back. The client
  sees the connection go away and cannot tell whether the message was taken.
- A foreign publisher's non-retained empty message caches like any other
  message, so `GET` answers `404` for a topic whose retained message the
  broker still holds. It stays masked until the next reconnect rebuilds the
  cache from the broker's actual retained set. See
  [`docs/architecture.md`](architecture.md#payloads-stay-bytes).
- `binding.md`'s test list says a device with no alias omits the topic
  rather than returning an empty string, but the bridge does not do that. A
  retained delete of a `$alias` topic seen live is cached as an empty
  message, the same as any other retained delete a live connection sees (see
  the broker clearing the retain flag, above): `GET` answers `404`, but a
  subscriber that connects afterward is replayed the topic with
  `payload: ""`. A client resolving aliases has to treat an empty `$alias`
  payload from `/events` the same as a missing one, since the HTTP and SSE
  paths disagree about whether the topic exists.
- `Access-Control-Allow-Origin: *` means a page on any site the user visits can read a
  reachable bridge and publish to it. Authentication is the fix; an origin allowlist
  alone is not, since a non-browser client sends whatever origin it likes.
- The dashboard's alias-write `POST` (`dashboard/src/alias.js`) has no way to configure
  or send `Authorization: Bearer <AUTH_TOKEN>`, so alias writes fail with `401` against
  any bridge that has `AUTH_TOKEN` set — including the `weather.rkroll.com` deploy this
  branch adds. The dashboard needs its own token-configuration surface before that
  deploy's alias-editing UI can work.
- `POST /$tz` cannot work against a real bridge. MQTT excludes topic names beginning
  with `$` from a `#` wildcard subscription. `publish()` in `src/broker.js` waits for its
  own echo on the bridge's `#` subscription before resolving; for a `$`-leading topic
  that echo can never arrive, so the publish always times out (`ECHO_TIMEOUT_MS`, 5s) and
  `src/server.js` answers `503`. The dashboard (`dashboard/src/settings.js`) posts its
  GMT offset to a bare `${location.origin}/$tz`, so a real dashboard pointed at a real
  bridge stalls 5 seconds and fails every time a user sets their location.
  `a/b/$tz`-style source-scoped topics are unaffected; only a topic whose name itself
  starts with `$` is excluded.
- `rotate()` in `src/token-store.js` assigns `current` before it writes the file, so a
  failed persist leaves the live token rotated while the caller gets a `500` saying it
  failed. With `AUTH_TOKEN_PATH` under a directory that does not exist: `POST /auth/rotate`
  answers `500`, `store.get()` already returns the new token, the old one `401`s, and a
  restart silently reverts to the value on disk. The operator is locked out of HTTP POST
  and, in TLS mode, of MQTT CONNECT, believing rotation never happened. Write first, then
  assign.
- `writeFileSync` in `src/token-store.js` uses the default mode, so the persisted token
  lands `0644`. On the `weather.rkroll.com` deploy the process runs as its own user, so
  any other local account can read the secret that gates HTTP POST and MQTTS CONNECT.
  `{ mode: 0o600 }` is the fix; neither `docs/install.md` nor `docs/user-manual.md` tells
  the operator to lock the file down either.
- `src/token-store.js` trims on read and not on write, so a token with surrounding
  whitespace changes value across a restart. `{"token":"  tok  "}` passes the length check
  in `src/server.js`, is persisted verbatim, and every client authenticates with the padded
  form; after a restart the read path trims it and they all `401`. An all-whitespace token
  trims to empty, `if (fromFile)` is false, and the store falls back to the `AUTH_TOKEN`
  env value that was rotated away.
- `/auth/rotate` dereferences `parsed.token` without checking that `parsed` is an object
  (`src/server.js`), so a body of literal `null` throws and reaches the generic `500`
  handler, where `123`, `"str"`, `[]` and `{"token":{}}` all correctly answer `400`.
- The embedded broker reads its cert and key once at startup (`src/embedded-broker.js`)
  and never calls `setSecureContext` or watches the files. `deploy.conf` includes
  `letsencrypt`, so certbot rewrites them every 60 days and the MQTTS listener keeps
  presenting the old certificate until handshakes start failing at day 90. HTTPS through
  Apache is unaffected, so the symptom is external MQTT clients only, with nothing tying it
  to the renewal.
- `EMBED_BROKER` is tested as `=== 'false'` in `src/config.js`, so `0`, `no` and `FALSE`
  all start aedes anyway, bind `MQTT_PORT`, overwrite `brokerUrl`, and serve an empty local
  broker while `MQTT_URL` is ignored. `parsePort` rejects garbage loudly; this does not.
  Same family as the `PORT=0x1F90` entry above.
- The shutdown chain in `bin/mqtt-http-bridge.js` has no `.catch`, so a rejection from
  `broker.end()` or `embedded.close()` becomes an unhandled rejection, `process.exit(0)` is
  never reached, and the aedes listener on 8883 is never closed — the supervisor sees a
  crash rather than a clean stop. `httpServer.close()` is fired in the same block but never
  awaited.
- `connected()` in `src/broker.js` reflects CONNACK only, never whether the `#`
  subscription landed, which is at odds with what `docs/architecture.md` says the check is
  for. It does not manifest against aedes, which drops the connection rather than returning
  a failed SUBACK, so it could not be reproduced with the brokers in this repo. Against a
  broker that answers `0x80` and stays connected, `GET /events` would return `200` and
  stream nothing, topic `GET`s would `404` forever, and every `POST` would wait the full
  echo timeout.
- Nothing caps the number of concurrent SSE streams. Each `GET /events` adds a client with
  no authentication and no `maxConnections`, plus a 15 s `setInterval` of its own. The
  unbounded-`res.write` entry above covers one slow reader, not the count of readers.
- Replay filters twice: `cache.match(filter)` has already established that the topic
  matches, and then `client.send()` re-runs `filters.some(matchFilter)` over the whole list
  for the same topic. Only the `replayed` Set in that second pass does real work.
  Separately, `matchFilter` splits both filter and topic on every call and nothing caches
  the split, even though a stream's filters are fixed for its lifetime, so each broadcast
  costs `clients × filters` splits of the same strings.
- `bin/mqtt-http-bridge.js` has no test at all. Untested: `parseArgs` wiring, the shared
  `tokenStore` handoff to both `createBridge` and `startEmbeddedBroker`, `AUTH_TOKEN_PATH`
  end to end, the TLS-mode `brokerUsername = 'bridge'` self-connection, the dashboard
  `readFileSync`, and the signal-handler shutdown order `docs/architecture.md` documents.
  `test/token-store.test.js` covers only the happy path, so neither the rotate-before-persist
  nor the file-mode defect above would be caught; `src/sse.js`'s keepalive timer is never
  exercised, so nothing would notice it stop emitting and let an idle proxy drop every
  stream; and `test/rotate.test.js` covers wrong, missing, non-JSON and empty-string tokens
  but not a non-object body or a whitespace one.
- `scripts/build-dashboard.js` imports `../../dashboard/build.js`, which imports `esbuild`,
  and `esbuild` is in neither `dependencies` nor `devDependencies`. `npm ci && npm run build`
  fails with `ERR_MODULE_NOT_FOUND` anywhere `dashboard/node_modules` was not installed
  separately, and from an npm-installed copy the relative path does not exist at all. The
  package also declares a `bin` with no `files` field.
- Clearing an alias does not clear it. `dashboard/src/alias.js` clears an alias by
  posting an empty string (2 JSON bytes, `""`), expecting the bridge to treat it as a
  delete. The bridge instead caches it as an ordinary non-empty retained message, so a
  later `GET` returns `200 ""` instead of `404`, and the retained message survives a
  broker restart indefinitely.
- An SSE frame is built once per client instead of once per message. `send()` in
  `src/sse.js` does `JSON.stringify({ topic, payload: decode(payload) })` inside the
  per-client call, and `broadcast()` in `src/server.js` loops it over every client, so one
  incoming message costs N Buffer decodes, N `JSON.parse`s and N serializations to produce
  N identical strings. Nothing in the frame varies per client; only the filter test does.
  Hoisting the frame into `broadcast` is the fix. Splicing the raw payload text in to skip
  the parse round trip is not equivalent: `JSON.parse` then `JSON.stringify` normalises
  whitespace, number forms and duplicate keys, so the bytes on the wire would change.
- `POST` validates a different byte sequence than it publishes. `src/server.js` parses
  `body.toString('utf8')`, which substitutes U+FFFD for invalid bytes rather than failing,
  and then publishes the raw `body`. A body with invalid UTF-8 inside a JSON string literal
  passes the gate, is cached verbatim, and is served back under
  `content-type: application/json` as bytes the bridge never actually validated. Decoding
  once with `new TextDecoder('utf-8', { fatal: true })` and parsing that string rejects it
  and drops the second decode.
- `tokenMatches` in `src/auth.js` does not do what its own comment claims. The comment says
  a naive `===` leaks the token's length and prefix through response timing; the early
  `providedBuf.length !== expectedBuf.length` return closes the prefix leak and keeps the
  length oracle. The guard is required in this shape, because `timingSafeEqual` throws on
  unequal lengths. Comparing SHA-256 digests instead is length-independent and needs no
  early return, and it would let the expected digest be cached in the token store rather
  than `Buffer.from(expected)` being allocated on every HTTP request and MQTT CONNECT.
- `tokenMatches` dereferences `expected.length` before any type check, so a nullish
  expected token throws a `TypeError` from inside an aedes callback rather than returning
  `false`. Latent, not live: every current caller guards first. It is the one function the
  file's comment names as the single place the discipline has to be right.
- `rotate()` in `src/token-store.js` does not fsync, so the durability its comment promises
  is not there. Write-then-rename gives atomic visibility, not durability: without an fsync
  on the temp file before the rename and on the containing directory after it, a power loss
  can leave the rename visible with the file's data unwritten, or lose the rename entirely.
  The temp path is also a fixed `${path}.tmp`, so two overlapping rotations would write the
  same file; nothing can interleave them today because `rotate` is synchronous within one
  request.
- Every reconnect issues a duplicate SUBSCRIBE. `src/broker.js` sets `resubscribe: true`
  and also subscribes to `#` by hand inside the `connect` handler, so after the first
  connect each reconnect sends two SUBSCRIBE packets for the same filter. Idempotent at the
  broker, so it is redundant traffic rather than a bug, but it leaves two code paths
  re-establishing `#` where the comments describe one. The manual subscribe cannot simply
  be deleted: the `subscribed` promise and the error-clearing both hang off its callback.
  Setting `resubscribe: false` is the way round.
- Nothing caps the number of filters on one stream. `GET /events` is unauthenticated and
  takes as many `f` parameters as fit in the request line; each costs a full `cache.match`
  scan at connect and a `matchFilter` call per message per client for the life of the
  connection. The uncapped-stream-count entry above covers the number of readers, not the
  filters within one.
- Retained replay is a full cache scan per filter. `subscribe()` in `src/server.js` calls
  `cache.match(filter)` once per filter and each call iterates every cached topic, so
  connect cost is topics × filters and grows with the uncapped cache. Scanning the cache
  once and testing the filter list per topic gives the same result and collapses the
  `replayed` Set the double-filtering entry above describes.
- The dashboard is served without a charset. `src/server.js` writes
  `content-type: text/html` for a string read as `utf8` and re-encoded as UTF-8 bytes. The
  shipped `public/index.html` carries `<meta charset="utf-8">` and is pure ASCII, so
  nothing breaks today; an operator-supplied `--dashboard-html` without that meta tag and
  with a degree sign in it would be decoded by the browser's fallback encoding.
- The three `405` responses omit `Allow`, which RFC 9110 requires, and `HEAD` is refused
  where `GET` is supported, which the same rule forbids. A `HEAD /<topic>` falls past the
  `GET` branch onto the trailing `405`. Node strips the body from a `HEAD` response on its
  own, so letting `HEAD` take the `GET` branch needs no special casing.
- `/auth/rotate` is intercepted before topic parsing but appears nowhere in `binding.md`,
  so the bridge removes `auth/rotate` from the topic space of a protocol whose spec
  reserves nothing but `/events`. The fix is in the binding: either state which paths an
  implementation may reserve, or move the endpoint under a prefix the binding declares off
  limits.
- Shutdown may hang on a socket that connected and never sent CONNECT. `close()` in
  `src/embedded-broker.js` calls `server.close()` from inside the `aedes.close` callback,
  and `server.close()` fires only once every existing connection has ended. `aedes.close`
  destroys its own clients first, which is why this normally completes, but a pre-CONNECT
  socket is not an aedes client. Not reproduced. Distinct from the missing `.catch` on the
  shutdown chain above.
