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
Its `FAKE_SIGNALS` `selfTest()` is host-tested by `test/host/run.sh` against
`test/host/arduino_shim/`'s fakes of `Arduino.h`, `ArduinoLog.h`, and
`Preferences.h` (an in-memory map standing in for NVS).

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
serialising it into the sub for that `message_type`. Up to `SIGNAL_MAX_HOOKS`
(2) record hooks can be registered with `addRecordHook()`, run in
registration order right after the stamp and before the size check —
`device_hooks::dispatch` and `mqtt_publish::onRecord` are the two the
firmware wires up. `SIGNAL_PAYLOAD_MAX` is
600 bytes against the library's own 512-byte message buffer, room for the
roughly 56 bytes the three stamped fields add. A message that still doesn't
fit is dropped rather than truncated: the SSE frame embeds a device's payload
as the JSON object it
already is, not as an escaped string, so a payload cut mid-object would put
unparseable JSON on the wire. Truncating and then fixing up the JSON is not
attempted; dropping the message and counting it in `droppedCount()` is
simpler. Its `FAKE_SIGNALS` `selfTest()` is host-tested by `test/host/run.sh`
against the same `arduino_shim/` fakes as `alias_store`.

**`radio_health.h` / `radio_health.cpp`** — an Arduino-free decision module,
host-tested by `test/host/run.sh` like `topic`. It watches the radio through
`lastDecodeAt` (time since last decode) and `averageRssi` (mean RSSI of the
receiver task). Two states: `silent` (no decode for `SILENT_MS`) and `pinned`
(`silent` AND `averageRssi` nonzero AND at or below `NOISE_FLOOR_DBM`).
`silent && pinned` soft re-inits (`initReceiver()`); anything else takes no
action. A pinned chip is stuck refusing OP_MODE writes and survives
`esp_restart()`, so the firmware never reboots for it: it soft re-inits on the
backoff until a power cycle clears the chip. Soft re-init increments
`recovery_count` in NVS and records the current uptime as `last_recovery_s`; a
confirmed decode resets the module's state. A constant `RECOVERY_BACKOFF_MS`
(2 min default) suppresses a re-trigger right after a recovery; the condition
must re-confirm before the next attempt. The window lengths and thresholds are
build flags.

**`health_store.h` / `health_store.cpp`** — persists the radio health state
to `Preferences` namespace `"health"`. Writes are bounded: once at boot
(`boot_count`, `last_reset_reason`), once on first SNTP sync (`last_boot_utc`,
the boot timestamp), and once per recovery event (`recovery_count`,
`last_recovery_s`). `radio_ok` is 1 when healthy and 0 while a soft
re-init has not yet produced a confirmed decode.

**`device_hooks.h` / `device_hooks.cpp`** — a decision module host-tested by
`test/host/run.sh` (compiled against the ArduinoJson headers in libdeps). It
holds a registry mapping rtl_433 model names to hook functions, and a rain
baseline table that tracks the cumulative `rain_mm` per device, resetting at
local midnight. It also range-checks known fields via `validate()` (see
"Filtering false decodes" below). `signal_store::record()` calls
`device_hooks::dispatch` with its `JsonDocument`; the hook looks up the
model and the rain hook writes
`rain_today_mm` (the delta from the baseline) into the doc before it is
stored. The baseline is RAM-only; a receiver reboot loses it and today's
rain restarts from 0.

**`tz_store.h` / `tz_store.cpp`** — persists the GMT offset (signed minutes)
to `Preferences` namespace `"tz"`. Defaults to -240 (EDT) at first boot. The
dashboard POSTs the offset to `/$tz` when the location is set; `tz_store::set`
persists it and pushes it into `device_hooks` so the rain hook's midnight
boundary follows the user's timezone. The offset reads back the same way it is
written — `GET /$tz`, a retained `<source>/$tz` MQTT publish, and an SSE frame
— so a dashboard on another origin can pick it up. Unlike `$layout` and
`$location` it is never unset, so its `GET` never `404`s and it always
replays.

