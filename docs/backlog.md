# Backlog

Known gaps, in rough priority order. None of these break the receiver as it
stands; each was found during review or hardware testing and deliberately left.

The roadmap comes first: it is a program of four projects, of which this
receiver is one. The gaps below are about the receiver as it exists today.

# Roadmap: splitting the receiver into a source, a bridge, and a dashboard

Today the firmware is all three at once. It decodes, it holds the state, and it
serves a page shaped around its own device table. Nothing else can feed that
page and the page cannot read anything else, so a second receiver, a wired
sensor, or a real broker has no way in. Aliases live in one browser's
localStorage, so a name assigned in one place is invisible everywhere else.

Four projects, in dependency order. The first is done.

## 1. The HTTP binding for MQTT (spec)

`~/src/mqtt-http-bridge/docs/binding.md`. Three operations over stable
`<source>/<model>/<id>` topics, the rtl_433 JSON message as the payload, and an
alias at the source, device, and reading levels carried as a `$alias` topic.
Everything below is written against it. It now lives beside the bridge that
implements it.

## 2. `mqtt-http-bridge`

Built as a standalone service implementing the whole binding over a real broker.

## 3. The binding in the receiver

Replaces `/api/state`, `/events`, and `/api/status` with the source-only subset:
serves GET and `/events` for its own topics, accepts POST only to its own
`$alias` topics, persists those to NVS, and answers 405 to everything else.

This is where stable naming lands. Device keys become `<source>/<model>/<id>`
with `source` the existing mDNS name, which also retires the 48-byte key
collision noted below. Aliases move out of the browser and onto the device, so
a sensor named once is named for every viewer.

Doing the naming and the NVS aliases as a separate step ahead of this would
build the alias path twice, now that the spec exists. They are one project.

## 4. The dashboard as its own project

The page lifted out of `cards_html.h` and `index_html.h` into a project with a
build step, reading a configurable list of bridges rather than the host it was
served from. The receiver serves a build of it, so the single-device case still
works with no extra parts.

Layering stays as it is: the browser's own config wins, the bridge's `$alias`
next, the stable segment last. A build step also settles the flash cost, the
duplicated constants, and the minification questions the current PROGMEM page
cannot answer.

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
  Polling `/api/state` from an HA REST sensor works today with no firmware
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

## Constants duplicated between the firmware and the page

`index_html.h:58` caps the browser's device table at `DEVICE_MAX = 24` to match
`SIGNAL_DEVICE_SLOTS` in `signal_store.h:9`, and `LOG_MAX = 200` mirrors the
truncation the device already applies. Change one and nothing catches the
divergence — the page would silently keep a different number of rows than the
device tracks. The page is a PROGMEM string with no build step, so the fix is
either to serve the limits in `/api/state` and read them at runtime, or to
generate the constants into the page at build time.

## Ages skew for ~49 days after a millis() rollover

The page derives `offset` from the device's `now` on each fetch and ticks ages
locally. After the device's `millis()` wraps at about 49.7 days, every row's age
is wrong until that device is next heard from, and `refresh()` will not delete a
stale row because its `at` compares as newer. Ordering and eviction inside
`signal_store` are already rollover-proof — they key on the monotonic `_seq`
counter, not `lastSeen` — but the page has no equivalent. Fixing it properly
means sending a monotonic sequence to the page as well, or having the device
report ages rather than timestamps.

## Heap allocation on the decode path

`signal_store::record()` builds a `JsonDocument` (`signal_store.cpp:90`) and
calls `doc["id"].as<String>()` (`:45`, `:47`) for every decode. ArduinoJson 7
pools and reallocates, and `String` allocates outright, so both run against the
project's "static allocation only" rule. They are transient and uniformly sized,
so the footprint stays flat — free heap held steady across a 4 minute sample —
but the `String` is avoidable in two lines by formatting the id as an integer
and falling back only when it is genuinely a string.

## Device keys can collide

`buildKey()` formats `model/id` into `SIGNAL_KEY_MAX` = 48 bytes
(`signal_store.h:11`). Two sensors whose model names share a long prefix
truncate to the same key and merge into one slot, with their message counts
added together and their readings overwriting each other. rtl_433 model names
run past 48 characters — several device names in the decoder set exceed it — so
this is reachable, not theoretical. Either widen the key or hash the tail.

## A slow HTTP client can still stall the receive path

`ChunkedResponse::flush()` waits up to `CHUNK_WAIT_US` 150 ms per chunk with a
`CHUNK_BUDGET_MS` 1.5 s total budget (`web_ui.cpp:94-95`) before dropping the
client. That bound exists because aborting on the first not-ready probe
truncated the page and left the browser running no script at all. The cost is
that a genuinely slow reader can hold `loop()` for up to 1.5 s, and the
library's pulse-train ring is only two deep, so signals arriving during a stall
are overwritten. A healthy client never waits. Removing the risk entirely means
serving the page off a second task, which the single-task design deliberately
avoids.

## SSE eviction and auto-reconnect can churn

With all four stream slots busy, a new viewer evicts the longest-attached one,
whose browser reconnects five seconds later and evicts the next. Observed while
testing with five clients plus an open tab. It is self-limiting and only happens
when oversubscribed, but a viewer in that state sees the table reload
repeatedly. Raising the slot count or backing off the page's reconnect would
both help.

## A decode can be missed at page load

The page fetches `/api/state` once on load and again only on a genuine
reconnect. A decode landing between the device serialising that snapshot and the
`/events` socket being accepted is lost until that device transmits again. The
window is tens of milliseconds because the ESP32 web server handles one request
at a time. This is the accepted cost of dropping the previous behaviour, which
fetched the snapshot twice on every load.

## The card page costs more flash than budgeted

