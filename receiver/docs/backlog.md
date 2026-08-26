# Backlog

Known gaps in the receiver, in rough priority order. None break it as it stands; each was
found during review or hardware testing and deliberately left. Anything spanning
sub-projects is in [`../../docs/backlog.md`](../../docs/backlog.md).

## The provisioning portal is an open AP that hands out an OTA token

`WiFi.softAP(ap, nullptr)` in `provisioning.cpp` brings up an unencrypted network, and
`handleRoot()` generates a fresh token with `randomToken()` and renders it
into the form on every GET; `handleSave()` stores whatever the form returns.
Anyone in range of a board sitting in the portal can join, submit their own SSID and a token they chose,
and take the board onto their network with an OTA credential they control. `POST /$update`
then accepts arbitrary firmware. A WPA2 password on the SoftAP, printed on the device or
derived from the chip ID, is the smallest fix.

## A failed sub claim leaves a device slot allocated

`signal_store::record()` runs `claimSlot()` (which increments `_deviceCount`), copies the
key, and sets `used = true` at `:252-254`, before `claimSub()` can fail at `:268-272`. When
it does, `record()` does `_dropped++; return false;` and leaves a slot with `lastSeen == 0`,
`count == 0` and no sub. With 32 subs already allocated and a new device promoted from
pending, the store reports one more device than exists, `device()` orders a slot whose
`latestPayload()` is NULL, a `GET` of its key answers 404, and nothing reclaims it until
`sweepSubStale()` measures `millis() - 0` past `SUB_STALE_MS` (see the entry on the hour
cap below, which is what actually bounds this and not `DEVICE_STALE_HOURS`). Claiming the sub first,
or releasing the slot on the failure path, fixes it.

## Build-time secrets are readable in the firmware image

`load_env.py` passes `WIFI_PASSWORD`, `OTA_TOKEN` and `MQTT_TOKEN` from `.env` to
`platformio.ini` as `-D` string macros, and `ota_token_store.cpp:35` and
`mqtt_publish.cpp`'s `begin()` (the `MQTT_BROKER_URL`/`MQTT_TOKEN` build-flag
default) return them as fallbacks, so the literals link into
`.rodata`. `.env` is gitignored and untracked, so nothing is in git history, but a `.bin`
shared for flashing or an `esptool.py read_flash` on a recovered board yields all three as
plain strings. Provisioning through the portal avoids it; the build-time path does not.

## No path in for sensors that are not 433 MHz decodes

The receiver's own card proved the shape: anything recorded through
`signal_store::record()` becomes a device the page already knows how to draw,
alias, and lay out. Nothing else uses it. Two directions remain open:

- A wired sensor on the I2C bus at GPIO 47 (SCL) and GPIO 21 (SDA), recorded
  the same way. The BMP280 driver reads temperature and pressure every 30 s
  and records them through `signal_store::record()`. The bus is sized for an
  AHT20 later. Add 10k pull-ups to 3V3 at the sensor header unless the breakout
  provides them.
- Ingest from elsewhere: an authenticated `POST /api/signal` taking the same
  rtl_433 JSON is about twenty lines and no new dependency. An MQTT
  subscription needs a broker and roughly 10 KB of flash, against 144 KB free.
  ESP-NOW suits battery nodes but pins them to the station's WiFi channel.

Egress is done: see `mqtt_publish.h`/`mqtt_publish.cpp` in `architecture.md`
and "Publishing to a remote broker" in `user-manual.md`.

## A below-floor noise reading has no error marking on the card

The health monitor already surfaces the signature: `NOISE_FLOOR_DBM` feeds a
floor at or below the SX1231's measurement floor (about -120 dBm, e.g. the
-125 dBm seen when the chip was stuck refusing OP_MODE writes) into the
`pinned` state, and the telemetry carries `radio_ok`, `noise_dBm`, and
`rssi_thresh`. But the receiver card still renders `noise_dBm` as a plain
value with no error marking, so a broken radio reads as merely quiet. Add a
page indicator keyed on `radio_ok`.