**`layout_store.h` / `layout_store.cpp`** — persists the dashboard's
site-default `$layout` (grid size, per-model card settings) as one opaque
JSON blob in `Preferences` namespace `layout`, key `blob`, capped at
`LAYOUT_STORE_MAX`, 2 KB — the same cap as `alias_store`'s table, for the
same reason: a realistic layout (a handful of models) lands well under 1 KB
in practice. Unlike `alias_store`'s table of topic/name pairs, there is
exactly one `$layout` per receiver, so the blob is stored and served
verbatim rather than parsed and reserialized — the receiver never inspects
its contents, only the dashboard does. Its `FAKE_SIGNALS` `selfTest()` is
host-tested by `test/host/run.sh` against the same `arduino_shim/` fakes as
`alias_store` and `tz_store`. `layout_store::set()` still accepts a write
when NVS never opened, so a viewer can save a layout for the running
session even on a receiver whose flash is unavailable — that write is lost
on reboot.

**`location_store.h` / `location_store.cpp`** — persists the dashboard's
`$location` (`{lat, lon, label, zone, zoom}`) as one opaque JSON blob in
`Preferences` namespace `location`, key `blob`, capped at
`LOCATION_STORE_MAX`, 512 bytes. Same shape as `layout_store` in every other
respect: one entry per receiver, stored and served verbatim, host-tested
`selfTest()`, and a write accepted even when NVS never opened.

**`web_ui.h` / `web_ui.cpp`** — the HTTP and SSE surface. `/`, `/events`, and
`/$update` are the only registered routes; every topic is an arbitrary path,
so `GET` and `POST` of a topic are both dispatched from
`WebServer::onNotFound`, which does its own topic validation rather than
relying on route matching. `/$update` is registered directly rather than
routed through the topic parser, since `$update` isn't a topic, and uses
`WebServer::on()`'s two-callback form so the ~1.2 MB firmware image streams
through `Update::write()` in chunks instead of buffering whole. Four SSE
client slots (`WEB_UI_SSE_CLIENTS`), each a `WiFiClient` plus up to four
filters and one replay cursor, are fixed arrays sized at compile time — there
is no dynamic connection list.

**`wifi_store.h` / `wifi_store.cpp`** — persists WiFi credentials to
`Preferences` namespace `"wifi"`, in fixed `_ssid`/`_pass` buffers sized
`WIFI_STORE_SSID_MAX`/`WIFI_STORE_PASS_MAX`. `set()` validates length and
non-empty ssid before writing either buffer or NVS, so a rejected call leaves
prior credentials untouched. An empty password clears the stored `pass` key
rather than leaving a stale one paired with a new ssid. Boot order tries
these stored credentials first; see "Boot order" below.

**`ota_token_store.h` / `ota_token_store.cpp`** — persists the `/$update`
bearer token to `Preferences` namespace `"ota"`, in a fixed 33-byte buffer
(`OTA_TOKEN_STORE_MAX`). Mirrors `wifi_store`'s fixed-buffer/NVS shape.
`token()` returns the stored value if one exists, else the `.env`-supplied
`OTA_TOKEN` build flag, else an empty string — `hasToken()` is false only in
that last case, which is what makes `/$update` answer `404` instead of `401`
when OTA has never been configured.

**`provisioning.h` / `provisioning.cpp`** — the SoftAP captive portal used
when no stored or `.env` credentials connect. It runs its own `WebServer` on
port 80, separate from `web_ui.cpp`'s: `provisioning::run()` always ends in a
reboot before `web_ui::begin()` ever runs, so there is no port conflict
between the two. `run()` scans for nearby networks in STA mode before
`WiFi.softAP()` brings the AP up, because `WiFi.scanNetworks()` forces the
radio through STA-mode channel-hopping that would otherwise briefly
destabilize an already-joined client. The scanned list, deduplicated and
sorted by RSSI, is cached and rendered into the setup page rather than
rescanned per request. A DNS server answering every query with the AP's own
IP is what makes a phone or laptop auto-open the captive portal. The page's
third field, the OTA update token, is regenerated with `esp_random()` on
every `GET` and stored via `ota_token_store::set()` only if submitted
non-empty, so leaving it blank on a re-provisioning pass keeps whatever
token was already set.

