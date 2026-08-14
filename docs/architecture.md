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

The broker is the only writer of the cache. A `POST` publishes and then waits
for the broker to echo the message back over the `#` subscription before it
answers `204`, so a `GET` right after a `204` reads what was posted, the
cache stays in the broker's own order, and a subscriber that connects after a
`POST` sees the message once rather than twice.

Writing the payload locally as well was the alternative, and answers sooner.
It also puts a second writer on the cache: a late echo of an earlier publish
lands on top of a newer local write, and a `GET` after a `204` goes
backwards. Measured over a 40 ms link, two sequential `POST`s to one topic
made a `GET` return the new value, then the old one, then the new one again.

The wait is bounded by `ECHO_TIMEOUT_MS` in `src/broker.js`, 5 seconds, after
which the `POST` is `503`. A broker on the same network echoes in a
millisecond or two; 5 seconds covers a connection dropping and being remade,
which takes one 2-second reconnect interval plus the round trips to connect
and resubscribe. It is also the only bound on a publish at QoS 0: `publish`
does not fail when the client is offline, it queues the packet and calls back
whenever a broker reappears, which was measured at 5967 ms with the request
held open and no status the whole time.

## Payloads stay bytes

A payload is a `Buffer` from the moment it is read, whether from a `POST`
body or from the broker, and that is what the cache holds and what a `GET`
writes back. The bridge subscribes to `#`, so it sees payloads from every
other publisher on the broker too, and decoding them to UTF-8 would replace
any byte that is not valid UTF-8 with U+FFFD. The one place a payload
becomes text is the SSE frame in `src/sse.js`, which is JSON and has no
other choice.

An incoming message with a zero-length payload deletes the cache entry only
when its packet carries the retain flag, which is how MQTT removes a
retained message. Without the flag it is an ordinary message with an empty
body and is cached like any other, because a foreign publisher sending one
must not make the bridge answer `404` for a topic the broker still holds.

A broker clears the retain flag on messages it forwards to an established
subscription, so the bridge does not see a retained delete as a delete: it
keeps serving the payload that was there until the connection is remade and
the cache is rebuilt.

The cache is emptied on every `connect`, before the `#` subscription is
made. What it holds came from the last connection, and a broker that has
restarted, or a different one at the same address, has its own retained set.
Keeping the old entries would serve a `200` for every topic the old broker
held, forever.

On a broker with a large topic space this is a real memory cost: the cache
holds one entry per topic ever seen, for the life of the process, whether or
not anyone is watching it. It is the first thing to revisit if the bridge
needs to run against a busy broker.

## Starting without a broker

`connectBroker` returns as soon as the client object exists, without waiting
for a connection, and the `mqtt` client retries every two seconds until the
broker answers. So the bridge listens and answers `503` from the moment it
starts, whether or not the broker is up yet, and starts serving once it is.
Waiting for the first connection instead would leave a bridge supervised by
runit crash-looping until its broker came up.

The `#` subscription is made on every `connect` event. `broker.subscribed`
resolves the first time it succeeds; a broker that refuses the subscription
leaves it pending and reports the error, rather than leaving a bridge that
looks ready and caches nothing. Tests await it before publishing so the echo
they are waiting for cannot be missed.

Connect, disconnect, and error are handed to `bin/mqtt-http-bridge.js`, the
one file that writes to the console. Without them a bridge whose password is
wrong answers `503` to every request and prints nothing after its startup
line.

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