## The health path never reads `RegIrqFlags1`

Everything the firmware knows about a sick radio comes from `setMode` returning
-16 and from the noise floor, and -16 means only "readback did not match". It
cannot tell a chip that is refusing a mode change from an SPI bus that has
stopped working, which is the wrong turn the last hardware fault sent the
diagnosis down. `RegIrqFlags1` (0x27) answers it directly: ModeReady in bit 7
and PllLock in bit 4. Reading it in `reinitRadio()` and carrying the byte in
telemetry would name the fault in the log instead of leaving it to a probe
sketch. A scratch write to `RegOokFix` and a `RegVersion` check would settle
the bus question in the same pass.

## The decode path still allocates

Beyond the `JsonDocument` and `String` noted below: ArduinoJson 7.4.3's default
allocator is `malloc`/`realloc`, and it reallocs several times per parse. A
static pool (an `ArduinoJson::Allocator` subclass over a fixed buffer, passed to
the `JsonDocument` constructor) removes it without touching the parse.

## Heap allocation on the decode path

`signal_store::record()` builds a `JsonDocument` (`signal_store.cpp:207`) and
calls `.as<String>()` on `doc["id"]`, `doc["channel"]` and `doc["message_type"]`
(`:87`, `:89`, `:263`) for every decode — plus once per BMP280 sample and once
per telemetry cycle. Each one heap-allocates a `String` only to copy it into a
fixed buffer, where the underlying value is already an `int` or a
`const char*`. ArduinoJson 7
pools and reallocates, and `String` allocates outright, so both run against the
project's "static allocation only" rule. They are transient and uniformly sized,
so the footprint stays flat — free heap held steady across a 4 minute sample —
but the `String` is avoidable in two lines by formatting the id as an integer
and falling back only when it is genuinely a string.

## A slow HTTP client can still stall the receive path

`ChunkedResponse::flush()` waits up to `CHUNK_WAIT_US` 150 ms per chunk with a
`CHUNK_BUDGET_MS` 1.5 s total budget (`web_ui.cpp:118-119`) before dropping the
client. That bound exists because aborting on the first not-ready probe
truncated the page and left the browser running no script at all. The cost is
that a genuinely slow reader can hold `loop()` for up to 1.5 s, and the
library's pulse-train ring is only two deep, so signals arriving during a stall
are overwritten. A healthy client never waits. Removing the risk entirely means
serving the page off a second task, which the single-task design deliberately
avoids.

## SSE eviction and auto-reconnect can churn

With all four stream slots busy, a new viewer evicts the longest-attached one,
whose browser reconnects three seconds later on the server-sent `retry` and
evicts the next. Observed while
testing with five clients plus an open tab. It is self-limiting and only happens
when oversubscribed, but a viewer in that state sees the table reload
repeatedly. Raising the slot count or backing off the page's reconnect would
both help.

## The compiled decoders are 15% of the image

The 319 compiled decoders are 172,009 bytes of `.flash.text`. `MY_DEVICES` in the fork's
`rtl_433_devices.h` is what narrows them. Space is not the reason to: `app0` is 4 MB and
the image uses 28% of it. False decodes are filtered by firmware now (see
`architecture.md`), so nothing currently motivates narrowing the compiled decoder set
either.

## The firmware self-test has never been read on a live device

`signal_store::selfTest()` and `alias_store::selfTest()` also run at startup
under `FAKE_SIGNALS` on real hardware and print a PASS/FAIL line per check,
but nobody has seen those lines there. The board flashes and runs, and
`ArduinoLog` writes to `Serial0`, a hardware UART at 921600 baud, while the
port exposed over USB is the S3's CDC device. Reading the self-test needs a
UART adapter on the TX pin, or the sketch pointing `Log.begin()` at `Serial`
so it comes out over USB. `signal_store`'s 51 checks and `alias_store`'s 22
now run and are checked on every commit via `test/host/run.sh` (see
`architecture.md`); only the on-device serial output is still unread.

