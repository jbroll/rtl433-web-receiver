# Architecture

## Module boundaries

**`topic.h` / `topic.cpp`** — topic and filter parsing, with no Arduino
dependency, so `test/host/run.sh` compiles and runs it on the host with
nothing on the include path but the firmware directory itself, as it does
`radio_health.cpp`. Most of the other modules the script builds need
`test/host/arduino_shim/`. It mirrors `bridge/src/topic.js`, the
bridge's own implementation of the same rules, so the two agree on what a
valid topic or filter looks like without sharing code.

**`alias_store.h` / `alias_store.cpp`** — a fixed table of 32 topic/name pairs,
persisted as one JSON blob in a single `Preferences` entry (namespace `alias`,
key `tbl`), capped at 2 KB. NVS keys are limited to 15 characters and an alias
topic runs to 96 bytes, which rules out one NVS key per alias; the blob is
rewritten whenever an alias's name actually changes (`set()` skips the write
when the new name matches the one already stored), a user action and rare
enough that rewriting the whole table each time costs nothing worth avoiding.
The blob is written with `putBytes()`, not `putString()` — an NVS string has
to fit one page's free run, which failed near 2.7 KB on a real device (see
`layout_store` below); a blob is chunked across pages instead. `begin()`
reads the bytes key first and falls back to the string key (`map`) a table
saved before this was written to, adopting it and rewriting it as bytes;
the string key is removed only once that write succeeds, so a crash between
the two leaves the bytes key as the one `begin()` prefers on the next boot.
Its `FAKE_SIGNALS` `selfTest()` is host-tested by `test/host/run.sh` against
`test/host/arduino_shim/`'s fakes of `Arduino.h`, `ArduinoLog.h`, and
`Preferences.h` (an in-memory map standing in for NVS, with a separate set of
blob-typed keys so `getBytesLength()` on a string key reads as absent exactly
as it does on the device).

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
calls `sweepSubStale()`, which reclaims a splitter's stale secondary
`message_type` subs unheard from for longer than `SUB_STALE_MS` (1 hour) but
always spares each slot's newest sub — it never frees a device slot itself.
A slot's life ends either through `sweepStale()`'s `DEVICE_STALE_HOURS` window
or through `claimSlot()`'s capacity eviction of the lowest-`_seq` slot when
the table is full; `sweepSubStale()` never ends it.

`buildKey()` truncates `model` (`copyTruncated(model, SIGNAL_MODEL_MAX, m)`)
and, when `channel` stands in for `id`, truncates that too. The `id` field
itself is rejected rather than truncated when it doesn't fit its 16-byte
buffer, to avoid two sensors sharing a long id prefix colliding on one slot.
The assembled `source/model/id` key is rejected as a whole if it doesn't fit
`SIGNAL_KEY_MAX`, regardless of which segment pushed it over. `id`, `channel`
and `message_type` are each read with `is<const char*>()`/`is<long>()` first
and formatted straight into the fixed buffer (`copyTruncated` or
`snprintf("%ld")`); only a type neither covers (an id past `LONG_MAX`, a
non-string non-integer channel) falls back to `.as<String>()`, which is the
one path in `buildKey()` that still heap-allocates.

`record()` parses into a `JsonDocument` built over a `RecordAllocator`
(`signal_store.cpp`): a fixed `SIGNAL_JSON_POOL_BYTES` (4 KB) arena that bump-
allocates and never frees, reset at the top of every `record()` call rather
than at the end of scope, since the doc never outlives the function. ArduinoJson
7.4.3's default allocator is `malloc`/`realloc`, and — because `MemoryPool`
requests a whole `ARDUINOJSON_POOL_CAPACITY`-slot chunk up front rather than
growing to fit the document — even a small message costs a few-hundred-byte
heap round trip per parse; the project's build now sets
`ARDUINOJSON_POOL_CAPACITY=16` (`platformio.ini`) so that first chunk, and the
arena that has to hold it, stay small. The 4 KB arena is sized against a
payload shaped as one string field filling `SIGNAL_PAYLOAD_MAX`, not the
worst case: arena cost is per-slot plus per-string, and ArduinoJson inlines
keys of about three characters or less, so short-but-not-inline keys cost
more per byte — a 595-byte object of 54 four-character keys with float
values needs 5,632 bytes and returns `NoMemory` at 4,096. Realistic rtl_433
field names parse to 758 bytes, well under the cap. Every `record()` call
site is internal (the decoder queue, the two BMP280 paths, and fake
signals), so that worst-case shape does not come off the radio; the arena
is not sized to it on that basis. `RecordAllocator::allocate` returns
`nullptr` on exhaustion rather than falling back to the heap, which ArduinoJson
already treats as an ordinary out-of-memory parse error (`DeserializationError::
NoMemory`) rather than a crash; `reallocate` keeps a block's size in a header
so it can grow by copying into a fresh block, or, for the common case of
ArduinoJson shrinking a string to its final length, hand back the same block
unmoved.

