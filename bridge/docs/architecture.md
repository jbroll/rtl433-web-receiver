# Architecture

## Modules

- `src/topic.js` — filter and topic matching. No I/O, no state.
- `src/cache.js` — the last message per topic, an in-memory `Map`.
- `src/broker.js` — the one MQTT connection: subscribes, publishes, reports
  whether it is connected.
- `src/sse.js` — one SSE stream's lifetime: the response headers, the
  keepalive timer, filtering outgoing messages, closing.
- `src/server.js` — routes HTTP requests to the cache, the broker, and
  `sse.js`; owns the set of open streams. `GET /` is carved out ahead of
  topic routing to optionally serve a dashboard build — never a real topic,
  since `topic.js` rejects the empty string.
- `bin/mqtt-http-bridge.js` — wires the above together, reads config, starts
  listening, handles shutdown.
- `scripts/build-dashboard.js` — builds `../dashboard` into `public/index.html`
  for `DASHBOARD_HTML` to point at; not part of the request path.

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

An echo answers a `POST` only when its payload is the bytes that `POST`
published. Matching on the topic alone let the first message on a topic answer
every `POST` waiting on it, so two `POST`s in flight at once could each be
answered by the other's echo, and a foreign publisher's message could answer a
publish the broker never took. Identical bytes from another publisher still
answer: the cache then holds exactly what the waiter published.

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
body and is cached like any other: an empty body is never a valid message,
and `binding.md` defines `404` for a topic with no message, so a `GET` of
either answers the same way. A foreign publisher's non-retained empty
message therefore reads as `404` even while the broker still holds that
topic's own retained message; see [`docs/backlog.md`](backlog.md).

A broker clears the retain flag on messages it forwards to an established
subscription, so the bridge does not see a retained delete as a delete: it
caches the empty payload in place of the message, and the cache entry only
goes away when the connection is remade and the cache is rebuilt.

A `GET` of a topic whose cached payload is empty is `404`, not a `200` with an
empty body, because an empty body is not the JSON a `200` promises and a
client parsing it gets a syntax error instead of a missing message. That makes
the two ways a retained delete can be seen — live, and at reconnect — answer
the same.

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

Each is reported once per change: an error is reported only when it is not
the one already reported, and a successful subscription clears what was — a
subscribe refusal goes through the same check, so one that recurs on every
reconnect prints once rather than on every retry. The disconnect itself is
also reported once rather than on every failed retry, and the disconnect a
shutdown causes is not reported at all. A broker that is simply not there is
retried every two seconds, and printing each failure was 43,000 lines a day
saying the same thing.

The broker is named in those lines by protocol, host, and port only.
`mqtt.connect` accepts credentials in the URL, so printing `MQTT_URL`
verbatim put a password in the log of every service that ran the bridge;
`brokerLabel` in `src/config.js` is what every line uses instead.

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

`tlsCert` and `tlsKey` are read once at startup, then watched: certbot
renews every 60 days against a 90-day certificate lifetime, so a bridge
left running has to pick up the renewed pair without a restart. On a
change, `watchCertFiles` in `src/embedded-broker.js` debounces for a
second, rereads both files, and calls `server.setSecureContext({ cert,
key })`; a failed read or call is logged and the running context is kept,
since a debounce firing mid-write can catch a truncated file. Certbot
replaces the live symlink's target rather than editing it in place, so the
watch covers each path's directory and its resolved target's directory,
re-resolving after every reload to follow the renewal into a new archive
file.

## One token store shared by HTTP and MQTT

`src/token-store.js`'s `createTokenStore` is the only mutable piece of
config: everything else in `src/config.js` is read once at startup and
never changes. `bin/mqtt-http-bridge.js` builds one store and passes it to
both `createBridge` (the HTTP bearer check and `POST /auth/rotate`) and
`startEmbeddedBroker` (the MQTT `authenticate` hook), so a rotation through
either path is visible to both immediately — there is exactly one current
token, not two copies that can drift. `authenticate` calls `tokens.digest()`
inside the hook itself rather than closing over a value captured at start,
which is what makes a rotation take effect for the very next `CONNECT`
without restarting the embedded broker. The store caches the SHA-256 digest
of the current token alongside it and updates both together in `rotate()`,
so the HTTP and MQTT checks (`src/auth.js`'s `tokenMatches`) hash only the
incoming credential per request, not the expected token as well.

With `AUTH_TOKEN_PATH` set, `rotate()` also writes the new token to that
file (write-to-`.tmp`-then-`rename`, so a crash mid-write can't leave a
truncated file that locks an operator out at the next boot), and the store
reads it back at construction, ahead of `AUTH_TOKEN`. Without a path, a
rotated token is memory-only and does not survive a restart.

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

On `SIGINT` or `SIGTERM`, `bin/mqtt-http-bridge.js` runs one `async`
handler: close every open SSE stream, `await` the HTTP server closing, wait
for in-flight publishes to clear, `await broker.end()`, then
`await embedded?.close()`, and exit `0`. A `shuttingDown` flag makes a
second signal during that chain a no-op rather than a second teardown
racing the first.

`httpServer.close()` waits for all open connections to end before its
callback fires; an SSE stream is a connection held open indefinitely, so
closing the server first would hang for as long as any client stays
connected. Closing the streams first is what makes shutdown complete at
all. Measured with one SSE stream attached, the process exits about 20 ms
after the signal.

A `POST` still awaiting `broker.publish` when the HTTP server closes is not
otherwise answered before `broker.end()` cuts the connection its echo needs.
`createBridge` exposes `waiting()` (`broker.waiting()`, the pending-echo
count) so the handler can poll it and wait, up to one `ECHO_TIMEOUT_MS`,
for it to reach zero before ending the broker. A publish still in flight at
that deadline gets its own `503` from the existing echo-timeout path in
`src/broker.js` once the broker is gone, rather than the socket being
dropped with no status.

A `setTimeout(...).unref()` watchdog is armed before any of this starts and
calls `process.exit(1)` if the chain has not finished within
`ECHO_TIMEOUT_MS` plus a few seconds of margin. Without it, an `await` that
never resolves — `httpServer.close()` on a server with an untracked open
connection, say — turns into a hang instead of a nonzero exit, which is a
process supervisor's cue to keep the wedged process running rather than
restart it. `unref()` keeps the timer from being the reason the event loop
stays alive once the real teardown finishes first.

In `src/embedded-broker.js`, `close()` tracks every socket the `net`/`tls`
server accepts in a `Set`, removing each on its own `close` event. `close()`
calls `server.close()` first — which will not call back until every socket
the server tracks has closed, but does not block on that call itself — then
`aedes.close()`, then destroys whatever is still in the set once `aedes`
finishes. A socket that never sends `CONNECT` is not an aedes client, so
`aedes.close()` alone cannot be relied on to end it, and `server.close()`
would otherwise wait on it forever.
