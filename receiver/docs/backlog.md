# Backlog

Known gaps in the receiver, in rough priority order. None break it as it stands; each was
found during review or hardware testing and deliberately left. Anything spanning
sub-projects is in [`../../docs/backlog.md`](../../docs/backlog.md).

## Nothing filters false decodes

All 214 decoders in `rtl_433_devices.h` are compiled in, and the weak ones
claim noise: a device shows up once, never repeats, and reads humidity 154,
wind direction 458°, or 5768 hPa. New devices now start with no card, which
keeps them off the dashboard but still lists them. Real filters, cheapest
first: define `MY_DEVICES` and list only the protocols in use, which also
frees flash; hold a new key until it is heard twice; or range-check the common
fields (`humidity` 0–100, `wind_dir_deg` 0–360, `pressure_hPa` 800–1100). The
first is a build flag and the others need firmware.

A `mic` filter would not help. Cotech-36-7959, Telldus-FT0385R, and
Watts-WFHTRF all declare `"mic":"CRC"` or `"CHECKSUM"`, so these payloads
passed the decoder's own integrity check. A checksum that short passes on
noise often enough to produce what the table shows.

## No path in or out for sensors that are not 433 MHz decodes

The receiver's own card proved the shape: anything recorded through
`signal_store::record()` becomes a device the page already knows how to draw,
alias, and lay out. Nothing else uses it. Three directions, none started:

- A wired sensor on the I2C bus at GPIO 21 (SDA) and GPIO 47 (SCL), recorded
  the same way. The BMP280 driver reads temperature and pressure every 30 s
  and records them through `signal_store::record()`. The bus is sized for an
  AHT20 later. Add 10k pull-ups to 3V3 at the sensor header unless the breakout
  provides them.
- Ingest from elsewhere: an authenticated `POST /api/signal` taking the same
  rtl_433 JSON is about twenty lines and no new dependency. An MQTT
  subscription needs a broker and roughly 10 KB of flash, against 144 KB free.
  ESP-NOW suits battery nodes but pins them to the station's WiFi channel.
- Egress to home automation: publishing each decode to
  `rtl_433/<host>/devices/<model>/<id>/<field>` matches what rtl_433's own
  `-F mqtt` emits, so existing Home Assistant setups would take it unchanged.
  A `GET` of a topic from an HA REST sensor works today with no firmware
  change at all, and is the cheapest first step.

## A below-floor noise reading has no error marking on the card

The health monitor already surfaces the signature: `NOISE_FLOOR_DBM` feeds a
floor at or below the SX1231's measurement floor (about -120 dBm, e.g. the
-125 dBm seen when the chip was stuck refusing OP_MODE writes) into the
`pinned` state, and the telemetry carries `radio_ok`, `noise_dBm`, and
`rssi_thresh`. But the receiver card still renders `noise_dBm` as a plain
value with no error marking, so a broken radio reads as merely quiet. Add a
page indicator keyed on `radio_ok`.

## The library dependency is pinned to a branch, not a commit

`platformio.ini:13` points at `jbroll/rtl_433_ESP#sx1231-support`. PlatformIO
resolves that once and caches it, so a build here and a build on another
machine can silently differ, and a new fork commit changes the firmware without
anything in this repo changing. Pinning the commit sha fixes it at the cost of
an edit per library update.

## The decode path still allocates

Beyond the `JsonDocument` and `String` noted below: ArduinoJson 7.4.3's default
allocator is `malloc`/`realloc`, and it reallocs several times per parse. A
static pool (an `ArduinoJson::Allocator` subclass over a fixed buffer, passed to
the `JsonDocument` constructor) removes it without touching the parse.

## Heap allocation on the decode path

`signal_store::record()` builds a `JsonDocument` (`signal_store.cpp:116`) and
calls `.as<String>()` on `doc["id"]` and `doc["channel"]` (`:64`, `:66`) for
every decode. ArduinoJson 7
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
the image uses 28% of it. Cutting the false decodes above is.

## WiFi credentials are compiled into the image

`load_env.py` turns `.env` into `-D` build flags and the build stops with an `#error`
without them, so the SSID and password are baked into the binary. Every network change
needs a rebuild and a reflash, one image cannot be flashed to boards on different
networks, and the credentials are readable in a flash dump.

Provisioning at runtime is the fix, and most of its cost is already paid:
`libwifi_provisioning.a` (33,330 bytes) and `libsmartconfig.a` (38,160) are linked into
the image today and unused. A SoftAP portal on first boot, credentials in NVS, and a
long press or an unprovisioned boot to clear them would drop `.env` to a build
convenience rather than a requirement. The 1 MB `nvs` above leaves room for it.

## The firmware self-test has never been read on a device

`signal_store::selfTest()` and `alias_store::selfTest()` run at startup under
`FAKE_SIGNALS` and print a PASS/FAIL line per check, but nobody has seen those
lines. The board flashes and runs, and `ArduinoLog` writes to `Serial0`, a
hardware UART at 921600 baud, while the port exposed over USB is the S3's CDC
device. Reading the self-test needs a UART adapter on the TX pin, or the
sketch pointing `Log.begin()` at `Serial` so it comes out over USB. Until then
`signal_store`'s 31 checks and `alias_store`'s 21 are verified by compilation
and by reasoning, not by execution.

## An alias surviving a reboot is unverified

`alias_store::selfTest()` covers the in-RAM table and the round trip through a
serialised blob, but not `Preferences::putString()` actually landing in NVS
and surviving a power cycle — that needs hardware, like the self-test gap
above.

## Smaller items

- `WebReceiver.ino:244-246` has `#ifndef LOG_LEVEL / LOG_LEVEL_SILENT / #endif`,
  a bare expression statement rather than a `#define`, so it does nothing if
  `LOG_LEVEL` is ever undefined. Inherited from the upstream example; the build
  always defines `LOG_LEVEL`, so it is inert.
- `signal_store` and `alias_store` each have a `FAKE_SIGNALS` self-test that
  only compiles and runs on the device (see above); `topic` is the one module
  host-tested today. A PlatformIO `native` environment would make the other
  two stores' tests a normal `pio test` as well.
- `alias_store::remove()` calls `persist()` and ignores its result, so an NVS
  write that fails after a removal is silent and the alias returns on the next
  boot. `set()` reports the same failure to its caller, which answers `503`.
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