## An alias surviving a reboot is unverified

`alias_store::selfTest()` covers the in-RAM table and the round trip through a
serialised blob, but not `Preferences::putString()` actually landing in NVS
and surviving a power cycle — that needs hardware, like the self-test gap
above.

## `MDNS_PREFIX` has no runtime equivalent

`.env`'s `MDNS_PREFIX` only takes effect at build time. The captive portal has
no field for it, so a device provisioned entirely through SoftAP always uses
the `rtl433` mDNS prefix default.

## A `POST /$update` upload blocks `loop()` for the whole transfer

`handleUpdateUpload()` runs synchronously inside `_server.handleClient()`
for every chunk of the multipart body, so `loop()` — and with it `rf.loop()`
— doesn't run until the upload finishes. The rtl_433 library's pulse-train
ring is only two deep (see the slow-HTTP-client entry above), so signals
arriving during the transfer can be dropped, and SSE keepalives stall for
the duration. Worse than the `CHUNK_BUDGET_MS` 1.5 s stall above, which is
about a slow *reader*; this is about a slow or large *upload*, likely
several seconds for a ~1.2 MB image over WiFi.

## The stored OTA token is capped shorter than `.env`'s

`ota_token_store`'s `OTA_TOKEN_STORE_MAX` is 32 characters; `.env`'s `OTA_TOKEN`
is 48. Submitting the provisioning portal's form with that token gets a 400
("Update token is too long") and nothing is stored, so the board falls back to
the compiled-in `.env` token for OTA and has no portal-settable token at all.
Shortening `OTA_TOKEN` to 32 characters or raising `OTA_TOKEN_STORE_MAX` fixes
it.

## A pending core dump has no ELF to symbolize it

A core dump from an earlier panic is still in flash (`coredump_pending: 1`).
Fetching it needs USB (`tools/fetch_coredump.sh`), and the ELF of the build
that panicked is no longer on disk, so the dump may only be useful for its
backtrace addresses. Keeping the ELF for a build until any coredump it left
behind is fetched would avoid losing the symbols.

## No way to clear or disable a set OTA token

`ota_token_store` has no `clear()`, and the SoftAP portal always overwrites
the stored token with a freshly generated one on every provisioning pass
(`provisioning.cpp`). Once a token has been set there's no path back to the
"OTA disabled" (`404`) state short of erasing NVS entirely. Not a bug, just
a gap for anyone who wants to disable OTA after enabling it.

## Three stores are one template written out three times

`units_store`, `location_store` and `layout_store` are the same
begin/get/set-a-JSON-blob-in-NVS module with different sizes and namespace
names, and every store's `selfTest()` carries its own copy of the
`check(what, ok)` PASS/FAIL logger (eight copies). One blob-store template and
one shared check helper would remove both.

## Devices expire after an hour whatever `DEVICE_STALE_HOURS` says

`sweepStale()` ends by calling `sweepSubStale(now, SUB_STALE_MS)`, and `SUB_STALE_MS` is
hardcoded to 3600000 in `signal_store.h`. `sweepSubStale()` frees the owning device slot
when its last sub goes, so effective retention is `min(DEVICE_STALE_HOURS, 1h)` and the
72-hour build flag can never take effect. A sensor with a daily or weather-dependent duty
cycle disappears from the dashboard after an hour and comes back as a new pending key,
needing two sightings to reappear. `DEVICE_STALE_HOURS=0`, which the flag's comment says
disables expiry, does not: the `staleMs == 0` early return skips only the device loop.
Either stop freeing the slot from the sub sweep and let the device window own slot
lifetime, or tie `SUB_STALE_MS` to `DEVICE_STALE_HOURS` and document the coupling.

## MQTT publishes messages the store then drops