### RecordAllocator arena alignment

Each block's header is sized to `alignof(max_align_t)`, not `sizeof(size_t)`
rounded to `sizeof(void*)`. ArduinoJson's slot union holds a `uint64_t`/`double`
(`alignof` 8), but on the ESP32 target `sizeof(void*)`/`sizeof(size_t)` are
both 4, so the old rounding put every payload at `buf+4k` — 4-byte aligned,
not the 8 the slot union needs. Compiling against the project's own
`xtensa-esp32s3-elf-g++` confirms the target's numbers: `alignof(max_align_t)`
is 8, `sizeof(void*)` and `sizeof(size_t)` are 4.

The host can't reproduce the bug directly — its `size_t` and `void*` are both
8 bytes, so even the old rounding already gave 8-aligned payloads there — but
it stands in for the same class of mismatch: the host's own
`alignof(max_align_t)` is 16, coarser than the `sizeof(void*)`=8 the old code
rounded to. `signal_store.cpp`'s `selfTest()` calls the allocator directly
with a run of odd allocation sizes, forcing blocks to start at every offset
the rounding allows; a fixture reproducing the old rounding fails that
assertion on the host, while the current `alignof(max_align_t)` rounding
passes it for every size 1..64, which is what confirms the check would have
caught the old code and not just that it passes the current one. A file-scope
`static_assert(alignof(max_align_t) >= alignof(uint64_t))` in `signal_store.cpp`
covers the target at compile time, since the host selfTest only runs under
`FAKE_SIGNALS`, which firmware builds don't define.

`record()` stamps `time`, `rssi`, and `count` into the decoded JSON, then
checks `measureJson(doc) > SIGNAL_PAYLOAD_MAX` before running any hook, so a
message the store is about to drop is never handed to one. A device slot is
claimed (or, for an existing device, looked up), then the sub for the
record's `message_type` is resolved; if the sub table is full and the slot
has no sub of its own to evict, the claim is undone before any hook runs, so
a record the store is about to refuse is never handed to one either. Up to
`SIGNAL_MAX_HOOKS` (2) record hooks can be registered with `addRecordHook()`,
run in registration order once the size check and the sub claim have both
succeeded — `device_hooks::dispatch` and `mqtt_publish::onRecord` are the two
the firmware wires up. `SIGNAL_PAYLOAD_MAX` is 600 bytes against the
library's own 512-byte message buffer, room for the roughly 56 bytes the
three stamped fields add. A message that still doesn't fit is dropped rather
than truncated: the SSE frame embeds a device's payload as the JSON object it
already is, not as an escaped string, so a payload cut mid-object would put
unparseable JSON on the wire. Truncating and then fixing up the JSON is not
attempted; dropping the message and counting it in `droppedCount()` is
simpler. Its `FAKE_SIGNALS` `selfTest()` is host-tested by
`test/host/run.sh` against the same `arduino_shim/` fakes as `alias_store`.

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

**The BMP280 sensor** (in `WebReceiver.ino`, no module of its own) — a wired
temperature and pressure sensor on the I2C bus at GPIO 21 (SDA) and GPIO 47
(SCL), read through the Adafruit BMP280 library, probed at 0x76 then 0x77 at
boot, and read every 30 s from `loop()`. It has no separate path into the page:
`recordBMP280()` builds the same rtl_433-shaped JSON a decoder would
(`model`, `id`, `channel`, `temperature_C`, `pressure_hPa`) and hands it to
`signal_store::record()`, so it becomes a device the dashboard already knows
how to draw, alias and lay out. It reports raw absolute station pressure, not
sea-level-corrected, which is why `device_hooks::validate()`'s pressure range
reaches down to 300 hPa. A board with no sensor on the bus logs the failed
probe once and records nothing.

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
boundary follows the user's timezone; the NVS write is skipped when the
offset hasn't actually changed. The offset reads back the same way it is
written — `GET /$tz`, a retained `<source>/$tz` MQTT publish, and an SSE frame
— so a dashboard on another origin can pick it up. Unlike `$layout` and
`$location`/`$units` it is never unset, so its `GET` never `404`s and it always
replays.

