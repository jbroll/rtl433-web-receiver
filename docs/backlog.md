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