The Cards tab cost 21,876 bytes against a design expectation of under 15 KB
when that was last measured as a linked-size difference across three commits
with `pio run -e esp32s3-generic`. The `CARDS_HTML` literal is 26,162 bytes
today and `INDEX_HTML` 11,190, so the page is 37 KB of the image. The build
sits at 88.8% of flash, so nothing is at risk today, but the figure was never
brought back under the number it was written against. `CARDS_HTML` is not the
obvious target: comments are 5 KB of the 37 and leading indentation another 2,
both of which the project's own rules require, so the levers left are
gzip-encoding the page or minifying it, and each needs the build step the
design deliberately avoids. The bigger lever is elsewhere: the 319 compiled
decoders are 172,009 bytes of `.flash.text`, 15% of the image, and `MY_DEVICES`
in the fork's `rtl_433_devices.h` is what narrows them.

## The grid floors cells at 20px and can overflow the viewport

`measureGrid()` (`cards_html.h`) floors the cell side at 20px, which breaks
the letterboxing the README promises. At 24 columns on a 360px-wide phone
viewport the grid comes out 480px wide and the page scrolls sideways.

## Cards that overflow the row count jitter the grid

When cards overflow the set row count, the page grows a vertical scrollbar,
which shrinks `#cards`'s `clientWidth` and so the next cell `measureGrid()`
computes. It settles rather than looping, but the grid visibly jitters
between two sizes as it does. Fixing it means measuring against
`documentElement.clientWidth` or reserving the scrollbar gutter.

## A second pointer can still write layout mid-gesture

`setValueMode`, `setCardHidden`, `applyGridInput`, and a rename committed
with Enter all call `saveCardState()`, and all are reachable with a second
finger while a resize is in flight, which the project's rules say must not
write. No corruption results today: the in-flight resize has written nothing
yet, and `endResize` re-renders over whatever the second finger did. The
drag and resize entry points already guard against each other; these four
do not guard against either. `setValueMode` and `setCardHidden` are now
reachable from the device table as well as from a card.

## The firmware self-test has never been read on a device

`signal_store::selfTest()` runs at startup under `FAKE_SIGNALS` and prints a
PASS/FAIL line per check, but nobody has seen those lines. The board flashes
and runs, and `ArduinoLog` writes to `Serial0`, a hardware UART at 921600 baud,
while the port exposed over USB is the S3's CDC device. Reading the self-test
needs a UART adapter on the TX pin, or the sketch pointing `Log.begin()` at
`Serial` so it comes out over USB. Until then all 23 checks are verified by
compilation and by reasoning, not by execution.

## Gaps in the page tests

- Nothing covers `forgetLayouts()` against a throwing `localStorage`, or the
  Escape path out of a rename.
- The cell-side test re-derives `measureGrid()`'s own arithmetic inside the
  page and compares `--cell` against the global that arithmetic wrote, so a
  mistake mirrored in both places would still pass, and the 20px floor is
  never exercised. Measuring a rendered 1×1 card's box instead would test the
  arithmetic independently of it.
- The test named "no card overflows its box at any size or value count" can
  only catch overflow to the right and below: `scrollWidth`/`scrollHeight`
  don't account for content above or left of the box, and `.lbl` sits at
  `top:-.65em` by design. The name overclaims what the test checks.
- Nothing drives the two-pointer case where a card drag and a corner resize
  are in flight at once, which is the only way to reach the mutual-exclusion
  guards between them. It is testable: the suite already dispatches synthetic
  bubbling events from `page.evaluate`, and Chromium exposes real multi-touch
  through `Input.dispatchTouchEvent` over a CDP session.

## Smaller items

- `WebReceiver.ino:244-246` has `#ifndef LOG_LEVEL / LOG_LEVEL_SILENT / #endif`,
  a bare expression statement rather than a `#define`, so it does nothing if
  `LOG_LEVEL` is ever undefined. Inherited from the upstream example; the build
  always defines `LOG_LEVEL`, so it is inert.
- `platformio.ini:46` still labels the pin map "ESP32-S3-CAM", copied from the
  upstream example. The pins are right; the board name is not.
- `signal_store` has a `FAKE_SIGNALS` self-test that also compiles and runs on
  the host against real ArduinoJson, which is how its 23 checks are verified.
  The page has Playwright tests under `test/`. The firmware itself is still
  compile plus hardware; a PlatformIO `native` environment would make the
  store's tests a normal `pio test`.
- The card view's font-size factor of 0.42 and its 11–64px clamp were tuned
  against a handful of synthetic devices. A wrong factor leaves a card sparse or
  crowded; it cannot overflow, because both axes use `minmax(0,1fr)` and `.fv`
  ellipsizes.
- `fitValues()` caps the type size by measuring the text on a canvas at the
  font family `getComputedStyle(document.body)` reports. That matches what the
  page renders today, but the measurement ignores letter-spacing and any
  font-feature settings, so a future style change to `.fv` could make the
  estimate too small and bring the ellipsis back. It errs about 4px high per
  value at 64px, which is why it shrinks slightly more than strictly needed.
  A card whose widest reading cannot fit even at 11px still ellipsizes.
- `measureGrid()`'s `cols × cell` arithmetic is exact only because the grid
  has no `gap`; the spacing moved to `.card { margin:.35rem }`. Re-adding a
  `gap` would overflow the grid by `(cols-1) × gap`. Nothing in the file says
  so, and no test guards it.
- A stored `w` or `h` outside 1–24 is discarded rather than clamped, so the
  card is re-sized from its value count instead of pinned to 24.
- `#grid-size` is fixed at `right:12rem` and is about 7rem wide, so below
  roughly 320px of viewport width it reaches the left edge and overlaps the
  grid in edit mode.