**`layout_store.h` / `layout_store.cpp`** — persists the dashboard's
site-default `$layout` (grid size, per-model card settings) as one opaque
JSON blob in `Preferences` namespace `layout`, keys `json`/`blob`, capped at
`LAYOUT_STORE_MAX`, 5 KB. A card costs the template about 165 bytes and the
dashboard can save 24 radio devices plus four feed cards, so the cap covers a
full receiver with room over. The 2 KB it used to be ran out at seven devices.
`set()` skips the write when the incoming blob matches the one already
stored, so a dashboard that autosaves on every drag doesn't rewrite 5 KB per
drag.

The blob is written with `putBytes()`, not `putString()`. `nvs_set_str()` needs
its whole length in one page's free run, which on a device whose `nvs`
partition already holds the radio calibration refused a 2,955-byte write and
accepted a 2,689-byte one — nowhere near the 4000 the API documents. An NVS
blob is chunked across pages, so the store's own cap is the only limit left.
`begin()` reads the bytes key (`json`), falls back to the string key
(`blob`) a layout saved before this was written to, and rewrites it as
bytes, removing the string key only once that write succeeds. `alias_store`
and `mqtt_publish_store`'s tables use the identical two-key shape for the
same reason — NVS keys are typed, so a `getBytesLength()` on a key still
holding the old string value reads as absent, which is what lets `begin()`
prefer the bytes key unconditionally: a device that already migrated, and
one caught mid-migration with both keys present, both land on the correct
value with no duplication.

Unlike `alias_store`'s table of topic/name pairs, there is
exactly one `$layout` per receiver, so the blob is stored and served
verbatim rather than parsed and reserialized — the receiver never inspects
its contents, only the dashboard does. Its `FAKE_SIGNALS` `selfTest()` is
host-tested by `test/host/run.sh` against the same `arduino_shim/` fakes as
`alias_store` and `tz_store`. `layout_store::set()` still accepts a write
when NVS never opened, so a viewer can save a layout for the running
session even on a receiver whose flash is unavailable — that write is lost
on reboot. `begin()` also logs `Preferences::freeEntries()` alongside the
loaded/empty message, since nothing else gives an operator a number to
reason with when a write starts failing.

**`blob_store.h`** (`BlobStore<CAP>` template) — the shared shape behind
`location_store` and `units_store`: `begin`/`get`/`set` over one JSON blob
in `Preferences` namespace and key `blob`, plus the same same-value write
skip as `layout_store`. `set()` adopts the new value into `_blob` first and
rolls back to a `previous[CAP]` copy taken before the write if `putString()`
fails, which is why `set()`'s own frame needs a second `CAP`-sized buffer;
`layout_store` was deliberately not standardised onto this shape and
instead keeps its own persist-before-adopt order (write to NVS first, only
copy the new value into `_blob` once that succeeds), which needs no second
buffer at all, since a failed write never touches the in-RAM blob in the
first place. `layout_store` also needs the two-key blob migration above,
which neither of the other two has ever needed: both still write with
`putString()`, and at 512 and 256 bytes their blobs are far short of the
2.7 KB where the single-page free run an NVS string needs started failing.
`alias_store` and `mqtt_publish_store` don't fit either — they
serialize a table rather than storing a blob verbatim.

**`location_store.h` / `location_store.cpp`** — persists the dashboard's
`$location` (`{lat, lon, label, zone, zoom}`) as one opaque JSON blob via
`BlobStore<LOCATION_STORE_MAX>` (512 bytes) in `Preferences` namespace
`location`. One entry per receiver, stored and served verbatim, host-tested
`selfTest()`, and a write accepted even when NVS never opened.

**`units_store.h` / `units_store.cpp`** — persists the owner's unit
preferences (`{units, decimals, custom}`) as one opaque JSON blob via
`BlobStore<UNITS_STORE_MAX>` (256 bytes) in `Preferences` namespace `units`.
Same shape as `location_store`: one entry per receiver, stored and served
verbatim, host-tested `selfTest()`, and a write accepted even when NVS never
opened. Whoever set it sets it for every visitor, since the blob is served
to all of them.

**`selftest_check.h`** — the one `selfTestCheck(module, what, ok)` PASS/FAIL
logger most stores' `FAKE_SIGNALS` `selfTest()` used to carry its own copy of.
Each store defines a local `CHECK(what, ok)` macro binding its own module
name, so call sites keep their existing shape. `ota_token_store.cpp` still
carries its own copy rather than this shared one; left alone deliberately,
since it sits on the `/$update` OTA-flash path.

