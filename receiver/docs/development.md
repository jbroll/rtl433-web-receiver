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
wifi_store.cpp/.h          WiFi credential storage
provisioning.cpp/.h        SoftAP captive portal
monitor.py                 headless serial monitor
tools/flash-ota.js         push a firmware image over OTA (`npx flash-ota`)
tools/save_elf.py          post-build hook: saves firmware.elf to tools/elf/$BUILD_ID.elf
tools/fetch_coredump.sh    read and decode a crash dump (tools/coredump.md)
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
connect by default (`--reset` is that default made explicit); use `--no-reset`
to leave it running.

## OTA flash

`POST /$update` (see `docs/user-manual.md`) takes a raw `curl -F`, but
`tools/flash-ota.js` wraps it:

    npx flash-ota rtl433-a1b2c3.local
    npx flash-ota rtl433-a1b2c3.local .pio/build/esp32s3-generic/firmware.bin

Run from `receiver/`, after `pio run` has produced a firmware image. The
token comes from `OTA_TOKEN` in the environment or `.env` (an `export
OTA_TOKEN=...` line is accepted the same as `load_env.py` accepts it for the
firmware build); without one it exits before making a request. On `200` the
device reboots into the new image; any other status is printed and the exit
code is nonzero. An unreachable host prints one line and exits nonzero
instead of a stack trace.

There's no hash returned to check the pushed image against — `Update.end()`
only confirms the write completed at the expected size. To confirm the
device is actually running the image that was pushed, compare its `build`
field against the local tree:

    curl -s http://rtl433-a1b2c3.local/rtl433-a1b2c3/Receiver/0 | grep -o '"build":"[^"]*"'
    git rev-parse --short HEAD

`build` is `git describe --always --dirty --exclude '*'` at compile time
(`load_env.py`), so a `-dirty` suffix there means the pushed image was built
from a working tree with uncommitted changes, not that the push itself
failed.

## Testing without a radio

Uncomment `'-DFAKE_SIGNALS=true'` in `platformio.ini`. The sketch injects a
synthetic decode every 3 seconds and runs `signal_store::selfTest()` at startup,
printing a PASS/FAIL line per check. Under this flag `Log.begin()` points at
`Serial`, the S3's USB CDC device, instead of the `Serial0` hardware UART a
production build uses, so `monitor.py` reads the PASS/FAIL lines without a
UART adapter on the TX pin.

**Do not enable this on a board that has already been provisioned with real
settings.** `alias_store::selfTest()`, `mqtt_publish_store::selfTest()`, and
`layout_store::selfTest()` each end their NVS-backed checks by erasing that
store's real NVS keys and leaving them empty, not restored — a board's saved
aliases, MQTT bridges, and dashboard `$layout` are gone after one boot with
the flag on. `location_store` and `units_store` snapshot and restore the
real `$location`/`$units` values they briefly overwrite, so those two are
safe. Test on a fresh or disposable board, or one whose settings you don't
need back.

Set `'-DFAKE_RADIO_FAIL_MS=900000'` (15 minutes) to exercise the recovery
path: the synthetic decode stops and the health state moves to `silent` +
`pinned` (floor pinned below threshold), triggering a soft re-init after the
window closes and again on the backoff.

`topic.cpp`, `radio_health.cpp`, and `device_hooks.cpp` have no Arduino
dependency (or only ArduinoJson) and are host-tested: `bash test/host/run.sh`
compiles and runs them on the host. `signal_store.cpp` and `alias_store.cpp`
reach further into Arduino, `ArduinoLog`, and (for `alias_store`)
`Preferences`; the same script host-compiles their `FAKE_SIGNALS` selfTest()s
against fakes of those headers in `test/host/arduino_shim/` and runs them too,
so every check above runs on every `bash test/host/run.sh`.

The same shim also fakes `Print`, `WiFiClient`/`WiFiClientSecure`, and
`PubSubClient`, so `mqtt_publish.cpp`'s connection lifecycle — `begin()`'s
matching of dashboard-configured brokers against live connections, teardown
on a removed/changed/TLS-flipped broker, the out-of-memory path in
`setBufferSize()`, and `aliasPayload()`'s JSON escaping — is host-tested by
`test/host/mqtt_publish_test.cpp`, without a broker or a device attached.

`test/binding.spec.js` covers the HTTP binding against `test/binding-server.js`, a JS
model of the same surface, so it runs without a board: `npm install` once, then `npx
playwright test`. The dashboard has [its own suite](../../dashboard/README.md).
