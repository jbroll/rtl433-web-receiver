# Backlog

- Caching every topic through a `#` subscription does not scale to a busy
  broker. See [`docs/architecture.md`](architecture.md#caching-everything).
- Broker connect, disconnect, and error are printed but nothing exposes them
  over HTTP; there is no status endpoint to ask why the bridge is answering
  `503`.
- No authentication on the HTTP side. Anyone who can reach the port can
  publish, including to `$alias` topics.
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
  `204`; what it does not prove is that the bridge's own packet arrived.
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
  `bin/mqtt-http-bridge.js` exists for. That guard is untested.
- The package is not published to a registry, so there is no `npx` or
  `npm install -g` path; it runs from a clone. `package.json` declares a
  `bin` entry for a command nothing installs.
- `SIGTERM` while a `POST` is waiting for its echo drops the request with no
  HTTP status at all: the streams and the server are closed and the broker
  connection ended without waiting for the publish to come back. The client
  sees the connection go away and cannot tell whether the message was taken.