**`mqtt_publish_store.h` / `mqtt_publish_store.cpp`** — persists up to
`MQTT_PUBLISH_SLOTS` (3) dashboard-configured broker url/token pairs to
`Preferences` namespace `"mqtt"`, as one JSON blob under key `"table"` — the
same shape `alias_store`'s 32-slot table uses, for the same reason: NVS keys
are capped at 15 characters, so one key per slot doesn't scale. `add()`
validates the same `mqtt://`/`mqtts://` scheme and length caps the old
single-value `set()` did, updates a slot in place when its url is already
present, and fails with the table full and no matching url. A pre-existing
single `url`/`token` NVS value (from before this table existed) is copied
into slot 0 the first time `begin()` runs against an otherwise-empty table,
then the old keys are removed — a one-time, silent migration. The
`MQTT_BROKER_URL`/`MQTT_TOKEN` build flags are read directly by
`mqtt_publish.cpp`, not through this store; they're a separate, always-on
connection outside the table.

**`mqtt_publish.h` / `mqtt_publish.cpp`** — publishes every record to a
remote broker over `PubSubClient`, retained. `begin()` parses the stored
broker URL once (`mqtt://` picks a plain `WiFiClient`, `mqtts://` a
`WiFiClientSecure` with the ISRG Root X1 root CA compiled in — never
`setInsecure()`) and calls `PubSubClient::setServer()`; `loop()` runs
`PubSubClient::loop()` and retries a dropped connection no more than once
per `MQTT_RECONNECT_BACKOFF_MS`. Each phase of a connect attempt — TCP
connect, TLS handshake, CONNACK wait — is bounded to 5 s, so an unreachable
broker cannot stall `loop()` — and with it `rf.loop()` draining the decode
queue — indefinitely, though the phases are sequential and a worst case on
the TLS path adds up to roughly 15 s. `MQTT_MAX_PACKET_SIZE` (2200, up from
PubSubClient's 768 default, to fit a full `$layout` blob) is a permanently
allocated buffer, not just a per-message cap, so it costs roughly 1.4 KB of
RAM for the process lifetime. `onRecord()`, registered as a second
`signal_store` record hook, publishes the hook's `JsonDocument` unmodified
to the topic `key` already is — `<mdnsHostname()>/<model>/<id>`, since
`signal_store::setSource(mdnsHostname())` is what built that key in the
first place. A publish while disconnected is simply skipped: there is no
retry queue, because every successful (re)connect calls `replayAll()`,
walking `signal_store::slotAt()`/`latestPayload()` to republish every
currently-held record, which backfills anything a fire-and-forget publish
missed.

## Boot order

WiFi connection is tried in three steps, each a fallback for the one before:
stored credentials from `wifi_store` first, then the `.env`-supplied
`WIFI_SSID`/`WIFI_PASSWORD` build macros if there were no stored credentials,
persisting them to `wifi_store` on a successful connect so later boots skip
straight to the stored path. If neither connects within the boot window, the
device falls back to `provisioning::run()`, the SoftAP captive portal, as the
final step.

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

20 KB of `nvs` is about three times what the firmware can put there. Radio
calibration under `phy/cal_data` is the largest entry at ~1,950 bytes; the
WiFi driver's own credentials in `nvs.net80211` are a few hundred; the
`wifi_store` module's copy of those same credentials (namespace `wifi`) is
under 100 bytes; the alias map is capped at `ALIAS_BLOB_MAX`, 2 KB; the
layout blob is capped at `LAYOUT_STORE_MAX`, another 2 KB. Worst-case usage
across every store is still under 7 KB against the 20 KB partition.

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

Before the size check, `record()` calls each registered record hook in turn.
`device_hooks::dispatch` reads the model from the payload, calls the matching
hook, and the rain hook computes `rain_today_mm` from the cumulative `rain_mm`
and a per-device baseline reset at local midnight, writing back into the
`JsonDocument` before it is serialized into the sub. `mqtt_publish::onRecord`
runs after it, so a configured remote broker gets `rain_today_mm` and every
other hook-added field too, not just what rtl_433 originally decoded.

## The replay design

Writing all 32 stored payloads to a newly connected socket in one pass would
overflow the socket's send buffer and get the client dropped, so each SSE slot
carries a replay cursor and `web_ui::loop()` drains at most `REPLAY_PER_LOOP`
(3) frames from it per call, retrying a frame whose socket isn't ready to
write rather than losing it.

The cursor walks flat indices — the sub table (0 through 31,
`SIGNAL_SUB_TABLE`), then the alias table (32 through 63), then one index each
for `$layout` (64), `$location` (65), and `$tz` (66) — rather than
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

`FrameBuffer` (in `web_ui.cpp`) is sized for one device payload
(`SIGNAL_PAYLOAD_MAX`, 600 bytes) doubled for the worst case of an escaped
alias string, not for a `$layout` blob up to `LAYOUT_STORE_MAX` (2 KB). A
`$layout` broadcast or replay frame that overflows it is dropped and logged
(`web_ui.cpp`'s existing fail-safe, not a crash) rather than sent truncated;
`GET /$layout` is unaffected, since it serves the stored blob directly, not
through `FrameBuffer`. In practice a real `$layout` (a handful of models)
stays well under the buffer's ~1.2 KB payload ceiling, the same margin the
NVS budget above relies on.

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
| `uptime_s` | `millis() / 1000` |
| `boot_count` | NVS counter, incremented each boot |
| `last_reset_reason` | `esp_reset_reason()` captured in `setup()` |
| `recovery_count` | NVS counter, incremented per soft re-init |
| `last_recovery_s` | Uptime at last soft re-init; 0 until the first |
| `radio_ok` | 1 when healthy; 0 while a soft re-init has yet to produce a confirmed decode |
| `coredump_pending` | `esp_core_dump_image_check()` at boot; 1 if a dump is present in flash |
| `rssi_thresh` | `rtl_433_ESP::rssiThreshold` |

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

## Filtering false decodes

All decoders in `rtl_433_devices.h` stay compiled in; two firmware-side
checks in `signal_store.cpp` and `device_hooks.cpp` filter the noise weak
decoders produce instead.

`device_hooks::validate()` range-checks `humidity` (0–100), `wind_dir_deg`
(0–360), and `pressure_hPa` (300–1100) when present, called from
`signal_store::record()` right after the device key is built. The pressure
range has to cover both sea-level-corrected readings from RF decoders and the
receiver's own wired BMP280, which reports raw absolute station pressure and
drops well below 800 hPa at altitude. A field outside its range drops the
whole decode, the same outcome as an unparseable payload.

A brand-new decode key is held in a small pending table rather than shown
immediately: the first sighting produces no broadcast and leaves no visible
trace anywhere, and only a second sighting of the same key promotes it to a
device slot. The pending
table has no time window — an entry is lost only by eviction under churn from
other new keys, never by age. This does not apply to the receiver's own
telemetry (see above), which still gets a card on its first call. The pending
table is fixed at `SIGNAL_PENDING_SLOTS` (8) entries, so a burst of distinct
one-off noise decodes between a real device's two sightings can evict its
pending entry before the second sighting arrives, losing the promotion.

## Radio health and recovery

`radio_health` runs once per telemetry cycle in `loop()`, fed with the current
`lastDecodeAt` and `averageRssi`. It classifies the radio state as `silent` or
`pinned` and returns an action. `pinned` triggers a soft re-init:
`initReceiver()` re-creates the receiver task and restarts the radio. There is
no reboot path: the firmware never calls `esp_restart()` for the radio, because
a reboot does not power-cycle the radio and a stuck chip survives it. A decode
arriving after a soft re-init marks the recovery confirmed and resets the
health state.

The two SPI users — the receiver task reading RSSI and `loop()` reading the
temperature register — are serialised by the ESP32 SPI driver's per-bus mutex:
RadioLib's `ArduinoHal` wraps every register transaction in
`beginTransaction()/endTransaction()`, which the driver guards. There is no
race between them.

The temperature read parks the radio in standby for the measurement and then
puts it back in RX. A single `setMode(STANDBY)` attempt is made; if it fails the
measurement is skipped. After the read the OpMode register is verified, and on
failure the path runs `reinitRadio()` and `recordRecoveryEvent()` and returns
`INT16_MIN` (the previous reading is kept). It does not reboot. The failure
signature is the refused OP_MODE write below, which a reboot does not clear, so
rebooting would only take the web server down. The board stays up serving HTTP
with `radio_ok` 0.

A noise floor at or below the SX1231's measurement floor is an error value, not
a quiet band. A working receiver with its antenna connected reads roughly -105
to -115 dBm on a quiet 433 MHz band; a reading past the chip's own floor (about
-120 dBm) means the front-end is not measuring RF. `NOISE_FLOOR_DBM` (-120)
gates the `pinned` state on that signature, but nothing names a below-floor
reading as an error.

## A refused OP_MODE write is not an SPI fault

`setMode` returns -16 (`RADIOLIB_ERR_SPI_WRITE_FAILED`) on any readback
mismatch, so a chip refusing a mode change reads in the log exactly like a
broken SPI bus. Check the bus before believing it. A chip that is answering SPI
returns `RegVersion` 0x24, and a scratch write to `RegOokFix` reads back
exactly; if those pass and only writes to the `RegOpMode` mode field are
refused, the bus is fine and the radio is not.

`RegIrqFlags1` (0x27) is what separates the two, and the firmware does not read
it. ModeReady (bit 7) asserts when a mode transition completes and PllLock
(bit 4) when the synthesizer is locked. A healthy chip in FS reads 0x90 and
holds it. A chip that cannot hold lock shows PllLock asserting a few hundred
microseconds after a mode change and dropping again within a millisecond, and
once RX is entered `RegIrqFlags1` reads 0x00 and stays there, ModeReady never
asserts, and every later mode write is refused. Nothing in firmware works
around that state: minimum LNA gain with a 25 kHz bandwidth behaves identically,
manual transitions with `SequencerOff` never reach PllLock at all, and it does
not recover with time. A soft re-init clears it, because `RF69::begin()` pulses
RST, but `initReceiver()` re-enters RX milliseconds later and loses lock again,
which is why the state looks like it survives `esp_restart()`.

Seen once on this board, over roughly 1500 recovery attempts. The cause was a
high-resistance solder joint on the RFM69CW power and ground leads: the digital
side had enough current to run SPI, calibrate the RC oscillator and complete a
temperature measurement, so the 32 MHz crystal was demonstrably running, while
the synthesizer could not hold lock. Reflowing the VDD and GND leads fixed it.
The board now reads a -86 dBm noise floor and decodes at -74 dBm. If the
signature returns, reflow or reseat the module's supply pins before suspecting
the chip.

The firmware treats it as a hardware fault and stays up: the pinned signature
keeps the board serving HTTP, soft re-initing on the backoff in case the fault
is transient, with `radio_ok` 0 and the pinned `noise_dBm` on the receiver card.

## Pin map

The firmware is built for the Freenove ESP32-S3-WROOM CAM on the
`rtl433-carrier` PCB with a HopeRF RFM69CW radio module.

| Signal | GPIO | Freenove header | RFM69CW pin | Note |
|---|---|---|---|---|
| MISO | 1 | right 3 | 8 | SPI |
| MOSI | 42 | right 5 | 5 | SPI |
| SCK | 41 | right 6 | 6 | SPI |
| CS (NSS) | 39 | right 8 | 7 | idle high; 10k pull-up to 3V3 |
| RST | 38 | right 9 | 13 | 10k pull-down to GND |
| DIO2 (data) | 40 | right 7 | 10 | continuous data output; GPIO 40 already pulled up |
| DIO0 | NC | — | 9 | unused; passed as `RADIOLIB_NC` |
| DIO1 | NC | — | 11 | unused; passed as `RADIOLIB_NC` |
| DIO3 | NC | — | 4 | unused |
| DIO5 | NC | — | 12 | unused |

I2C is on GPIO 21/47 for a BMP280/AHT20 sensor bus:

| Signal | GPIO | Freenove header |
|---|---|---|
| SDA | 21 | right 17 |
| SCL | 47 | right 16 |

The SDMMC pins (38–40) are repurposed for the radio, so the Freenove microSD
socket is not usable.

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
