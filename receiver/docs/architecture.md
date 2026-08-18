# Architecture

## Module boundaries

**`topic.h` / `topic.cpp`** — topic and filter parsing, with no Arduino
dependency, so it is the one module `test/host/run.sh` compiles and runs on
the host rather than only under PlatformIO. It mirrors
`mqtt-http-bridge/src/topic.js`, the bridge's own implementation of the same
rules, so the two agree on what a valid topic or filter looks like without
sharing code.

**`alias_store.h` / `alias_store.cpp`** — a fixed table of 32 topic/name pairs,
persisted as one JSON blob in a single `Preferences` entry (namespace `alias`,
key `map`), capped at 2 KB. NVS keys are limited to 15 characters and an alias
topic runs to 96 bytes, which rules out one NVS key per alias; the blob is
rewritten whenever an alias changes, a user action and rare enough that
rewriting the whole table each time costs nothing worth avoiding.

**`signal_store.h` / `signal_store.cpp`** — 24 device slots holding metadata
(key, last-seen time, message count), with payloads in a shared 32-entry
sub-table (`SIGNAL_SUB_TABLE`) keyed by `(slot, message_type)`. A typical
single-type device uses one sub; a splitter, one emitting several
`message_type`s, uses one per type. A monotonic `_seq` counter, not
`lastSeen`, orders and evicts slots, because `lastSeen` is `millis()` and
wraps every 49.7 days while `_seq` only ever increases; the same counter
orders a device's subs, newest first. `claimSlot()` evicts the slot with the
lowest `_seq` once the table is full. `sweepStale()` frees a slot unheard
from for longer than `DEVICE_STALE_HOURS`, comparing with unsigned
subtraction so it stays correct across a `millis()` wraparound too. It also
sweeps a sub unheard from for longer than `SUB_STALE_MS` (1 hour), and frees
the slot once its last sub is gone.

`record()` stamps `time`, `rssi`, and `count` into the decoded JSON before
serialising it into the sub for that `message_type`. `SIGNAL_PAYLOAD_MAX` is
600 bytes against the library's own 512-byte message buffer, room for the
roughly 56 bytes the three stamped fields add. A message that still doesn't
fit is dropped rather than truncated: the SSE frame embeds a device's payload
as the JSON object it
already is, not as an escaped string, so a payload cut mid-object would put
unparseable JSON on the wire. Truncating and then fixing up the JSON is not
attempted; dropping the message and counting it in `droppedCount()` is
simpler.

**`web_ui.h` / `web_ui.cpp`** — the HTTP and SSE surface. Only `/` and
`/events` are registered routes; every topic is an arbitrary path, so `GET`
and `POST` of a topic are both dispatched from `WebServer::onNotFound`, which
does its own topic validation rather than relying on route matching. Four SSE
client slots (`WEB_UI_SSE_CLIENTS`), each a `WiFiClient` plus up to four
filters and one replay cursor, are fixed arrays sized at compile time — there
is no dynamic connection list.

## The page the firmware serves

`GET /` answers with a gzipped byte array in PROGMEM, generated at build time by
`build_dashboard.py`, which runs `node ../dashboard/build.js --progmem` into
`$BUILD_DIR/generated/dashboard_html.h`. Node is therefore a requirement for `pio run`;
it was already one to run the tests.

The array is served with `Content-Encoding: gzip` through the same chunked-write budget
every other response uses, so a slow reader is dropped rather than stalling `loop()`.
There is no uncompressed fallback: every browser that can run the page sends
`Accept-Encoding: gzip`.

The two PROGMEM literals it replaced were 36,819 bytes. Measured as a linked-size
difference with `pio run -e esp32s3-generic` across the commit that made the change:
1,184,653 bytes before, 1,156,725 after, a difference of 27,928.

Those percentages, and the ones this file used to quote, were of Arduino's `default.csv`
`app0` at 1.25 MB. `partitions.csv` now gives `app0` 4 MB of the 16 MB chip, so the page
costs a share of that instead: 42,352 bytes of an image at 28.4%.

## The partition table

`board_build.partitions = partitions.csv` in `platformio.ini`. `board = esp32s3box`
declares 16 MB and the chip reports 16 MB, but Arduino's `default.csv` addresses only the
first 4 MB, which is why the app read as nearly full while using 7% of the flash.

| Partition | Type | Offset | Size |
|---|---|---|---|
| `nvs` | data | `0x9000` | 20 KB |
| `otadata` | data | `0xe000` | 8 KB |
| `app0` | app | `0x10000` | 4 MB |
| `app1` | app | `0x410000` | 4 MB |
| `spiffs` | data | `0x810000` | 7.875 MB |
| `coredump` | data | `0xff0000` | 64 KB |

`nvs`, `otadata` and `app0` keep the offsets they have in every Espressif layout, and
they have to: espressif32@6.1.0 uses this file only to generate the table at `0x8000`
and writes the application at a hardcoded `0x10000` regardless. A table that moves
`app0` leaves it blank and the board boot-loops, and erasing flash does not help
because the app was never written where the table points. Check the upload log's
`Wrote ... at 0x` lines against the CSV before trusting a new table, and read the boot
with `monitor.py --baud 115200`: the application talks at 921600 and prints nothing when
it never gets that far, so only the ROM bootloader's output shows the fault.