**`web_ui.h` / `web_ui.cpp`** — the HTTP and SSE surface. `/`, `/events`,
`/$update`, and `/$mqtt` (plus `/$mqtt/remove`) are the only registered
routes; every topic is an arbitrary path, so `GET` and `POST` of a topic are
both dispatched from `WebServer::onNotFound`, which does its own topic
validation rather than relying on route matching. `/$update` and `/$mqtt`
are registered directly rather than routed through the topic parser, since
neither is a topic. `/$update` uses `WebServer::on()`'s two-callback form so
the ~1.2 MB firmware image streams through `Update::write()` in chunks
instead of buffering whole. `/$mqtt` reports `mqtt_publish`'s active
connections (url and connect state, never the token) and lets a `POST` add
or update a bridge and a `POST /$mqtt/remove` drop one; the parsing and
dispatch behind those three routes lives in `mqtt_routes.cpp`. Both mutating routes
check the request's `Origin` header against the receiver's own `Host` rather
than using the bare-path-or-own-source convention `$tz`, `$layout`,
`$location`, and `$units` use, since `$mqtt` has no source-prefixed form to
compare against. Six SSE client slots (`WEB_UI_SSE_CLIENTS`), each a
`WiFiClient` plus up to four filters and one replay cursor, are fixed arrays
sized at compile time — there is no dynamic connection list.

`ChunkedResponse::flush()` gives each chunk a bounded wait, `CHUNK_WAIT_US`
150 ms, before dropping the client, up to a `CHUNK_BUDGET_MS` 1.5 s total.
Aborting on the first not-ready probe was tried and rejected: it truncated
the page mid-send, and a truncated page runs no script at all, so the
browser was left with nothing rather than a slow load. The bound instead
lets a slow reader hold `loop()` — and the two-deep pulse-train ring behind
it — for up to 1.5 s before the client is cut loose. `handleUpdateUpload()`
runs the same way but with no such bound: it executes synchronously inside
`_server.handleClient()` for every chunk of the OTA upload's multipart body,
so `loop()` doesn't run again until the transfer completes, likely several
seconds for a ~1.2 MB image over WiFi. Moving the upload off the loop task
would need a second task, which the single-task design deliberately avoids.

**`mqtt_routes.h` / `mqtt_routes.cpp`** — the `/$mqtt` and `/$mqtt/remove`
request handling, split out of `web_ui.cpp` so it can be host-tested.
`dispatch(method, path, sameOrigin, body)` returns the status, content type
and body to send, plus two flags: `preflight`, which selects the
`OPTIONS` answer's headers over the `Cache-Control: no-store` every other
answer carries, and `reloadConnections`, which tells the caller to call
`mqtt_publish::begin()` after the table changed. The origin check and that
`begin()` stay in `web_ui.cpp`: one reads `WebServer` headers, the other
does WiFi work, and neither belongs in a function a host test drives.
`web_ui.cpp`'s three `/$mqtt` handlers are one line each on top of it, and
`test/host/mqtt_routes_test.cpp` covers the routes directly.

**`wifi_store.h` / `wifi_store.cpp`** — persists WiFi credentials to
`Preferences` namespace `"wifi"`, in fixed `_ssid`/`_pass` buffers sized
`WIFI_STORE_SSID_MAX`/`WIFI_STORE_PASS_MAX`. `set()` validates length and
non-empty ssid before writing either buffer or NVS, so a rejected call leaves
prior credentials untouched. An empty password clears the stored `pass` key
rather than leaving a stale one paired with a new ssid. Boot order tries
these stored credentials first; see "Boot order" below.

**`ota_token_store.h` / `ota_token_store.cpp`** — persists the `/$update`
bearer token to `Preferences` namespace `"ota"`, in a fixed 65-byte buffer
(`OTA_TOKEN_STORE_MAX`). Mirrors `wifi_store`'s fixed-buffer/NVS shape.
`token()` returns the stored value if one exists, else the `.env`-supplied
`OTA_TOKEN` build flag, else an empty string — `hasToken()` is false only in
that last case, which is what makes `/$update` answer `404` instead of `401`
when OTA has never been configured.