`signal_store::record()` runs the hook loop before the `measureJson(doc) >
SIGNAL_PAYLOAD_MAX` check, and `mqtt_publish::onRecord` is registered as a hook, so a
payload too large for the store is still published retained to every broker. The bridge
and the receiver then disagree about which messages exist, and the retained copy has no
local counterpart to age out. The pending-key rule is checked earlier and is consistent;
only the size check is on the wrong side. Moving it above the hook loop is the fix, since
`SIGNAL_PAYLOAD_MAX` is a property of the message rather than of the store's write. The
failed-sub-claim path above drops a record after the hooks have run for the same reason.

## Two stores write blobs the 20 KB NVS partition cannot promise them

`partitions.csv` gives nvs `0x5000`, five 4096-byte pages, one of which NVS reserves for
GC. After per-entry overhead and the IDF's own `nvs.net80211` and `phy` namespaces that
leaves roughly 16 KB, against a worst case of about 8.8 KB across `layout` (5120),
`alias` (2048), `mqtt` (768), `location` (512), `units` (256), wifi and the OTA token.
Three problems follow.

`alias_store::persist()` uses `putString` for a 2048-byte blob. An NVS string is one
variable-length item that must fit a contiguous free run inside a single page, which is
exactly the failure `layout_store.h` documents hitting near 2.7 KB on a real device and
worked around by switching to `putBytes`. `alias_store` never got that treatment, and
`mqtt_publish_store`'s 768-byte `table` is on the same trajectory. When `persist()` starts
returning false, `set()` and `remove()` revert the in-memory change, so renames fail with
a `503` and nothing but "alias store full" to explain it. Both want `putBytes`/`getBytes`
with the legacy-key migration `layout_store::load()` already implements.

None of `layout_store`, `location_store`, `units_store` or `alias_store` compares the
incoming value against the copy already in RAM before writing. A dashboard that autosaves
the layout on each drag rewrites 5120 bytes per drag; each rewrite appends a new copy
before the old one can be erased, so live utilisation briefly doubles and the flash wear
counter advances on a four-page arena. A `strcmp` against the in-RAM blob before the
`putBytes` is one line per store.

`LAYOUT_STORE_MAX` alone is a quarter to a third of usable NVS, and nothing checks
headroom: `set()` accepts anything under 5120 and the write either works or does not.
Shrinking the per-card template on the dashboard side would help; raising the partition is
blocked on the platform hardcoding `app0`'s offset, as `partitions.csv` notes.

## Every MQTT slot allocates its 5300-byte buffer at startup

`mqtt_publish.cpp` declares `Connection _conn[MQTT_PUBLISH_SLOTS + 1]`, four entries, each
holding a `PubSubClient` whose default constructor mallocs `MQTT_MAX_PACKET_SIZE`. With
that flag at 5300 the array costs 21,200 bytes of heap at static-init time, before
`setup()` runs, on a device that typically has one broker configured. Constructing the
clients small and calling `setBufferSize(MQTT_MAX_PACKET_SIZE)` from `setupConnection()`
only for slots that parsed a valid URL recovers about 16 KB with no change to what gets
published. The `platformio.ini` comment already flags that this buffer costs RAM for the
life of the process; this would make it cost it once rather than four times.

## The SSE frame buffer is memset on every broadcast

`SizedFrame` in `web_ui.cpp` zero-initialises its storage, and `FRAME_DEVICE_CAP` is 1363,
so each of `broadcast()`, `broadcastAlias()`, `broadcastLocation()`, `broadcastUnits()`
and `broadcastTz()` clears 1363 bytes to write a frame of roughly 250. The zero-init is
there so the byte past the last write is a NUL for `data()`, but `reset()` sets only
`_buf[0]`, so that guarantee does not survive a reused buffer anyway. Appending
`_buf[_len] = '\0'` at the end of `Frame::write`, where `_len <= _cap - 1` is already an
invariant, is a stronger guarantee and drops the memset. `handleTopic()` compounds it by
putting a full `FrameBuffer` on the stack to escape an alias name capped at 32 characters,
where `mqtt_publish.cpp`'s `ALIAS_PAYLOAD_MAX` of 195 already names the worst case.

