# rtl433-web-receiver

An ESP32-S3 with an SX1231/RFM69 radio at 433.92 MHz. It decodes 433 MHz sensors
with [rtl_433_ESP](https://github.com/NorthernMan54/rtl_433_ESP), joins WiFi, and
serves a page listing every signal it hears, updating as they arrive.

## Requirements

An ESP32-S3 and an SX1231/RFM69 radio module, wired as below.

The library dependency is a fork,
[jbroll/rtl_433_ESP](https://github.com/jbroll/rtl_433_ESP) branch
`sx1231-support`, which adds SX1231/RF69 receive support upstream does not have.
`platformio.ini` points at it and PlatformIO fetches it on the first build.

Node 22 or newer. `pio run` runs `dashboard/build.js` to generate the page it serves,
so run `npm install` in `../dashboard` before the first `pio run` — its `build.js`
imports `esbuild` from `dashboard/node_modules`.

## Wiring

| Signal | GPIO |
|---|---|
| MISO | 1 |
| MOSI | 42 |
| SCK | 41 |
| CS (NSS) | 40 |
| RST | 39 |
| DIO0 (IRQ) | 38 |
| DIO1 | 47 |
| DIO2 (data) | 21 |

DIO2 carries the demodulated data and is the pin the decoder reads. Change the
`RF_MODULE_*` values in `platformio.ini` to match your board.

## Configure

    cp .env.example .env

Fill in `WIFI_SSID`, `WIFI_PASSWORD`, and `MDNS_PREFIX`. `.env` is bash
syntax, gitignored, and read by `load_env.py`, which turns each entry into a
`-D` build flag. The build stops with an `#error` if it is absent.

The radio pin map and OOK settings are in `platformio.ini`.

## Build and flash

    pio run -e esp32s3-generic
    pio run -e esp32s3-generic -t upload

## Serial monitor

`pio device monitor` needs an interactive terminal, so it fails when run through
a pipe or from a non-interactive session. Use `monitor.py` instead:

    python3 monitor.py

Run for a fixed duration, timestamp lines, and suppress startup noise:

    python3 monitor.py --duration 30 --timestamp --quiet

`monitor.py` auto-detects the first USB serial port and reads the baud rate from
`platformio.ini`. Pass `--port` and `--baud` to override. It resets the board on
connect by default; use `--no-reset` to leave it running.

## Use

The mDNS name is `MDNS_PREFIX` plus the low three bytes of the MAC, so two
boards on one network do not collide. It is printed at startup along with the
IP address: `mDNS started: rtl433-a1b2c3.local`.

WiFi is not required to decode. If it is unavailable the sketch keeps decoding
and logging to serial, and retries every 30 seconds, though the first connect
attempt times out after 20 seconds before the receiver starts.

## The HTTP surface

The receiver serves the source-only subset of the
[HTTP binding for MQTT](../bridge/docs/binding.md): stable
`<source>/<model>/<id>` topics, the rtl_433 message as the payload, and an alias
at every level.

| Request | Returns |
|---|---|
| `GET /` | the [dashboard](../dashboard/README.md), gzipped |
| `GET /<topic>` | the stored message, `Content-Type: application/json`; `404` if there is none |
| `POST /<topic>` | store an alias, `204`; `405` unless the topic is an `$alias` under this receiver's source |
| `GET /events?f=…` | SSE stream; each frame's `data` is `{"topic":…,"payload":…}`, with a `:keepalive` comment every 15 s |

`source` is the mDNS name, `rtl433-a1b2c3`. The receiver's own telemetry is
`rtl433-a1b2c3/Receiver/0`, and a device with no id and no channel uses `0` too.

Every stored message carries `time` (ISO 8601 UTC, from SNTP), `rssi`, and
`count`, stamped in by the receiver. Until the clock is set `time` is absent and
the page ages that device from when it arrived.

`build` rides on the telemetry message. The page keeps the first id it sees and
reloads itself when a later one differs, so a reflash reboots the device, the
stream reconnects, and every open browser picks up the new page.

See [docs/user-manual.md](docs/user-manual.md) for the routes, their statuses,
and the filter syntax, and [docs/architecture.md](docs/architecture.md) for the
module boundaries and the replay design.

## The page

The receiver serves a build of the [dashboard](../dashboard/README.md). See
[its user manual](../dashboard/docs/user-manual.md) for the tabs, the card
grid, and edit mode, and [docs/architecture.md](docs/architecture.md) for the
receiver's own card and its telemetry fields.

## Limits

- 24 devices tracked; a new decode evicts the least recently seen device once
  the table is full, and a slot unheard from for `DEVICE_STALE_HOURS` (72 by
  default, `0` to disable) is freed on its own. Weather sensors transmit every
  16–60 seconds, so the default only clears a genuinely dead one. Raise it if
  you receive TPMS, which is silent while a car is parked, or door contacts and
  remotes, which transmit only when triggered.
- payloads up to 600 bytes; a longer one is dropped rather than truncated
- 32 aliases
- 4 concurrent SSE clients, each subscribing up to 4 filters; a fifth client
  evicts the longest-attached one, whose browser reconnects on its own

## Testing without a radio

Uncomment `'-DFAKE_SIGNALS=true'` in `platformio.ini`. The sketch injects a
synthetic decode every 3 seconds and runs `signal_store::selfTest()` at startup,
printing a PASS/FAIL line per check over serial.

`topic.cpp` has no Arduino dependency and is host-tested: `bash test/host/run.sh`
compiles and runs it on the host.

`test/binding.spec.js` covers the HTTP binding against `test/binding-server.js`, a JS
model of the same surface, so it runs without a board: `npm install` once, then `npx
playwright test`. The dashboard has [its own suite](../dashboard/README.md).
