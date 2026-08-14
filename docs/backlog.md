# Backlog

- Caching every topic through a `#` subscription does not scale to a busy
  broker. See [`docs/architecture.md`](architecture.md#caching-everything).
- No authentication on the HTTP side. Anyone who can reach the port can
  publish, including to `$alias` topics.
- `readBody` in `src/server.js` buffers a request body with no size cap and
  no timeout, so a large or slow-drip POST accumulates in memory.
- `PORT` is parsed with `Number` in `src/config.js`, which accepts hex, so
  `PORT=0x1F90` silently becomes 8080 instead of being rejected.
- A slow SSE reader is never dropped; `res.write` in `src/sse.js` buffers
  without bound.
- `503` is decided from `broker.connected()` at request time, so a request
  in flight when the broker drops can still get a `404` or a stale `200`.
- A `POST` caches the payload itself before answering `204`, so a `GET` can
  report `200` for a message the broker accepted but never retained, until
  the `#` subscription catches up.
- A `500` is still possible for an error the bridge does not foresee. The
  binding defines no such status; reaching it is a bug, not a contract.
- A retained message deleted by a zero-length publish reaches SSE
  subscribers as an event with an empty payload. Nothing marks it as a
  deletion, so a subscriber cannot tell it apart from an empty message.
- `matchFilter('#', '$SYS/...')` returns `true`, where MQTT excludes topics
  beginning with `$` from a `#` subscription. Moot against a real broker,
  which never delivers them, but wrong on its own terms.
- `test/helpers/bridge.js` builds the bridge in one synchronous step, so it
  cannot reproduce the startup ordering the `bridge?.broadcast` guard in
  `bin/mqtt-http-bridge.js` exists for. That guard is untested.
- The package is not published to a registry, so there is no `npx` or
  `npm install -g` path; it runs from a clone.