## `POST /$mqtt/remove` returns 204 for a url it never removed

`handleMqttRemovePost()` in `web_ui.cpp` calls `mqtt_publish_store::remove(url)` and
unconditionally answers `204`, on the stated basis that "a url that was never present is
not an error." That collapses two different outcomes into one response: a bridge that was
actually dropped, and one baked into the firmware build (or otherwise never in the runtime
store) that a client cannot remove at runtime. A caller reading only the status code cannot
tell them apart, so the dashboard has to re-fetch `GET /$mqtt` after a `204` and check
whether the url is still listed to know whether anything happened.

## The deployed device needs this firmware before its dashboard can clear aliases

`handleAliasPost` now accepts a zero-length body as an alias clear, matching
`dashboard/src/alias.js`, which sends one. The device updates over OTA
(`POST /$update`), not by reflashing, so a board still running older firmware
answers `400 "body must be a JSON string"` to that clear and the alias comes
back on the next `$alias` frame until it receives this build.

## Smaller items

- `signal_store::indexOf()` and `alias_store::indexOf()` have no self-test
  check. The alias self-test casts `indexOf()`'s result to `uint8_t`, so a `-1`
  would read as 255 and `topicAt()` would return NULL, passing the check for
  the wrong reason.
- `REPLAY_PER_LOOP` bounds the frames a replay sends per `web_ui::loop()`, not
  the cursor steps it takes: a subscriber whose filters match nothing walks all
  64 indices in one pass. Bounded and cheap, but it is the loop's worst case
  and nothing states it.
- The keepalive's write-failure path (`web_ui.cpp:985`) is the one place a
  stopped client is not routed through `releaseSlot()`, so its filters and
  replay cursor stay set. Inert, because every reader gates on `_sse[i]` first
  and `handleEvents()` overwrites both when the slot is reused.
- The OTA token is compared with Arduino `String::operator==`
  (`web_ui.cpp:593-598`), which returns on the first differing byte. Over a LAN
  with a TCP handshake per request, jitter swamps a one-byte delta, so this is
  not practically exploitable; it is worth a constant-time compare only because
  it guards the firmware-flash path.
- `tools/fetch_coredump.sh` executes `$HOME/.platformio` paths with no existence
  check and hardcodes the `0xFF0000 0x10000` offset rather than reading `partitions.csv`, so
  a re-laid-out partition table reads the wrong 64 KiB and reports a corrupt dump.
- `tools/flash-ota.js:65` calls `main()` with no `.catch()`, so an unreachable
  host prints a raw `TypeError: fetch failed` stack instead of a message, and
  `readEnvToken` (`:14`) does not strip a leading `export ` the way
  `load_env.py:28-29` does, so a `.env` the firmware build accepts makes
  flash-ota report "no OTA_TOKEN in the environment or receiver/.env".
- `monitor.py:80-91` declares `--reset/-r` as `action="store_true",
  default=True`, so the flag is a no-op and `args.reset` is never read (`:138`
  tests `args.no_reset`). Harmless today, wrong the moment the default changes.
- `mqtt_publish_store::add()` doesn't reject a url identical to the build-flag
  `MQTT_BROKER_URL` default — adding it again from the dashboard creates two
  connections to the same broker under the same client ID, which most brokers
  resolve by kicking one session, producing an endless connect/disconnect flap.
- Every `mqtts://` bridge is pinned to the ISRG Root X1 CA with no way to
  configure another; a broker not chained to Let's Encrypt (a commercial cloud
  broker, a self-signed LAN broker) will fail its handshake silently, showing
  only a dot that never turns green.