20 KB of `nvs` is about three times what the firmware can put there. Radio calibration
under `phy/cal_data` is the largest entry at ~1,950 bytes; the WiFi credentials in
`nvs.net80211` are a few hundred; the alias map is capped at `ALIAS_BLOB_MAX`, 2 KB.

## Data flow

The decoder runs on `rtl_433_DecoderTask`, not the loop task, so
`rtl_433_Callback` cannot touch `signal_store` or `web_ui` directly — both
assume single-threaded access from `loop()`. The callback instead copies the
message and RSSI into an 8-deep FreeRTOS queue. `loop()` drains it:

    rtl_433_Callback → queue → loop() → signal_store::record() → web_ui::broadcast() → subscribers

`record()` returns whether the message was stored. On success, `loop()` calls
`signal_store::device(0)` — the freshest device in recency order — and passes
it to `broadcast()`, which builds one SSE frame and sends it to every
subscriber whose filters match and whose replay cursor has already passed
that device's newest sub.

## The replay design

Writing all 32 stored payloads to a newly connected socket in one pass would
overflow the socket's send buffer and get the client dropped, so each SSE slot
carries a replay cursor and `web_ui::loop()` drains at most `REPLAY_PER_LOOP`
(3) frames from it per call, retrying a frame whose socket isn't ready to
write rather than losing it.

The cursor walks flat indices — the sub table (0 through 31,
`SIGNAL_SUB_TABLE`), then the alias table (32 through 63) — rather than
`signal_store::device(i)`'s recency order. `device(i)` re-sorts on every call
and a device's position in it changes the moment it is heard from again, so a
cursor stepping through that order could skip a device that has just moved
ahead of it, or resend one that has moved behind. Flat indices don't move: a
sub's index is fixed for as long as it holds that `(slot, message_type)`
pair, so the cursor visits every retained frame exactly once regardless of
what arrives while it's running. `alias_store`'s table is hole-based for the
same reason — indices survive a remove, so a cursor over it doesn't skip or
repeat an entry either.

While a sub is still ahead of the cursor, a live frame for it is suppressed:
its flat index is `>= _replay[i]`, so the cursor hasn't reached it yet and the
frame will go out (with its now-current payload) when the cursor gets there.
An index the cursor has already passed is not suppressed — that sub won't be
revisited, so its live frame is delivered immediately instead.
`broadcast()` sends the device's newest sub, the one with the highest `seq`.
A device updated after its sub was already sent is therefore never lost, and
a device updated before the cursor reaches it is sent once, not twice.

A sub swept before the cursor reaches it is simply not delivered: `subAt()`
returns `NULL` for a swept sub, `slotAt()` for a slot already freed with it,
and the cursor skips it and moves on. That matches what a subscriber
connecting a moment later would have seen — nothing, since there is no longer
anything retained for that topic.

## Name layering

A display name resolves in three steps, per the binding: the browser's own
configuration for that name first, the published `$alias` next, and the
stable topic segment last. The dashboard keeps its own alias table in
`localStorage`, so in practice it resolves through the first two steps:
`displayName()` is `aliasOf(key) || shortKey(key)`.

When the page is served by the receiver, a rename still posts to `$alias` so
the receiver persists it. When the page is served by a separate broker or
static file server, the source is external and the rename stays in the
browser's `localStorage`.

## The receiver's own card

The firmware records itself as a device named `Receiver` once a minute, so the
page renders it with everything it already does for a sensor. It is the one
device that starts with its card shown, since it cannot be a false decode.
`RECEIVER_TELEMETRY_MS` sets the interval.

| Field | Source |
|---|---|
| `temperature_C` | ESP32-S3 die, `temperatureRead()`. Runs well above ambient with WiFi up |
| `radio_C` | SX1231 die. RadioLib returns the register negated and uncalibrated; `RADIO_TEMP_OFFSET` (91) corrects it, and the part is only good to ±5 °C, so read it as a trend |
| `noise_dBm` | `rtl_433_ESP::averageRssi`, the receiver task's mean RSSI. Absent until it has averaged its first batch |
| `heap_kB` | `ESP.getFreeHeap()` |

The card's corner reading is the WiFi RSSI rather than a decode's. The
receiver takes one of the 24 device slots, and it is the only device keyed on
its model alone, with no id.

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

## The build id

`load_env.py` sets `BUILD_ID` to `git describe --always --dirty --exclude "*"`
at build time. The receiver's telemetry carries it as `build`; the page keeps
the first value it sees and reloads when a later one differs. A rebuild with
no new commit keeps the same id, so uncommitted work needs a manual reload —
the page has no way to tell that binary apart from the one already running.

## The clock

The device has no RTC. `configTime(0, 0, "pool.ntp.org")` runs once on the
first successful WiFi connect and again on every reconnect, so a clock that
drifts while WiFi is down is corrected rather than left stale.
`signal_store::isoTime()` treats a `time()` before 1700000000 (2023-11-14) as
unset and omits the `time` field rather than stamping a wrong one. The page
ages a message from its `time` field when present, parsed with `Date.parse`,
and falls back to the time the frame arrived when `time` is absent or fails to
parse — the two clocks it ever has to work with.
