# Backlog

Known gaps, in rough priority order. None of these break the receiver as it
stands; each was found during review or hardware testing and deliberately left.

## Constants duplicated between the firmware and the page

`index_html.h:50` caps the browser's device table at `DEVICE_MAX = 24` to match
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
`CHUNK_BUDGET_MS` 1.5 s total budget (`web_ui.cpp:89-90`) before dropping the
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

## Smaller items

- `WebReceiver.ino:169-171` has `#ifndef LOG_LEVEL / LOG_LEVEL_SILENT / #endif`,
  a bare expression statement rather than a `#define`, so it does nothing if
  `LOG_LEVEL` is ever undefined. Inherited from the upstream example; the build
  always defines `LOG_LEVEL`, so it is inert.
- `platformio.ini:46` still labels the pin map "ESP32-S3-CAM", copied from the
  upstream example. The pins are right; the board name is not.
- There is no test framework. `signal_store` has a `FAKE_SIGNALS` self-test that
  also compiles and runs on the host against real ArduinoJson, which is how its
  17 checks are verified; everything else is compile plus hardware. A PlatformIO
  `native` environment would make the store's tests a normal `pio test`.
