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
| `/` | the live page: a card dashboard, a device table, and a raw log, behind tabs; the page opens on Cards |
| `/api/state` | build id and a snapshot of the device table and event ring |
| `/events` | SSE stream; each `signal` event's `data` is JSON with `at`, `now`, `key`, `rssi`, `count`, and `payload`; a `:keepalive` comment every 15 s |
| `/api/status` | uptime, build id, free heap, WiFi RSSI, IP, total decodes, dropped count |

The page loads `/api/state`, then applies `signal` events as they arrive. On
reconnect it re-fetches `/api/state`, so a missed event cannot leave the table
stale.

`build` is `git describe --always --dirty --exclude "*"` at compile time, set by
`load_env.py`. The exclude suppresses tag names, so the id is always the
abbreviated commit hash. The page keeps the id its first fetch returned and reloads
itself when a later one differs, so a reflash reboots the device, the stream
reconnects, and every open browser picks up the new page. A rebuild with no new
commit keeps the same id, so uncommitted work needs a manual reload.

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

A new device gets no card. The Card checkbox is how it gets one, and it is the
same setting as ✕ on the card in edit mode, so a device hidden either way is
unchecked here. Decodes from protocols nobody owns arrive on any 433 MHz
receiver, and this keeps them off the dashboard.

The Alias box names that device's card, the same name double-clicking the card
label sets. Emptying it puts the key back. The table rebuilds every second but
holds still while a text box or a select in it has focus, so an entry in
progress is never interrupted. Only the tab on screen is rebuilt; switching to
one draws it.

Under each device is one row per reading, carrying that reading's current value
and its display mode. This is where a card's contents are chosen; the card's own
edit mode only arranges what is already there.

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

Every value has three display modes, set from its row in the device table.
Shown puts it in the card body at full size. Bottom puts it small and labelled
along the bottom-left edge, mirroring the age at bottom-right, which is where a
battery flag belongs. Hidden drops it. rtl_433's status fields (`battery_ok`,
`test`, `tamper`, and the rest) start at the bottom; everything else starts
shown.

The pencil button opens edit mode, which arranges the card and nothing else:
cards drag to reorder, values drag to reorder within their card, the corner
handle resizes, ✕ hides the card, and double-clicking the label renames it. A
card shows the same values in edit mode as out of it; what appears is the card's
own controls, and hidden cards as ghosts. A long device name in the
label ellipsizes rather than overflowing the card; readings round to one
or two decimal places for display, without changing the stored values.

Layout is per browser, in localStorage under `rtl433.cards.v1`: the grid size,
the card order, which cards are hidden, and per card a name, a size in cells,
the value order, and which values are hidden or at the bottom. It is never sent
to the device, so two browsers can arrange the same receiver differently.

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

The record does not enter the raw log or the decode count, on the device or in
the browser: its SSE frame carries `"log":0` and the page applies it to the
device without logging it. `RECEIVER_TELEMETRY_MS` sets the interval.

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
