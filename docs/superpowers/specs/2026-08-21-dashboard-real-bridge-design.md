# Dashboard suite over the real bridge

Goal 4 item (ROADMAP.md): drive the dashboard test suite against the real
`bridge/` over an in-process `aedes` broker, instead of
`receiver/test/binding-server.js`, a JS model of the receiver's own HTTP
binding invented for the dashboard suite.

## Why

`bridge/` ships as its own sub-project; the dashboard suite has never run
against it. `binding-server.js` models receiver-firmware behavior the
generic bridge doesn't implement (per-`message_type` retained replay,
alias/tz-only POST restriction) — the suite has been testing a fake that
diverges from what actually ships between the dashboard and a bridge.

## Scope

In scope:
- `bridge/test/helpers/dashboard-fixture.js` (new) — bundles
  `startEmbeddedBroker` + `createBridge` + an `mqtt` publisher client behind
  one `startTestBridge()` export, test-helper code only, no behavior change
  to `bridge/src/*`.
- `dashboard/test/harness.js` — `startServer()` rewritten to use
  `startTestBridge()` instead of `binding-server.js`. `startPage()`
  (serves the built dashboard HTML) is unchanged.
- `dashboard/test/android-smoke.js` — same swap for its inline
  `binding-server` usage.
- `dashboard/docs/backlog.md`, `docs/backlog.md`, `ROADMAP.md` — drop the
  now-resolved cross-cutting-debt line once done.

Out of scope:
- The ~20 `.spec.js` files: unchanged. They only call `emit`, `emitAlias`,
  `get`, `tzOffset()`, `setBuild`, `url`, `source`, `close` — never `post`
  or `options` directly (confirmed by grep) — and the new `startServer()`
  preserves that exact shape.
- `receiver/test/binding-server.js` and `receiver/test/binding.spec.js`:
  untouched. `binding.spec.js` is `binding-server.js`'s own compliance
  suite, validating it as a host-testable model of the receiver firmware's
  documented HTTP binding (`receiver/docs/user-manual.md`) — a different
  purpose than the dashboard fake, unrelated to this goal.
- `bridge/src/*`, `receiver/*` firmware: no behavior changes.
- Testing real firmware against this broker: not possible today — the
  receiver has no MQTT client code (a separate, unimplemented feature this
  goal doesn't touch), and this fixture is scoped to spin up in-process per
  test run on a random loopback port, not to stand as a reachable service.

## Design

### `bridge/test/helpers/dashboard-fixture.js`

```
export async function startTestBridge(opts = {}) {
  const broker = await startEmbeddedBroker({ mqttPort: 0 })
  const cache = createCache()
  const brokerConn = connectBroker({ url: broker.url, cache, onMessage: () => {} })
  const bridge = createBridge({ broker: brokerConn, cache, authToken: opts.authToken })
  // http.createServer(...).listen(0, '127.0.0.1') for bridge.httpServer
  const publisher = mqtt.connect(broker.url)
  await brokerConn.subscribed
  return {
    url: `http://127.0.0.1:${httpPort}/`,
    publish(topic, json) { /* publisher.publish(topic, json, {retain:true}), then poll GET until visible */ },
    get(topic) { /* raw http GET against url+topic */ },
    close() { /* publisher.end(), httpServer.close(), bridge broker conn end(), broker.close() */ },
  }
}
```

`publish()` waits for the message to actually be visible via the bridge's
own `GET` before resolving — the harness's publisher is a separate MQTT
client from the bridge's internal one, so nothing else guarantees ordering
between "publish returned" and "the bridge's cache reflects it." Same
concern `bridge/src/broker.js`'s own `echo()` solves for HTTP `POST`, solved
here by polling instead of instrumenting the broker.

### `dashboard/test/harness.js`

`startServer(opts)` becomes:
- Start `startTestBridge()`.
- Local `counts` Map, `rainBaselines` Map, `tzOffset` handling stay as
  harness-side JS — ported verbatim from `binding-server.js`'s `put()` /
  `applyRainHook()` (receiver-side computation with no home in `bridge/`).
- `emit(payload, meta)`: compute the stamped JSON exactly as today, then
  `fixture.publish(topic, json)`.
- `emitAlias(topic, name)`: `fixture.publish(topic + '/$alias', JSON.stringify(name))`.
- `get(topic)`: `fixture.get(topic)`.
- `tzOffset()`: `fixture.get(source + '/$tz')`, parsed — no separate local
  state; this reads back whatever the dashboard's own POST wrote, through
  the same cache path production uses.
- `setBuild(id)`: unchanged, local variable feeding future `emit()` calls.
- `post`/`options`: dropped — never called by any spec (confirmed by grep).
- `close()`: tears down the fixture.

Returned shape (`url`, `source`, `emit`, `emitAlias`, `get`, `setBuild`,
`tzOffset`, `close`) matches today's exactly, so no spec file changes.

### `dashboard/test/android-smoke.js`

Same replacement of its inline `binding-server` require with the new
harness's `startServer`.

## Dropped behavior

- Multi-`message_type` retained replay on one topic: firmware-specific,
  not implemented by the generic bridge (`bridge/docs/binding.md`: "a
  bridge stores the last message published to a topic," singular). No
  dashboard spec exercises it (confirmed by grep for `message_type` usage).
- 405 on POST to a non-alias/non-tz topic: bridge has no such restriction;
  POST to any valid topic publishes it. Not tested by any dashboard spec.

Both are still covered where they belong: `receiver/test/binding.spec.js`
against `binding-server.js`, unchanged.

## Testing

- `node --test test/*.test.js && playwright test` in `dashboard/` — same
  command, now exercising the real bridge underneath every spec.
- No new test files; existing specs are the coverage.

## Risks

- Publish-then-poll in `fixture.publish()` adds latency per `emit()` call
  versus the old synchronous in-process write. Acceptable: `playwright test`
  already runs serially (`workers: 1`) and per-test timeouts (15s) have
  headroom; watch actual suite runtime after the swap.
