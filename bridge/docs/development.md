# Development

## Layout

```
bin/mqtt-http-bridge.js   entry point: config, wiring, shutdown
src/config.js              environment variables -> config object
src/topic.js                filter/topic matching, no I/O
src/cache.js                last message per topic
src/broker.js               the one MQTT connection
src/sse.js                   one SSE stream's lifetime
src/server.js                HTTP routing
test/                        one test file per src module, plus helpers/
```

## Running the tests

```
npm test
```

This runs `node --test test/*.test.js` — no test framework, `node:test` and
`node:assert/strict` only. The glob is deliberate: `node --test` with no
argument treats every file under `test/` as a test, which would include
`test/helpers/`. Naming `test/*.test.js` runs only the actual test files.

`test/helpers/broker.js` starts an `aedes` broker in-process, listening on
an OS-assigned port. Tests that need a broker start one of these instead of
depending on anything external, so the suite needs nothing installed and no
broker running to pass.

Every broker is reached through a TCP proxy the helper puts in front of it,
which can delay traffic or swallow it while leaving the connection open. A
test asks for delay with `startBridge({ delayMs })`, and

```
MQTT_TEST_LATENCY_MS=25 npm test
```

runs the whole suite over a slow link. That is the check that a test passes
by construction rather than because loopback is faster than an HTTP connect;
two SSE tests used to depend on the difference.

The setting is a floor, not an override: a test that asks for `delayMs: 40`
because it needs a message still in flight — the two `POST`s to one topic in
`test/broker.test.js` and `test/http.test.js`, and the late subscriber in
`test/events.test.js` — gets 40 ms, or the setting if it is higher.

## Verifying the build's dependencies

`scripts/build-dashboard.js` calls into `dashboard/build.js`, which imports
`esbuild`. `esbuild` is pinned in the bridge's own `devDependencies`, at the
version `dashboard/package.json` pins, so `npm ci` in `bridge/` alone
resolves it even where `dashboard/node_modules` does not exist yet. Confirm
this after touching `package.json` or `scripts/build-dashboard.js`:

```
cp -r bridge /tmp/bridge-check
cp -r dashboard /tmp/dashboard-check   # same relative position: ../dashboard
rm -rf /tmp/dashboard-check/node_modules
cd /tmp/bridge-check
rm -rf node_modules
npm install
npm run build
```

Expect an `esbuild` bundling error (`Could not resolve "preact"` and
similar), not `ERR_MODULE_NOT_FOUND` for `esbuild` itself — that's the
difference this dependency makes. `dashboard/`'s own runtime dependencies
(`preact`, `@preact/signals`, `pigeon-maps`, and the rest) still need
`npm install` run in `dashboard/`, same as before; run it there and repeat
`npm run build` in `/tmp/bridge-check` to see the full build succeed and
print the output path and byte count. Delete `/tmp/bridge-check` and
`/tmp/dashboard-check` afterward.

## Adding a test

Match the existing file per module: `test/topic.test.js` for
`src/topic.js`, and so on. For anything that talks to a broker, use
`startBroker()` from `test/helpers/broker.js` to get a live one, or
`startBridge()` from `test/helpers/bridge.js` to get a broker and a bridge
already wired together; both return a `close()` to call at the end of the
test. `startBridge({ url })` skips starting a broker and points the bridge at
the given address, which is how the unreachable-broker case is tested.