**`provisioning.h` / `provisioning.cpp`** — the SoftAP captive portal used
when no stored or `.env` credentials connect. It runs its own `WebServer` on
port 80, separate from `web_ui.cpp`'s: `provisioning::run()` always ends in a
reboot before `web_ui::begin()` ever runs, so there is no port conflict
between the two. The reboot comes from `handleSave()`, or, when
`wifi_store::hasCredentials()` is true, from `PROVISIONING_IDLE_MS` (10
minutes) passing with no HTTP request, so a board that fell into the portal
because its network was slow retries it instead of waiting for a person. A
never-provisioned board stays in the portal. `run()` scans for nearby networks in STA mode before
`WiFi.softAP()` brings the AP up, because `WiFi.scanNetworks()` forces the
radio through STA-mode channel-hopping that would otherwise briefly
destabilize an already-joined client. The scanned list, deduplicated and
sorted by RSSI, is cached and rendered into the setup page rather than
rescanned per request. A DNS server answering every query with the AP's own
IP is what makes a phone or laptop auto-open the captive portal. The page's
third field, the OTA update token, is regenerated with `esp_random()` on
every `GET` and stored via `ota_token_store::set()` only if submitted
non-empty, so leaving it blank on a re-provisioning pass keeps whatever
token was already set. A "Clear stored update token" checkbox calls
`ota_token_store::clear()` instead, overriding any token entered in the
field on the same submit; the page says so next to the checkbox.

**`mqtt_publish_store.h` / `mqtt_publish_store.cpp`** — persists up to
`MQTT_PUBLISH_SLOTS` (3) dashboard-configured broker url/token pairs to
`Preferences` namespace `"mqtt"`, as one JSON blob under key `tbl` — the
same shape `alias_store`'s 32-slot table uses, for the same reason: NVS keys
are capped at 15 characters, so one key per slot doesn't scale, and the same
`putBytes()`/two-key migration (legacy string key `table`) `alias_store` and
`layout_store` use. `add()` validates the same `mqtt://`/`mqtts://` scheme
and length caps the old single-value `set()` did, updates a slot in place
when its url is already present, and fails with the table full and no
matching url, or with the url equal to the build-flag `MQTT_BROKER_URL` —
that broker already connects unconditionally, and a second connection to it
under the same client ID just gets one session kicked by the other.

Two migrations chain in `begin()`: `load()` (the bytes/legacy-string blob
migration) runs first, then `migrateLegacy()` (copying a pre-existing single
`url`/`token` NVS value, from before this table existed, into slot 0 — a
different migration, of a value rather than a storage type) runs second and
only fires when the table `load()` produced is still empty. That ordering
matters for three device states: a board with only the old single `url`/
`token` keys and no table at all has `load()` no-op (nothing under `tbl` or
`table`), so `migrateLegacy()` fires and `add()` writes the table straight to
the bytes key; a board with a table already stored under the legacy string
key `table` (and no single-value keys, since an earlier boot already cleared
them) has `load()` populate and migrate the table, leaving `migrateLegacy()`
a no-op because the table is non-empty; a board with neither has both stages
no-op and starts with an empty table. Reversing the order would let
`migrateLegacy()` write to slot 0 before `load()` has a chance to populate
the table from a legacy string: `migrateLegacy()`'s own write goes through
the now-`putBytes()` `persist()`, so by the time the reversed `load()` ran it
would find the bytes key already populated with the single reconstructed
broker and take its first branch — `loadTable()` overwrites the whole in-RAM
table rather than appending to it, so the legacy string's other bridges are
never read at all. The failure mode is losing them, not duplicating
anything; `selfTest()`'s "multi-bridge legacy table with a stale single
value" check calls `begin()` itself so this ordering is what gets asserted,
rather than a hand-rolled `load()`/`migrateLegacy()` call pair that could
pass regardless of which runs first.

The `MQTT_BROKER_URL`/`MQTT_TOKEN` build flags are read directly by
`mqtt_publish.cpp`, not through this store; they're a separate, always-on
connection outside the table.