- `mqtt_publish::begin()` tears down and reconnects every configured
  connection on every `POST /$mqtt`/`/$mqtt/remove` (`mqtt_publish.cpp:207-221`),
  not just the one that changed, so adding or removing one bridge drops and
  re-handshakes every other already-working bridge too — up to ~15 s per TLS
  connection, plus a full `replayAll()` re-publish to each. Diffing the table
  against the live connections to leave unchanged slots alone would avoid
  this, at the cost of the per-slot comparison logic (url, token, plain-vs-TLS)
  that produced the original teardown bug in the first place.
- `signal_store::device()` rebuilds `_order` and runs an insertion sort over every
  used slot on each call. All four callers pass 0, all from `WebReceiver.ino`
  immediately after a successful `record()`, and the slot just written always has
  the highest `_seq`, so `device(0)` is by construction the slot `record()` just
  touched. Having `record()` return or stash that index takes an O(n²) sort off the
  per-decode path; `web_ui` uses `slotAt()` and has no other need for `device()`.
- `web_ui::loop()` calls `reapClosedClients()` unconditionally at the top and again
  inside the keepalive branch, and each call costs an `operator bool` plus a
  `recv(MSG_DONTWAIT|MSG_PEEK)` syscall per SSE slot. At loop rate that is thousands
  of syscalls a second to notice something that matters within a second or two.
  Gating it on a ~100 ms timer like the keepalive changes slot-free latency by at
  most that much.
- `mqtt_publish::aliasPayload()` builds a `JsonDocument` to escape one string, and
  `replayAll()` calls it once per alias, so a broker reconnect costs up to 32
  heap-allocating documents. `web_ui::writeJsonString` does the same escaping without
  allocating and is already exported in `web_ui.h`.
- Each record is serialised twice: `mqtt_publish::onRecord` writes the doc into a
  601-byte stack buffer and `signal_store::record()` writes the identical doc into
  `sub.payload` a few lines later. Serialising once into `sub.payload` and publishing
  from there means changing the hook contract from "gets the doc" to "gets the
  serialised payload", so it is worth doing only if the decode path measures hot.
- `claimRain()` in `device_hooks.cpp` always evicts the clock-less entry. `localDay()`
  returns 0 before the first SNTP sync, so any baseline recorded pre-sync has `day == 0`
  and is the permanent eviction victim, and its `rain_today_mm` is meaningless until the
  clock arrives because the rollover branch never fires. Skipping the hook while
  `localDay() == 0` would avoid both.
- `setupConnection()` sets `enabled = false` and returns early on a broker URL it cannot
  parse, but the caller increments `_connCount` regardless, so `count()`, `urlAt()` and
  `connectedAt()` — and through them `GET /$mqtt` — list a bridge that will never connect
  and give no reason for it.
- `buildKey()` truncates `doc["id"]` into a 16-byte buffer, so two sensors sharing a
  15-character prefix map to one key and one slot and interleave their readings.
  Everywhere else `buildKey` rejects rather than truncates, and has a self-test for it;
  the `id` segment is the one inconsistent spot.
- A `POST /<topic>/$alias` with a name longer than `ALIAS_NAME_MAX` answers `204` and
  stores 31 characters. `web_ui.cpp` checks the topic length and returns `400` for a long
  one, but nothing checks the name, and `alias_store::set` truncates. The truncation at
  least propagates consistently, because the handler re-reads the stored value for the
  broadcast.
- `signal_store::totalRecorded()` and `droppedCount()` have no caller outside
  `selfTest()`, though `_total` and `_dropped` are maintained on every record. The
  Receiver telemetry card reports heap, uptime and recovery count but not decode or drop
  counts, which are the obvious two fields to add if that was the intent.
- `strncpy` into `item.payload` in `rtl_433_Callback` zero-pads the whole 512-byte field,
  so a typical 120-byte decode writes about 390 wasted bytes on the decoder task.
  Marginal, since `xQueueSend` copies the struct either way.
