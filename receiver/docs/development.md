# Development

## Layout

```
WebReceiver.ino            entry point: setup loop, decode dispatch
platformio.ini             build config, radio pin map, OOK settings
load_env.py                .env -> -D build flags
signal_store.cpp/.h        last message and alias storage
web_ui.cpp/.h              HTTP and SSE surface
topic.cpp/.h               topic and filter matching, no Arduino dependency
radio_health.cpp/.h        radio health monitoring and recovery
device_hooks.cpp/.h        per-decode field checks
health_store.cpp/.h        receiver health state
tz_store.cpp/.h            GMT offset storage
monitor.py                 headless serial monitor
test/                      host topic tests, binding spec, fixtures
docs/                      these pages
```

## Serial monitor

`pio device monitor` needs an interactive terminal, so it fails when run through
a pipe or from a non-interactive session. Use `monitor.py` instead:

    python3 monitor.py

Run for a fixed duration, timestamp lines, and suppress startup noise:

    python3 monitor.py --duration 30 --timestamp --quiet

`monitor.py` auto-detects the first USB serial port and reads the baud rate from
`platformio.ini`. Pass `--port` and `--baud` to override. It resets the board on
connect by default; use `--no-reset` to leave it running.

## Testing without a radio

Uncomment `'-DFAKE_SIGNALS=true'` in `platformio.ini`. The sketch injects a
synthetic decode every 3 seconds and runs `signal_store::selfTest()` at startup,
printing a PASS/FAIL line per check over serial.

Set `'-DFAKE_RADIO_FAIL_MS=900000'` (15 minutes) to exercise the recovery
path: the synthetic decode stops and the health state moves to `silent` +
`pinned` (floor pinned below threshold), triggering a soft re-init after the
window closes and again on the backoff, without a reboot — a pinned chip is
stuck and survives a reboot.

`topic.cpp` has no Arduino dependency and is host-tested: `bash test/host/run.sh`
compiles and runs it on the host.

`test/binding.spec.js` covers the HTTP binding against `test/binding-server.js`, a JS
model of the same surface, so it runs without a board: `npm install` once, then `npx
playwright test`. The dashboard has [its own suite](../../dashboard/README.md).
