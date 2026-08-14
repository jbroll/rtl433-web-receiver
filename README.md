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
    pio device monitor

## Use

The mDNS name is `MDNS_PREFIX` plus the low three bytes of the MAC, so two
boards on one network do not collide. It is printed at startup along with the
IP address: `mDNS started: rtl433-a1b2c3.local`.

WiFi is not required to decode. If it is unavailable the sketch keeps decoding
and logging to serial, and retries every 30 seconds, though the first connect
attempt times out after 20 seconds before the receiver starts.

## The HTTP surface

The receiver serves the source-only subset of the
[HTTP binding for MQTT](../mqtt-http-bridge/docs/binding.md): stable
`<source>/<model>/<id>` topics, the rtl_433 message as the payload, and an alias
at every level.

| Request | Returns |
|---|---|
| `GET /` | the live page: a card dashboard, a device table, and a raw log, behind tabs; the page opens on Cards |
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

## Cards

Cards is the tab the page opens on. It lays every device whose card is checked
in the device table on a grid of square cells. Two number inputs in edit mode
set the columns and rows, 6 × 4 by default and
1–24 each; the cell side is whichever of width ÷ columns and height ÷ rows
is smaller, so the grid fits on screen with margin on the other axis.
Nothing narrows the default for a small screen, so a phone gets the full
6 × 4 grid of very small cells until the user sets smaller numbers.

A card spans whole cells. On first detection it is sized to hold its
visible readings one per cell, in the most compact rectangle: one reading
gives 1×1, three or four give 2×2, seven through nine give 3×3. Dragging
the corner handle in edit mode resizes it, snapped to whole cells, from
1×1 up to the grid's own dimensions. Type size follows the measured cell,
so a bigger card reads bigger, and shrinks further where a reading is too
wide to fit at that size. Every reading on a card takes the same size, the
one its widest needs. Cards that do not fit in the set number of rows
render below the fold.

Layout is per browser, in localStorage under `rtl433.cards.v2`: the grid size,
the card order, which cards are hidden, and per card a size in cells, the value
order, and which values are hidden or at the bottom. No name is stored there;
a card's name is the published alias, or the device's key if none is set.
Layout is never sent to the device, so two browsers can arrange the same
receiver differently.

A card the user showed or renamed is kept even after its device goes quiet, so a
sensor that returns finds its card as it left it. A card that was never shown is
dropped once its device is gone from the table, which is what keeps a band full
of one-off false decodes from growing the stored layout without limit.

Forget layouts, in edit mode, clears the lot after a confirmation prompt. The
devices on screen at the time keep their cards; only ones seen afterwards start
hidden.

## The receiver's own card

The firmware records itself as a device named `Receiver` once a minute, so the
page renders it with everything it already does for a sensor. It is the one
device that starts with its card shown, since it cannot be a false decode.

| Field | Source |
|---|---|
| `temperature_C` | ESP32-S3 die, `temperatureRead()`. Runs well above ambient with WiFi up |
| `radio_C` | SX1231 die. RadioLib returns the register negated and uncalibrated; `RADIO_TEMP_OFFSET` (91) corrects it, and the part is only good to ±5 °C, so read it as a trend |
| `noise_dBm` | `rtl_433_ESP::averageRssi`, the receiver task's mean RSSI. Absent until it has averaged its first batch |

| `heap_kB` | `ESP.getFreeHeap()` |

The card's corner reading is the WiFi RSSI rather than a decode's. The receiver
takes one of the 24 device slots, and it is the only device keyed on its model
alone, with no id.

Reading the radio's temperature parks it in standby, so the sketch stops
reception, reads the register directly with a bounded poll, restarts reception
with `receiveDirect()`, and re-enables the interrupt. RadioLib's own
`getTemperature()` is not used: it polls without a bound, and a lost SPI
transaction there would hang the loop with the radio deaf. The read is skipped
while RSSI is above the decode threshold or within `RECEIVER_QUIET_MS` of the
last decode, rather than cutting a signal in half; a skipped read repeats the
previous value, and the field is absent until the first one succeeds.

The record does not enter the raw log or the decode count: `signal_store::record`
takes `isDecode=false` for it, and the page recognises its topic's model
segment, `Receiver`, and skips the Log tab entry it would otherwise add.
`RECEIVER_TELEMETRY_MS` sets the interval.

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

The browser page has its own tests. `npm install` once, then `npx playwright
test`. `test/harness.js` extracts the same PROGMEM literals the firmware serves
and implements the HTTP binding — `GET` and `POST` of a topic, `/events` with
filters and a retained replay — so the tests run without a board.
