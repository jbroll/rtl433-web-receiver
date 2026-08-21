# Backlog

Known gaps in the receiver, in rough priority order. None break it as it stands; each was
found during review or hardware testing and deliberately left. Anything spanning
sub-projects is in [`../../docs/backlog.md`](../../docs/backlog.md).

## No path in or out for sensors that are not 433 MHz decodes

The receiver's own card proved the shape: anything recorded through
`signal_store::record()` becomes a device the page already knows how to draw,
alias, and lay out. Nothing else uses it. Three directions, none started:

- A wired sensor on the I2C bus at GPIO 47 (SCL) and GPIO 21 (SDA), recorded
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
the image uses 28% of it. False decodes are filtered by firmware now (see
`architecture.md`), so nothing currently motivates narrowing the compiled decoder set
either.

## The firmware self-test has never been read on a device

`signal_store::selfTest()` and `alias_store::selfTest()` run at startup under
`FAKE_SIGNALS` and print a PASS/FAIL line per check, but nobody has seen those
lines. The board flashes and runs, and `ArduinoLog` writes to `Serial0`, a
hardware UART at 921600 baud, while the port exposed over USB is the S3's CDC
device. Reading the self-test needs a UART adapter on the TX pin, or the
sketch pointing `Log.begin()` at `Serial` so it comes out over USB. Until then
`signal_store`'s 51 checks and `alias_store`'s 22 are verified by compilation
and by reasoning, not by execution.

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

- `signal_store` and `alias_store` each have a `FAKE_SIGNALS` self-test that
  only compiles and runs on the device (see above); `topic` is the one module
  host-tested today. A PlatformIO `native` environment would make the other
  two stores' tests a normal `pio test` as well.
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
