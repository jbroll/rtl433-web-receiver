# Backlog

Known gaps in the receiver, in rough priority order. None break it as it stands; each was
found during review or hardware testing and deliberately left. Anything spanning
sub-projects is in [`../../docs/backlog.md`](../../docs/backlog.md).

## The provisioning portal is an open AP that hands out an OTA token

`WiFi.softAP(ap, nullptr)` (`provisioning.cpp:233`) brings up an unencrypted network, and
`handleRoot()` (`:108-110`) generates a fresh token with `randomToken()` and renders it
into the form on every GET; `handleSave()` (`:201`) stores whatever the form returns.
Anyone in range of a board sitting in the portal can join, submit their own SSID and a token they chose,
and take the board onto their network with an OTA credential they control. `POST /$update`
then accepts arbitrary firmware. A WPA2 password on the SoftAP, printed on the device or
derived from the chip ID, is the smallest fix.

## A failed sub claim leaves a device slot allocated

`signal_store::record()` runs `claimSlot()` (which increments `_deviceCount`), copies the
key, and sets `used = true` at `:254-258`, before `claimSub()` can fail at `:266-272`. When
it does, `record()` does `_dropped++; return false;` and leaves a slot with `lastSeen == 0`,
`count == 0` and no sub. With 32 subs already allocated and a new device promoted from
pending, the store reports one more device than exists, `device()` orders a slot whose
`latestPayload()` is NULL, a `GET` of its key answers 404, and nothing reclaims it until
`sweepStale()` measures `millis() - 0` past `DEVICE_STALE_HOURS`. Claiming the sub first,
or releasing the slot on the failure path, fixes it.

## Recovery attempts write NVS without bound

`health_store.h:22` says the recovery counters are "Bounded: once per recovery event," but
recovery events are themselves unbounded when the radio is permanently deaf.
`radio_health::decide()` re-arms every `RECOVERY_BACKOFF_MS` (120 s) and
`monitorRadioHealth()` runs once per 60 s telemetry cycle, so a stuck SX1231 drives a
`putUInt(recovery_count)` and a `putLong(last_recovery)` every two minutes for as long as
the board is powered — about 720 entry writes a day. That is under flash endurance at a few
thousand page erases a year, but it is the case `architecture.md` says the firmware
deliberately never reboots for, so it runs indefinitely. Either cap the counter writes or
correct the header.

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

`signal_store::record()` builds a `JsonDocument` (`signal_store.cpp:116`) and
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
`CHUNK_BUDGET_MS` 1.5 s total budget (`web_ui.cpp:111-112`) before dropping the
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

## No way to clear or disable a set OTA token

`ota_token_store` has no `clear()`, and the SoftAP portal always overwrites
the stored token with a freshly generated one on every provisioning pass
(`provisioning.cpp`). Once a token has been set there's no path back to the
"OTA disabled" (`404`) state short of erasing NVS entirely. Not a bug, just
a gap for anyone who wants to disable OTA after enabling it.

## Smaller items

- `signal_store::indexOf()` and `alias_store::indexOf()` have no self-test
  check. The alias self-test casts `indexOf()`'s result to `uint8_t`, so a `-1`
  would read as 255 and `topicAt()` would return NULL, passing the check for
  the wrong reason.
- `REPLAY_PER_LOOP` bounds the frames a replay sends per `web_ui::loop()`, not
  the cursor steps it takes: a subscriber whose filters match nothing walks all
  64 indices in one pass. Bounded and cheap, but it is the loop's worst case
  and nothing states it.
- The keepalive's write-failure path (`web_ui.cpp:519`) is the one place a
  stopped client is not routed through `releaseSlot()`, so its filters and
  replay cursor stay set. Inert, because every reader gates on `_sse[i]` first
  and `handleEvents()` overwrites both when the slot is reused.
- The OTA token is compared with Arduino `String::operator==`
  (`web_ui.cpp:444-445`), which returns on the first differing byte. Over a LAN
  with a TCP handshake per request, jitter swamps a one-byte delta, so this is
  not practically exploitable; it is worth a constant-time compare only because
  it guards the firmware-flash path.
- `load_env.py:33` does `shlex.split(value)[0]`, which raises `IndexError` on an
  empty value — a blanked-out `MQTT_TOKEN=` aborts `pio run` with a traceback out
  of an extra_script, naming no line — and silently takes only the first token of
  an unquoted multi-word one, so `WIFI_PASSWORD=my pass` compiles the password as
  `my` and the board just fails to associate.
- `tools/fetch_coredump.sh:10` writes `core.bin` into `receiver/tools/`, which
  `.gitignore` does not cover, so a `git add -A` would commit a flash dump holding
  the WiFi password and OTA token that `load_env.py` compiled in. The same script
  (`:8-11`) executes `$HOME/.platformio` paths with no existence check and
  hardcodes the `0xFF0000 0x10000` offset rather than reading `partitions.csv`, so
  a re-laid-out partition table reads the wrong 64 KiB and reports a corrupt dump.
- `tools/flash-ota.js:65` calls `main()` with no `.catch()`, so an unreachable
  host prints a raw `TypeError: fetch failed` stack instead of a message, and
  `readEnvToken` (`:20`) does not strip a leading `export ` the way
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
  connection on every `POST /$mqtt`/`/$mqtt/remove` (`mqtt_publish.cpp:203-217`),
  not just the one that changed, so adding or removing one bridge drops and
  re-handshakes every other already-working bridge too — up to ~15 s per TLS
  connection, plus a full `replayAll()` re-publish to each. Diffing the table
  against the live connections to leave unchanged slots alone would avoid
  this, at the cost of the per-slot comparison logic (url, token, plain-vs-TLS)
  that produced the original teardown bug in the first place.
