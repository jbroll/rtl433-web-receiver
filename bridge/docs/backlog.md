# Backlog

- Caching every topic through a `#` subscription does not scale to a busy
  broker. See [`docs/architecture.md`](architecture.md#caching-everything).
  `MAX_SSE_CLIENTS` and `MAX_SSE_FILTERS` bound what the cache costs to serve,
  which relieves part of the pressure without changing the cache itself.
- Clearing the cache on reconnect is invisible to an SSE subscriber: it is
  told nothing about the topics that went away, and the ones that come back
  arrive as ordinary messages, so a subscriber is re-sent every matching
  retained topic on every reconnect whether or not its value changed. See
  [`docs/user-manual.md`](user-manual.md#get-events--subscribe). The cheaper
  half is now available: the frame carries a `deleted` field, so a reconnect
  could tell a subscriber which topics went away rather than leaving it to
  infer them. The full fix is rejected. It means the bridge tracking, per
  subscriber, which topic-value pairs that subscriber has already seen, which
  is the per-client server-side state
  [`docs/architecture.md`](architecture.md#filters-are-fixed-per-connection)
  rules out so the receiver can implement the same binding.
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
  message comes back and matches the bytes still waiting. Closing it needs
  QoS 1 and a match on the packet identifier, which changes both the contract
  with the broker and the cache-write ordering the rest of the design rests
  on: the broker is the only cache writer because the echo is what confirms a
  publish.
- A `500` is still possible for an error the bridge does not foresee. The
  binding defines no such status; reaching it is a bug, not a contract.
  `binding.md` should say that an implementation may answer `5xx` for its own
  faults, so a client is not written against a status list that cannot hold.
- A retained message deleted while the bridge is connected stays in the cache
  as an empty message until the next reconnect, because the broker clears the
  retain flag on what it forwards and the delete is indistinguishable from an
  ordinary empty message. `GET` correctly 404s either way, but the cache holds
  the empty payload rather than a missing entry until the next reconnect
  rebuilds it from the broker's actual retained set.
- `cacheMessage` in `src/broker.js` marks any non-retained empty message that
  follows real content as `deleted: true`, the same as a genuine retained
  delete, because the only signal it has is whether the cache held content
  just before. An ordinary empty message in that position is mislabeled a
  deletion on the wire; MQTT 5's retain-as-published subscription option
  would tell them apart, at the cost of requiring an MQTT 5 broker (`aedes`
  is MQTT 3.1.1 only).
- `test/helpers/bridge.js` builds the bridge in one synchronous step, so it
  cannot reproduce the startup ordering the `bridge?.broadcast` guard in
  `bin/mqtt-http-bridge.js` exists for. That guard is untested. The `ending`
  guard on the broker's `error` handler in `src/broker.js` is untested for
  the same kind of reason: removing it fails no test, and the out-of-process
  timing it guards against could not be reproduced to write one.
- A foreign publisher's non-retained empty message caches like any other
  message, so `GET` answers `404` for a topic whose retained message the
  broker still holds. It stays masked until the next reconnect rebuilds the
  cache from the broker's actual retained set. See
  [`docs/architecture.md`](architecture.md#payloads-stay-bytes).
