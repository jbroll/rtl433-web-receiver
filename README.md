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

## Pages and endpoints

| Path | Returns |
|---|---|
| `/` | the live page: a device table, a raw log, and a card dashboard, behind tabs |
| `/api/state` | snapshot of the device table and event ring |
| `/events` | SSE stream; each `signal` event's `data` is JSON with `at`, `now`, `key`, `rssi`, `count`, and `payload`; a `:keepalive` comment every 15 s |
| `/api/status` | uptime, free heap, WiFi RSSI, IP, total decodes, dropped count |

The page loads `/api/state`, then applies `signal` events as they arrive. On
reconnect it re-fetches `/api/state`, so a missed event cannot leave the table
stale.

Payloads are truncated to 512 characters and carried as JSON strings, so a
truncated payload cannot break a response. The page shows the raw text when it
does not parse. 512 is the size of the library's own message buffer, so a real
decode is never cut; a shorter cap silently strips the trailing fields rtl_433
appends and leaves the page with unparseable JSON.

The reading column shows every field in the payload except the metadata
rtl_433 adds (`model`, `id`, `channel`, `protocol`, `rssi`, `duration`, `mic`,
`message_type`, `sequence_num`, `time`). Readings accumulate per device: an
Acurite 5n1 splits its data across two message types, so a row keeps what
earlier messages reported rather than showing only the latest half. A value can
therefore be older than the age column, which tracks the newest message.

## Cards

The Cards tab shows each tracked device as a card. The pencil button opens edit
mode, where cards drag to reorder, values drag to reorder within their card,
clicking a value hides it, ✕ hides the card, the ▭ button cycles square,
horizontal, and vertical, and double-clicking the label renames it. Values lay
out in a grid that fills the card and grow as fewer of them share a card and as
the card grows. A long device name in the label ellipsizes rather than
overflowing the card; readings round to one or two decimal places for display,
without changing the stored values.

Layout is per browser, in localStorage under `rtl433.cards.v1`. It is never
sent to the device, so two browsers can arrange the same receiver differently.
Layouts are never dropped on their own, so a sensor that goes quiet and returns
keeps its card. Forget layouts, in edit mode, clears them all.

## Limits

- 24 devices tracked; a new decode evicts the least recently seen device once
  the table is full, and a slot unheard from for `DEVICE_STALE_HOURS` (72 by
  default, `0` to disable) is freed on its own. Weather sensors transmit every
  16–60 seconds, so the default only clears a genuinely dead one. Raise it if
  you receive TPMS, which is silent while a car is parked, or door contacts and
  remotes, which transmit only when triggered.
- 40 events retained on the device, 200 in the browser
- payloads kept whole up to 512 characters
- 4 concurrent SSE clients; a fifth evicts the longest-attached one, whose
  browser reconnects on its own

## Testing without a radio

Uncomment `'-DFAKE_SIGNALS=true'` in `platformio.ini`. The sketch injects a
synthetic decode every 3 seconds and runs `signal_store::selfTest()` at startup,
printing a PASS/FAIL line per check over serial.

The browser page has its own tests. `npm install` once, then `npx playwright
test`. `test/harness.js` extracts the same PROGMEM literals the firmware serves
and serves them with a mock `/api/state` and `/events`, so the tests run
without a board.
