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

## The one second render tick wipes an open card rename

`index_html.h:218` re-renders the cards every second to age the timestamps, and
`renderCards()` rebuilds every card from scratch. A rename input open longer
than that is removed mid-typing and the typed text is lost. Card dragging
already suppresses the tick while a drag is in progress (`cards_html.h`,
`if (dragging) return;`); a rename needs the same, or the renderer needs to
update ages in place rather than rebuild.

## The card page costs more flash than budgeted

The Cards tab now costs 21,876 bytes against a design expectation of under
15 KB. The grid redesign moved it by 4,192 bytes. Both figures are linked
firmware sizes from `pio run -e esp32s3-generic`, differenced across three
commits, not the size of the literal; rerunning that diff reproduces them.
For reference, the `CARDS_HTML` literal itself is about 21.5 KB now, against
about 17.3 KB before this work. The build sits at 86% of flash, so nothing
is at risk today, but the figure was never brought back under the number it
was written against. `CARDS_HTML` is no longer the obvious target: of its
bytes roughly 4 KB is CSS and roughly 2 KB is the explanatory comments the
project's own rules require, so the only real lever left is gzip-encoding
the page, which needs the build step the design deliberately avoids.

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

`toggleValue`, `toggleCardHidden`, `applyGridInput`, and a rename committed
with Enter all call `saveCardState()`, and all are reachable with a second
finger while a resize is in flight, which the project's rules say must not
write. No corruption results today: the in-flight resize has written nothing
yet, and `endResize` re-renders over whatever the second finger did. The
drag and resize entry points already guard against each other; these four
do not guard against either.

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

- `WebReceiver.ino:169-171` has `#ifndef LOG_LEVEL / LOG_LEVEL_SILENT / #endif`,
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
- `measureGrid()`'s `cols × cell` arithmetic is exact only because the grid
  has no `gap`; the spacing moved to `.card { margin:.35rem }`. Re-adding a
  `gap` would overflow the grid by `(cols-1) × gap`. Nothing in the file says
  so, and no test guards it.
- `valueRows` is computed from the values currently shown, and edit mode
  shows hidden values too, so opening edit mode shrinks the type and closing
  it grows it back. One test works around this by toggling edit off before
  measuring.
- A stored `w` or `h` outside 1–24 is discarded rather than clamped, so the
  card is re-sized from its value count instead of pinned to 24.
- `#grid-size` is fixed at `right:12rem` and is about 7rem wide, so below
  roughly 320px of viewport width it reaches the left edge and overlaps the
  grid in edit mode.
