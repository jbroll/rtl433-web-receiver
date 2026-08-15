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

- A wired sensor on a spare GPIO (a DS18B20 on 1-Wire) recorded the same way.
  Bit-banged 1-Wire masks interrupts for tens of microseconds per bit, and the
  decoder timestamps every DIO2 edge in an ISR, so a read can cost a decode.
  The RMT-based 1-Wire driver avoids that and is the way in if this happens.
- Ingest from elsewhere: an authenticated `POST /api/signal` taking the same
  rtl_433 JSON is about twenty lines and no new dependency. An MQTT
  subscription needs a broker and roughly 10 KB of flash, against 144 KB free.
  ESP-NOW suits battery nodes but pins them to the station's WiFi channel.
- Egress to home automation: publishing each decode to
  `rtl_433/<host>/devices/<model>/<id>/<field>` matches what rtl_433's own
  `-F mqtt` emits, so existing Home Assistant setups would take it unchanged.
  A `GET` of a topic from an HA REST sensor works today with no firmware
  change at all, and is the cheapest first step.

## Radio SPI is shared between two tasks with no lock

`rtl_433_ReceiverTask` runs on core 0 and reads RSSI over SPI continuously
(`rtl_433_ESP.cpp:934`); `radioTemperature()` in `WebReceiver.ino` reads the
temperature registers from the loop task on core 1. RadioLib's `Module` has no
mutex. `disableReceiver()` only clears a flag and detaches the interrupt, with
no acknowledgement that the task has left its body, so the `delay(5)` that
follows is a heuristic, not a barrier. The measurement is bounded and
`receiveDirect()`'s return is checked, so a lost transaction costs one sample
rather than a hung loop, but the race is still there. The fix is to keep all
radio SPI on one task: a request flag the receiver task picks up at the top of
its own iteration, publishing the reading back.

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
`rtl_433_devices.h` is what narrows them, and it would also cut the false decodes above.
The page is no longer a lever: it is gzipped, and its size is recorded in
[`architecture.md`](architecture.md#the-page-the-firmware-serves).

## The partition table uses 4 MB of a 16 MB chip

`platformio.ini` sets `board = esp32s3box` and no `board_build.partitions`, so the build
inherits Arduino's `default.csv`: `app0` and `app1` at 1.25 MB each, `spiffs` at 1.44 MB,
4 MB in total. The board and the bootloader header both declare 16 MB, so 12 MB is not
addressed by any partition. The image is 1,156,725 bytes, 88.3% of `app0` and 7% of the
chip, which is why the flash figure reads as tight when it is not.

A table filling the chip, with NVS given room it will not run out of:

| Partition | Type | Subtype | Offset | Size |
|---|---|---|---|---|
| `nvs` | data | nvs | `0x9000` | `0x100000` (1 MB) |
| `otadata` | data | ota | `0x109000` | `0x2000` |
| `app0` | app | ota_0 | `0x110000` | `0x400000` (4 MB) |
| `app1` | app | ota_1 | `0x510000` | `0x400000` (4 MB) |
| `spiffs` | data | spiffs | `0x910000` | `0x6E0000` (6.875 MB) |
| `coredump` | data | coredump | `0xFF0000` | `0x10000` |

App partitions need 64 KB alignment, which is what leaves the 20 KB gap after `otadata`.
The image would sit at 27.6% of `app0`, and `MY_DEVICES` stops being a size question.

`nvs` moves and grows, so the alias table is erased on the first boot after reflashing.
`esptool read_flash 0x9000 0x5000 nvs.bin` before the change captures it; restoring is a
`POST` per alias, or the SSE replay read back through `GET /events`.

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

## Smaller items

- `WebReceiver.ino:244-246` has `#ifndef LOG_LEVEL / LOG_LEVEL_SILENT / #endif`,
  a bare expression statement rather than a `#define`, so it does nothing if
  `LOG_LEVEL` is ever undefined. Inherited from the upstream example; the build
  always defines `LOG_LEVEL`, so it is inert.
- `platformio.ini:46` still labels the pin map "ESP32-S3-CAM", copied from the
  upstream example. The pins are right; the board name is not.
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
  56 indices in one pass. Bounded and cheap, but it is the loop's worst case
  and nothing states it.
- The keepalive's write-failure path (`web_ui.cpp:519`) is the one place a
  stopped client is not routed through `releaseSlot()`, so its filters and
  replay cursor stay set. Inert, because every reader gates on `_sse[i]` first
  and `handleEvents()` overwrites both when the slot is reused.
