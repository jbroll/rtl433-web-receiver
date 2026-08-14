# Architecture

## Modules

- `src/topic.js` — filter and topic matching. No I/O, no state.
- `src/cache.js` — the last message per topic, an in-memory `Map`.
- `src/broker.js` — the one MQTT connection: subscribes, publishes, reports
  whether it is connected.
- `src/sse.js` — one SSE stream's lifetime: the response headers, the
  keepalive timer, filtering outgoing messages, closing.
- `src/server.js` — routes HTTP requests to the cache, the broker, and
  `sse.js`; owns the set of open streams.
- `bin/mqtt-http-bridge.js` — wires the above together, reads config, starts
  listening, handles shutdown.

## Caching everything

The bridge subscribes to `#` on connect and caches every message it
receives in `cache.js`, keyed by topic. That is what lets a `GET` answer
without a round trip to the broker, and what lets a new SSE subscriber be
replayed with the current state of every topic it's watching on connect,
rather than waiting for the next publish.

A `POST` writes the published payload into the cache itself, before it
answers `204`. The broker echoes the same message back over the `#`
subscription, but that takes a round trip, and until it lands a `GET` of the
topic just written would answer `404`. The binding's first test case is that
it does not.

On a broker with a large topic space this is a real memory cost: the cache
holds one entry per topic ever seen, for the life of the process, whether or
not anyone is watching it. It is the first thing to revisit if the bridge
needs to run against a busy broker.

## Filters are fixed per connection

An SSE client's filters are set once, from the `f` query parameters at
connect time, and never change for that connection. A client that wants to
watch a different set of topics reconnects.

A subscription resource — `PATCH` a filter list on an open subscription —
was considered and dropped. It would mean the bridge holds server-side
state per client beyond the stream itself, and the receiver's planned
embedded implementation would have to hold the same state with far less
memory to do it in. Reconnecting costs a round trip; a `PATCH` endpoint
costs a second thing to keep consistent, on both implementations, for the
life of the project.

## Shutdown order

On `SIGINT` or `SIGTERM`, `bin/mqtt-http-bridge.js` closes every open SSE
stream, then the HTTP server, then the broker connection — in that order.

`httpServer.close()` waits for all open connections to end before its
callback fires; an SSE stream is a connection held open indefinitely, so
closing the server first would hang for as long as any client stays
connected. Closing the streams first is what makes shutdown complete at
all. Measured with one SSE stream attached, the process exits about 20 ms
after the signal.
