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

## Adding a test

Match the existing file per module: `test/topic.test.js` for
`src/topic.js`, and so on. For anything that talks to a broker, use
`startBroker()` from `test/helpers/broker.js` to get a live one, or
`startBridge()` from `test/helpers/bridge.js` to get a broker and a bridge
already wired together; both return a `close()` to call at the end of the
test.