**`mqtt_publish.h` / `mqtt_publish.cpp`** — publishes every record to up to
four brokers over `PubSubClient`, retained: one connection per
`mqtt_publish_store` table slot, plus the always-on `MQTT_BROKER_URL`
build-flag default as a fourth. Each is a fixed `Connection` (a
`WiFiClient`/`WiFiClientSecure` pair, a `PubSubClient`, and its own backoff
timer) in a compile-time-sized array, never a dynamic list — `PubSubClient`
holds a reference to its client, so a slot's address has to stay stable
across a `begin()` rebuild. `begin()` is called once at boot and again
whenever `web_ui.cpp`'s `/$mqtt` handlers change the table; each call diffs
the store's table (plus the build-flag default) against the live
connections by url, token and TLS flag together, leaves an exact match's
slot untouched, and only tears down and rebuilds the rest — matching by
array index instead would reconnect the wrong broker whenever an add or
remove reshuffles which index serves which entry. A slot whose url fails
`mqtt(s)://host:port` parsing is still counted, carrying a reason string
that `/$mqtt` reports instead of silently dropping the row. Each connection
connects/reconnects and backs off independently, so one broker being
unreachable doesn't stall another. `mqtt://` picks a plain `WiFiClient`,
`mqtts://` a `WiFiClientSecure` with the ISRG Root X1 root CA compiled in —
never `setInsecure()`. `loop()` runs each connected client's
`PubSubClient::loop()` and retries a dropped one no more than once per
`MQTT_RECONNECT_BACKOFF_MS`. Each phase of a connect attempt — TCP connect,
TLS handshake, CONNACK wait — is bounded to 5 s, so an unreachable broker
cannot stall `loop()` — and with it `rf.loop()` draining the decode queue —
indefinitely, though the phases are sequential and a worst case on the TLS
path adds up to roughly 15 s per connection. `MQTT_MAX_PACKET_SIZE` (5300, up
from PubSubClient's 768 default, to fit a full `LAYOUT_STORE_MAX` `$layout`
blob plus its topic) is a permanently allocated buffer, about 5 KB, per
connected broker — but only once `setupConnection()` grows it there; each
`Connection`'s `PubSubClient` starts at a small idle buffer, so a slot with
no broker configured, or an invalid url, costs a few hundred bytes of heap
instead of 5 KB. That figure excludes TLS: an `mqtts://` connection also
holds an mbedTLS context and its buffers, on the order of tens of KB of heap
once the handshake completes, and that cost — not the packet buffer — is
the real limit on how many `mqtts://` bridges a device can hold
concurrently. `begin()`'s matching/teardown/setup logic, including the
out-of-memory path when `setBufferSize()` fails, is host-tested by
`test/host/mqtt_publish_test.cpp` against `arduino_shim/`'s fakes of `Print`,
`WiFiClient`/`WiFiClientSecure`, and `PubSubClient` — see
[development.md](development.md#testing-without-a-radio). JSON string
escaping used to live in `web_ui.cpp`; it moved to its own
`json_string.h`/`.cpp` so `mqtt_publish.cpp` (and its host test) don't have
to pull in `web_ui.h`'s `WebServer`/`Update`/lwIP dependencies, none of which
build on host.

Every `mqtts://` connection is pinned to that one compiled-in CA, with no way
to configure another, so a broker not chained to Let's Encrypt — a
commercial cloud broker, a self-signed LAN broker — fails its handshake
silently, showing only a dot that never turns green. `connectOnce()` logs
`WiFiClientSecure::lastError()` alongside PubSubClient's own `state()` on a
failed connect, since `state()` alone can't tell a bad CA or handshake
apart from a broker that simply refused the connection. A configurable CA
needs a form field, a multi-KB NVS entry on a partition already tight for
blobs (see "The partition table" below), and a decision about whether to
allow no verification at all; it waits until someone has a broker that
needs it.

`mqtt_publish::onRecord` writes each record's `JsonDocument` into a 601-byte
stack buffer before publishing it, and `signal_store::record()` writes the
identical doc into `sub.payload` a few lines later — the same record
serialised twice. Publishing from `sub.payload` instead would mean changing
the hook contract from "gets the doc" to "gets the serialised payload",
worth doing only if the decode path measures hot; nothing has measured it.

`onRecord()`, registered as a second `signal_store` record hook,
publishes the hook's `JsonDocument` unmodified to the topic `key` already
is — `<mdnsHostname()>/<model>/<id>`, since
`signal_store::setSource(mdnsHostname())` is what built that key in the
first place — fanned out to every connected connection. A publish while a
given connection is disconnected is simply skipped on that connection: there
is no retry queue, because every successful (re)connect calls
`replayAll()`, walking `signal_store::slotAt()`/`latestPayload()` to
republish every currently-held record to that connection, which backfills
anything a fire-and-forget publish missed.

`publishAlias()` is the one publisher whose topic is not built from the client
id. An alias topic already carries the source segment, and `handleAliasPost`
refuses one outside the receiver's own source, so it is published as it
stands. A cleared alias goes out as a zero-length retained publish, which is
what makes a bridge drop its retained copy. `replayAll()` walks all
`ALIAS_SLOTS` on connect for the same reason it replays the four stores: a
bridge that restarts loses its retained set.

## Boot order

WiFi connection is tried in three steps, each a fallback for the one before:
stored credentials from `wifi_store` first, then the `.env`-supplied
`WIFI_SSID`/`WIFI_PASSWORD` build macros if there were no stored credentials,
persisting them to `wifi_store` on a successful connect so later boots skip
straight to the stored path. Each of those runs `connectWiFi()` up to
`WIFI_BOOT_ATTEMPTS` (5) times, `WIFI_CONNECT_MS` (20 s) each, because after a
power outage the router boots slower than the ESP32. If none connects, the
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
difference with `pio run -e rfm69-433` across the commit that made the change:
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
layout blob is capped at `LAYOUT_STORE_MAX`, 5 KB. Worst-case usage across
every store is about 11 KB against the 20 KB partition.

## Data flow

The decoder runs on `rtl_433_DecoderTask`, not the loop task, so
`rtl_433_Callback` cannot touch `signal_store` or `web_ui` directly — both
assume single-threaded access from `loop()`. The callback instead copies the
message and RSSI into an 8-deep FreeRTOS queue, with `memcpy` of the measured
length rather than a zero-padding `strncpy`, since `xQueueSend` copies the
whole struct either way and a typical decode is a fraction of the 512-byte
field. `loop()` drains it:

    rtl_433_Callback → queue → loop() → signal_store::record() → web_ui::broadcast() → subscribers

`record()` returns whether the message was stored. On success, `loop()` calls
`signal_store::lastRecorded()` — the slot the call just touched, stashed in a
file-static index rather than resolved by re-sorting `_order` the way
`device(0)` does — and passes it to `broadcast()`, which builds one SSE frame
and sends it to every subscriber whose filters match and whose replay cursor
has already passed that device's newest sub. `lastRecorded()` returns `NULL`
after a `record()` call that returned `false`, so a caller that broadcasts
without checking the return value gets nothing rather than a stale slot.

After the size check, `record()` calls each registered record hook in turn.
`device_hooks::dispatch` reads the model from the payload, calls the matching
hook, and the rain hook computes `rain_today_mm` from the cumulative `rain_mm`
and a per-device baseline reset at local midnight, writing back into the
`JsonDocument` before it is serialized into the sub. `mqtt_publish::onRecord`
runs after it, so a configured remote broker gets `rain_today_mm` and every
other hook-added field too, not just what rtl_433 originally decoded. The rain
hook does nothing until SNTP has synced: `localDay()` reads 0 before then, and
a baseline recorded against day 0 would be the permanent target of
`claimRain()`'s lowest-day eviction and its delta meaningless anyway, since the
day-rollover branch never fires against a day that never changes.

## The replay design

Writing all 32 stored payloads to a newly connected socket in one pass would
overflow the socket's send buffer and get the client dropped, so each SSE slot
carries a replay cursor and `web_ui::loop()` drains at most `REPLAY_PER_LOOP`
(3) frames from it per call, retrying a frame whose socket isn't ready to
write rather than losing it.

The cursor walks flat indices — the sub table (0 through 31,
`SIGNAL_SUB_TABLE`), then the alias table (32 through 63), then one index each
for `$layout` (64), `$location` (65), `$tz` (66), and `$units` (67) — rather
than `signal_store::device(i)`'s recency order. `device(i)` re-sorts on every call
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

Frames are assembled in one of two buffers (`web_ui.cpp`). `FrameBuffer` holds
a device payload (`SIGNAL_PAYLOAD_MAX`, 600 bytes) doubled for the worst case
of an escaped alias string, and is a stack local in the broadcast paths.
`LayoutFrameBuffer` holds a full `LAYOUT_STORE_MAX` blob and is used by
`broadcastLayout()` and by the replay drain, which carries `$layout` as well as
device payloads; both are `static`, because 4 KB does not belong on the loop
task's stack and `web_ui` only ever runs from `loop()`. A `static_assert` ties
the layout buffer to `LAYOUT_STORE_MAX`: a blob the store accepts must fit a
frame. It did not before — the store took 2 KB while the one shared buffer held
1,362 bytes, so a layout over about 1,310 bytes (seven cards was enough)
persisted, answered 204, and then had every frame carrying it dropped. `GET
/$layout` still returned it, but the dashboard only reads `$layout` from the
stream, so the layout was invisible to every browser that had not just saved
it.

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
| `decodes` | `signal_store::totalRecorded()`, promoted decodes since boot |
| `drops` | `signal_store::droppedCount()`, records dropped since boot |
| `irq1` | Post-reinit `RegIrqFlags1`, see "A refused OP_MODE write is not an SPI fault" below. Absent until the first `reinitRadio()` |

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
`reinitRadio()` disables the receiver task and interrupt, then `initReceiver()`
resets and reconfigures the radio and restarts the task; the transaction mutex
below covers single register reads, not a reset under a running RSSI poll. There is
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

`RegIrqFlags1` (0x27) is what separates the two. ModeReady (bit 7) asserts
when a mode transition completes and PllLock (bit 4) when the synthesizer is
locked. A healthy chip in FS reads 0x90 and holds it. A chip that cannot hold
lock shows PllLock asserting a few hundred microseconds after a mode change
and dropping again within a millisecond, and once RX is entered
`RegIrqFlags1` reads 0x00 and stays there, ModeReady never asserts, and every
later mode write is refused. Nothing in firmware works around that state:
minimum LNA gain with a 25 kHz bandwidth behaves identically, manual
transitions with `SequencerOff` never reach PllLock at all, and it does not
recover with time. A soft re-init clears it, because `RF69::begin()` pulses
RST, but `initReceiver()` re-enters RX milliseconds later and loses lock
again, which is why the state looks like it survives `esp_restart()`.

`reinitRadio()` reads `RegIrqFlags1` before and after the `initReceiver()`
call, logs both, and carries the post-reinit byte in the Receiver telemetry
as `irq1`; the field is left out of the JSON until the first reinit has run.
The same pass writes a flipped scratch value to `RegOokFix` and reads it
back, and reads `RegVersion`: a mismatch on either names an SPI bus fault in
the log rather than a refused mode change. The register reads use
`SPIgetRegValue`, bounded by the SPI transaction itself, not a polling loop —
`reinitRadio()` already runs with the receiver task and its interrupt
stopped, so nothing else is on the bus to race, but a hung transaction there
would still hang `loop()` if the read waited on anything but the transaction.

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

## Two boards, two environments

`platformio.ini` builds the same firmware for two radios. `[common]` holds
every flag that is not about the radio; each environment adds its own
frequency, chip and pin map on top.

| | `rfm69-433` | `sx1276-915` |
|---|---|---|
| Radio | HopeRF RFM69CW (SX1231) | SX1276 family, `RegVersion` 0x12 |
| Frequency | 433.92 MHz | 915.00 MHz |
| NSS | GPIO 39 | GPIO 40 |
| DIO2 (data) | GPIO 40 | GPIO 38 |
| RESET | GPIO 38 | not wired |
| `OOK_FIXED_THRESHOLD` | 0x50 | 0x0C |

The SPI bus is the same three pins on both. `OOK_FIXED_THRESHOLD` differs
because `RegOokFix` is a different quantity on the two parts: on an SX127x it
is the peak-mode floor in dB, and the SX1231's 0x50 leaves it deaf.

The radio health work below is SX1231-specific and compiled out of the 915
build. `reinitRadio()` still re-runs the config path there, but without the
`RegIrqFlags1`, `RegOokFix` and `RegVersion` diagnostics, so `irq1` never
appears in that board's telemetry; `radioTemperature()` returns nothing, so
neither does `radio_C`. Both would need the SX127x's own register addresses,
and neither has been written.

## Pin map

The 433 firmware is built for the Freenove ESP32-S3-WROOM CAM on the
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
the first value it sees *per device* and reloads when that device reports a
different one. A rebuild with no new commit keeps the same id, so uncommitted
work needs a manual reload — the page has no way to tell that binary apart
from the one already running.

Per device, not per page. Two receivers reported through one bridge are both
model `Receiver` and arrive under one origin, so a single page-wide slot
flipped between their two ids on every message and reloaded without end. See
`dashboard/src/reload.js`.

## The clock

The device has no RTC. `configTime(0, 0, "pool.ntp.org")` runs once on the
first successful WiFi connect and again on every reconnect, so a clock that
drifts while WiFi is down is corrected rather than left stale.
`signal_store::isoTime()` treats a `time()` before 1700000000 (2023-11-14) as
unset and omits the `time` field rather than stamping a wrong one. The page
ages a message from its `time` field when present, parsed with `Date.parse`,
and falls back to the time the frame arrived when `time` is absent or fails to
parse — the two clocks it ever has to work with.
