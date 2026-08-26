# Backlog mitigation plan

Every entry in [`backlog.md`](backlog.md) is either in a batch below or in
[Not worth doing](#not-worth-doing) with a reason. Batches are sized to land as one commit
each. Line references are against the tree at the time this was written.

## What did not survive checking

Read these before planning around the backlog text.

- **The root backlog's CI blocker is gone.** [`../../docs/backlog.md`](../../docs/backlog.md)
  says "ten of the tracked `debug-*.spec.js` files navigate to a hardcoded LAN address, so
  it fails anywhere but that subnet". There are no `debug-*.spec.js` files. Fifteen of them
  were deleted in commit `b13e710`. `git ls-files dashboard/test` lists 17 `*.spec.js` files
  and none of them contains a LAN address. `npx playwright test test/units.spec.js
  test/devicesort.spec.js` passes here, 10/10. The root backlog paragraph is stale and
  should be rewritten in the same commit as Batch 1.
- **`const TZ = zones()` is not at module scope.** The backlog says `location.jsx` "calls
  `zones()` at module scope through `const TZ = zones()`". It is inside `LocationView`
  (`src/location.jsx:77`), which is why the array and the ~450 option VNodes are rebuilt on
  every render. The consequence the entry describes is real; the location it names is wrong.
- **`onBoundsChanged` is already guarded against no-op zooms.** `src/location.jsx:139` fires
  only when `loc.lat !== null && Math.round(zoom) !== loc.zoom`, so a z3→z15 scroll issues
  12 `setLocation` calls, not one per wheel event. Each of those still POSTs `$tz` and
  `$location`, which gets to the entry's "about 24 POSTs". The count holds; the mechanism is
  one call per integer zoom step.
- **`orderedKeys()` is dead in `src/` but live in the tests.** The dead-code entry lists it
  alongside genuinely unreferenced exports. `test/store.test.js:32,34,75` asserts on it.
  Deleting it means deleting those three assertions too.
- **Line numbers in the overflow entry have drifted.** `overflow:hidden` on `.card .val` is
  `src/style.css:72` and on `.card .fv` is `:97`, not 71 and 95. The claim itself holds.
  Note also that `.card .val` is declared twice (`:71` and `:100`) with the same
  `line-height:1.05`; Batch 11 has to change both.

Not checked: whether the full Playwright suite passes end to end (only two spec files were
run), and whether the Capacitor shell's WebView reaches the abort-probe path the Android
smoke script assumes.

## Batch order

Batch 1 unblocks adding the suite to CI and should land first, because every later batch is
verified by that suite. Batches 3 and 4 both touch `store.js` / `cards.jsx` re-render
behavior and 4 depends on 3's tick change landing first. Batch 9 (render cost) depends on
Batch 3, which removes the per-second full re-render that would otherwise mask its
measurements. Batch 7 depends on Batch 6, because the feed context carries the zone that
Batch 6 fixes. Everything else is independent.

```
1 ─ 2
    3 ─ 4 ─ 9
    6 ─ 7
    5, 8, 10, 11, 12, 13, 14   (independent)
```

---

## Batch 1 — Pin the suite to its tracked specs and block outbound requests

Backlog items: the `**/*.spec.js` testMatch; the missing default network guard.

**Files:** `playwright.config.js`, new `test/pw.js`, the import line of all 17 `test/*.spec.js`,
`test/multi.spec.js`, `docs/architecture.md` (Tests section), `../../docs/backlog.md`.

**Change.** Replace `testMatch: "**/*.spec.js"` with an explicit array of the 17 tracked
basenames, so an untracked scratch spec dropped into `test/` never runs. A new spec then
needs one config line; say so in a comment.

Add `test/pw.js` exporting `test` and `expect`. `test` extends `@playwright/test`'s with a
`page` fixture that, before handing the page over, installs

```js
await page.route("**/*", route => {
  const h = new URL(route.request().url()).hostname
  return h === "127.0.0.1" || h === "localhost" ? route.continue() : route.abort()
})
```

Playwright matches the most recently registered route first, so a spec's own
`routeWeather()`/`routeTiles()` still wins. Export a `guardContext(context)` helper doing the
same against a context, and call it in `multi.spec.js` for the two `browser.newContext()`
pages (`:158`, `:172`), which bypass the `page` fixture. Change every spec's
`import { test, expect } from "@playwright/test"` to `from "./pw.js"`.

**Test.** Add one spec that sets a location without calling `routeWeather()` and asserts the
weather card shows an error field rather than data. It fails before the guard (the live
service answers) and passes after.

**Risk.** Low but broad: the import change touches every spec. A spec that legitimately
needs an outside host would now abort silently; there is none today. Enumerating specs in the
config is a maintenance cost paid once per new spec.

## Batch 2 — Repair the Android smoke script

Backlog item: both Android smoke steps are stale after the gear-panel split.

**Files:** `test/android-smoke.js`.

**Change.** Drop the `page.click("#settings summary")` at `:34`: `settings.jsx` renders a
plain `<div id="settings">` and `main.jsx:217`/`abortProbe()` already leave
`settingsTab === 'settings'`, so the pane is up. Replace `page.click("#tab-devices")` at
`:48` with `page.click("#subtab-devices")` — the gear button only sets `tab`, and
`devices-table.jsx:144` gates rows on `settingsTab.value === 'devices'`.

**Test.** The script is the test. It cannot run in CI without a device; run it by hand
against the tablet once. Note in the commit message that it was verified that way.

**Risk.** Low. Nothing else reads this file. If the shell's origin probe succeeds rather than
aborting, the script lands on the cards tab and `:33` fails instead — unverified either way,
so keep `:33`'s wait as the first thing that fails loudly.

## Batch 3 — Flash, and the per-second re-render it causes

Backlog items: the flash class latches on and never clears; every card re-renders once a
second.

**Files:** `src/cards.jsx`, `src/devices-table.jsx`, `test/cards.spec.js`.

**Change.** `cards.jsx:90` and `devices-table.jsx:47` compare `rec.flashUntil.value`
(`Date.now() + 1000`, set in `main.jsx:43`) against `tick.value`, a counter that starts at
zero. Compare against `Date.now()` in both. That drops the `tick.value` read out of `Card`,
leaving `Age` (`cards.jsx:281`) as the only per-second subscriber, so only that leaf
re-renders each second instead of `Label`, `Body`, every `Value` and `BottomStrip`.

A card must still stop flashing on its own. With no `tick` read in `Card`, nothing
re-renders to remove the class after the second elapses. Give the flash its own short-lived
signal: set `flashUntil`, and schedule the class removal from the same place that sets it —
either a `setTimeout` in `main.jsx`'s `onMessage` flipping a per-record `flashing` signal
false after 1000 ms, or a dedicated fast tick that only `Card`'s class expression reads.
The first is fewer moving parts; the second keeps `main.jsx` free of timers, which the
`tick.js` comment says is the house rule. Pick the first and note the exception.

**Test.** `cards.spec.js` currently asserts only that `.flash` appears. Extend it: send a
message, assert `.flash` present, wait past 1 s, assert it absent, send a second message,
assert it present again. The last step is the one the current bug fails.

**Risk.** Medium. The flash is the one place a card's class depends on wall time, and the
per-second re-render was covering for its absence. Get the removal path wrong and the class
either never clears (status quo) or never appears.

## Batch 4 — Card state: persist it, notify on it, stop mutating it

Backlog items: `ensureCard()` does not save; `ensureCard()` does not `bump()`;
`pruneCardState()` mutates the live signal value and `bump()` shares `order`/`hidden` by
reference; `Card` dereferences `cardEntry(key)` unchecked; a stored `w`/`h` outside 1–24 is
discarded rather than clamped.

**Files:** `src/store.js`, `src/cards.jsx`, `test/store.test.js`, `test/cards.spec.js`.

**Change.**

1. `ensureCard()` (`store.js:102`) builds `c`, pushes to `s.cards`, `s.hidden` and `s.order`
   on the object `cardState.value` already holds. Have it track whether it changed anything
   and, if so, call `saveCardState()` on the way out (which already calls `bump()`). That
   covers both the unpersisted-layout entry and the stale-subscriber entry with one change.
   Guard against the write storm: `publish()` in `feeds/feed.js:54` already calls
   `ensureCard` then `saveCardState` every feed run, so make `ensureCard` idempotent-quiet —
   only save when it actually added a key or a field.
2. `bump()` (`:28`) copies `grid` and `cards` but passes `order` and `hidden` through. Copy
   both arrays. Then `pruneCardState()` (`:75`) can stop writing `s.order = ...` into the
   live value: have it return a new state object that `saveCardState` installs, rather than
   editing in place.
3. `loadCardState()` (`:44`) keeps an `order` entry with no `cards[k]`. After building
   `loaded`, filter `loaded.order` and `loaded.hidden` to keys present in `loaded.cards`.
   That is the cleaner half of the `Card` crash; add `if (!c) return null` at
   `cards.jsx:83` as the belt.
4. `gridNum(c.w, 0)` at `:66` discards an out-of-range `w`. Add a `clampGrid(v, fallback)`
   that returns `Math.min(24, Math.max(1, v))` for a finite integer and the fallback
   otherwise, and use it for `c.w`/`c.h` only — `grid.cols`/`grid.rows` keep `gridNum`,
   where discarding to the default is the right answer.

**Test.** `store.test.js`: after `ensureCard` for a new key, assert `localStorage` holds the
key and that a subscriber to `cardState` fired. Assert an earlier `cardState` snapshot's
`order` is unchanged after a prune. Assert a stored `{w: 99}` loads as `w === 24`.
`cards.spec.js`: seed `localStorage` with an `order` naming a key absent from `cards`, load,
and assert the page renders rather than throwing.

**Risk.** Medium-high. `pruneCardState`'s comment records two bugs already fixed there (the
Receiver card reappearing, hidden cards losing their size). Changing it to return a new
object rather than mutate must not change which keys it keeps. Keep the `keep` set logic
byte-identical and only change how the result is installed.

## Batch 5 — Stream, log rows, device eviction, and the empty-source status

Backlog items: `trim()` ends with a self-assignment; `stream.js` reconnects on a fixed 5 s
timer; `stream.js`'s `onerror` reads the wrong socket after a retry; `log.jsx`'s row key
collides; the status readout reports "live" with no sources.

**Files:** `src/devices.js`, `src/stream.js`, `src/log.jsx`, `src/app.jsx`,
`test/devices.test.js`, new spec assertions.

**Change.**

1. `devices.js:15` — `devices.value = devices.value` never notifies, because signals skip a
   `===` write. Build the survivors into a new Map and assign that, the way `clearSource`
   at `:45` already does.
2. `stream.js:19` — capture the instance: `const sock = new EventSource(...)`, assign
   `es = sock`, and have `sock.onerror` test `sock.readyState` and bail when `es !== sock`.
   That stops a superseded socket overwriting `retry` and leaking the earlier timer past
   `close()`.
3. Same handler: replace the flat `5000` with exponential backoff and jitter — attempt count
   in the closure, `Math.min(30000, 1000 * 2 ** n)` times `0.8 + 0.4 * Math.random()`, reset
   to zero in `onopen`. The receiver's matching entry is "SSE eviction and auto-reconnect can
   churn"; note in the commit that only the dashboard half is addressed.
4. `log.jsx:18` — key on a module-level counter incremented in `addLog`, stored on the entry.
5. `app.jsx:23` — return `'no sources'` (or reuse the `reconnecting` text) when
   `states.length === 0`, before the `live === states.length` test.

**Test.** `devices.test.js`: push past `DEVICE_MAX × sources` and assert a subscriber fired
and the evicted key is gone from the notified value. For the stream, a spec that kills the
source's SSE endpoint and asserts a second reconnect arrives later than 5 s after the first.
For the status, a spec loading with no sources and asserting the header does not read "live".

**Risk.** Low each, but four unrelated modules in one commit. Split if review prefers. The
backoff changes reconnect timing that other specs may wait on — grep for 5000-ish timeouts
in the specs before landing.

## Batch 6 — Zone resolution, location writes, and `$tz` refresh

Backlog items: `activeZone()` ignores a zone chosen without coordinates; `onBoundsChanged`
POSTs on every zoom change; reverse geocoding can clobber a newer pick; `$tz` is posted once
and never refreshed.

**Files:** `src/settings.js`, `src/location.jsx`, `src/main.jsx`, `test/settings.test.js`,
`test/location.spec.js`.

**Change.**

1. `activeZone()` (`settings.js:255`) reads `resolvedLocation().zone`, and
   `resolvedLocation()` (`:137`) falls through to the network layer whenever local `lat`/`lon`
   are null. Give the zone its own chain: local `settings.value.location.zone` if non-empty,
   else the resolved location's zone, else `localZone()`. That makes "your own choice always
   wins" true for the zone independently of coordinates.
2. `setLocation()` (`:214`) POSTs `$tz` and `$location` on any change. Zoom is a view
   preference. Either give it a separate `setZoom()` that writes settings without the POSTs,
   or have `setLocation` compare the cleaned object against the previous one and skip both
   POSTs when only `zoom` differs. The second keeps one entry point; prefer it.
3. `location.jsx:72` — capture `latitude`/`longitude` before the `await reverseGeocode(...)`
   and skip the `setLocation({ label })` when `settings.value.location.lat/lon` no longer
   match. Same shape for any future awaited write in this file.
4. `$tz`: keep the last posted offset in a module variable in `settings.js` and export a
   `refreshTz()` that recomputes `offsetMinutes(new Date(), activeZone())` and POSTs only on
   a change. Call it from the existing tick effect in `main.jsx:210`. One `Intl` construction
   per second is the cost; Batch 9's formatter cache removes it.

**Test.** `settings.test.js`: set a zone with no coordinates and assert `activeZone()`
returns it; set a network location with a different zone and assert the local one still
wins. A spec that changes only the zoom and asserts zero `$location` POSTs (the harness can
count them). A spec that picks a search result while a reverse geocode is pending and
asserts the label matches the newer pick. A unit test that moves the clock across a DST
boundary and asserts `refreshTz` posts once.

**Risk.** Medium. `setLocation`'s comment records why the POST gate is `clean` and never
`hasLocation()`; do not move that gate while adding the zoom comparison. The `$tz` refresh
adds a write path that fires on a timer — cap it behind the same
`sources.value.includes(location.origin)` check the existing POST uses.

## Batch 7 — Feed scheduling correctness

Backlog items: an in-flight feed run is neither aborted nor discarded on a location change;
the feed cache is wiped on every load of a fallback-location dashboard; sun and moon events
use the UTC calendar day; the sun renderer treats the em-dash placeholder as a real time;
the retry jitter contains nothing feed-specific; `pump()` resolves the location five times
per tick.

**Files:** `src/feeds/feed.js`, `src/astro.js`, `src/feeds/sun.js`, `src/renderers.jsx`,
`test/feeds.test.js`, `test/astro.test.js`, `test/sunmoon.test.js`, `test/feeds.spec.js`.

**Change.**

1. **Stale run.** `runFeed()` (`feed.js:67`) awaits `feed.run(ctx)` and publishes whatever
   comes back. After the await, compare `ctx.place` against the module's current `place` and
   return without publishing, caching, or setting state when they differ. That also removes
   the 30-minute backoff installed for a location never tried. An `AbortController` threaded
   into `nws.js`'s `get()` is the fuller fix; the place check is the one that stops the wrong
   data reaching the card, so do it first and file the abort separately if wanted.
2. **Cache wipe.** `primeFeeds()` (`:126`) sets `place = placeOf()` before any SSE frame, so
   it is `''` on a source-supplied location, and the first `pump()` treats `'' → "lat,lon"`
   as an invalidation and calls `cacheClear()`. Skip the invalidation when the previous
   `place` is empty: `if (next !== place && place !== '')`. Assign `place = next`
   unconditionally.
3. **UTC day.** `sunEvents` (`astro.js:66`) and `moonTimes` (`:179`) floor to
   `Date.UTC(getUTCFullYear(), getUTCMonth(), getUTCDate())`. Both need the local day for the
   feed's zone. Pass the zone in and derive the day from the zone-formatted parts (the same
   `Intl.DateTimeFormat(... timeZone ...).formatToParts` shape `feeds/zone.js:3` already
   uses), then build `start` from those. Callers are `sun.js:23` and `moon.js`; both already
   have `ctx.zone`.
4. **Em-dash placeholder.** `sun.js:34` puts `hhmm(e.sunrise, z)` — which returns `'—'` for
   null — into `riseText`, and `renderers.jsx:101` tests `!v.riseText`. Return `''` from
   `sun.js` when the event is null (it already does for `alwaysUp`/`alwaysDown`; extend the
   condition to `e.sunrise === null`), or route both through the moon renderer's `timeOf`
   (`renderers.jsx:134`). The first keeps the placeholder decision in one place.
5. **Jitter.** `feed.js:90` — hash the feed id into the multiplier alongside `fails`, e.g.
   sum the id's char codes and fold that in before the modulo.
6. **`pump()`.** `:99` calls `hasLocation()`, `placeOf()` (which calls `resolvedLocation()`
   and `hasLocation()` again), `resolvedLocation()`, and `activeZone()` (another
   `resolvedLocation()` plus `localZone()`). Resolve once at the top into `const l`, derive
   `place` and `zone` from it, and thread them down.

**Test.** `feeds.test.js`: a run that resolves after `place` changed publishes nothing.
A prime-then-pump sequence with an empty initial `place` leaves the cache intact.
`astro.test.js`/`sunmoon.test.js`: assert sunrise at UTC-7 after 17:00 local is today's, not
tomorrow's — this is the assertion that fails today. `feeds.spec.js`: a location above the
Arctic circle on an all-day-sun date shows "up all day" and no "↑ —".

**Risk.** Medium-high. The astro day change moves every sun and moon number by up to a day.
The existing astro tests use fixed dates and fixed expected times; some will need their
expectations recomputed, and recomputing them from the new code is circular. Derive at least
one expectation from an outside source (NOAA's calculator) before trusting the rest.

## Batch 8 — Devices table rich values, sortable headers, bridges feedback

Backlog items: the devices table renders a rich value as literal "undefined"; a sortable
column header carries no accessible name; the Bridges panel gives no failure feedback; the
remove button fails silently on the default bridge; `loadBridges()` has no request
sequencing.

**Files:** `src/devices-table.jsx`, `src/bridges.js`, `src/bridges.jsx`,
`test/devices-table.spec.js`, `test/bridges.test.js`, new `test/bridges.spec.js`.

**Change.**

1. `ValueRow` (`devices-table.jsx:77`) passes `r.merged.value[f]` into `<td colSpan={3}>`.
   `cardFields()` returns `$r`-tagged objects (`sun`, `moon`, `now`, `day0`,
   `local_time_12`) alongside scalars. Run the value through the same shape `reading()`
   (`:12`) uses: `isRich(raw) ? briefOf(raw) : displayValue(f, raw, s).num + unit`. Preact
   also stamps `_parent`/`_depth`/`_index` onto the stored reading today, which the fix ends.
2. `SortHeader` (`:95`) is a `th` with `aria-sort` and `tabIndex`. Nest a `<button
   type="button">` carrying the label inside the `th`, move `onClick` to it, and delete
   `handleKeyDown` — the button gives Enter and Space for free. Keep `aria-sort` on the `th`.
3. `bridges.js` — add a monotonic `let seq = 0` and in `loadBridges()` capture
   `const id = ++seq` before the fetch and drop the result when `id !== seq`.
4. `bridges.jsx:12` — `removeBridge` returns false on a failure and nothing shows.
   `await` it and call `showToast()` from `src/toast.js` on false, same for `addBridge` in
   `BridgeForm` (`:26`) alongside the existing `aria-invalid`. The default bridge case is the
   one where the row reappears; the toast at least names the outcome.

**Test.** `devices-table.spec.js`: assert `tr.vrow[data-f="sun"] td` holds the brief, not
"undefined" — the backlog notes this claim was derived from Preact's diff source rather than
observed, so write this assertion first and confirm it fails. `bridges.test.js`: overlapping
`loadBridges()` calls resolve out of order and the later one wins. A new `bridges.spec.js`
covering the rendered panel: add succeeds, add fails and toasts, remove fails and toasts.
Keyboard: focus a header and press Space, assert the sort flipped.

**Risk.** Low. The header change alters the DOM shape 33 selectors in `devicesort.spec.js`
and `cards.spec.js` may reach through — grep for `th[data-sort]` before landing.

## Batch 9 — Render cost

Backlog items: two synchronous layouts per message; the log pane re-renders 200 rows while
hidden; the time-zone `<select>` rebuilds ~450 options per render; Intl formatters
constructed rather than cached in three places; `main.jsx` stringifies discarded payloads;
`sortDevices` recomputes its tiebreak inside the comparator; the devices table re-renders
every row on every packet; `fitting` grows without bound.

**Files:** `src/cards.jsx`, `src/grid.js`, `src/log.jsx`, `src/app.jsx`,
`src/location.jsx`, `src/renderers.jsx`, `src/feeds/zone.js`, `src/main.jsx`,
`src/devicesort.js`.

**Change.**

1. `cards.jsx:24` and `:30` — neither the `useLayoutEffect` calling `measureGrid()` nor the
   `useEffect` calling `fitValues()` has a dependency array, and `CardsView` subscribes to
   `devices.value`. Give both `[cellSignal.value, viewColsSignal.value, cardState.value,
   settings.value]` — the things they actually depend on. Note that `cellSignal.value` read
   inside the effect body at `:31` subscribes to nothing; it belongs in the array.
2. `grid.js:68` — `fitting` is a `Map` keyed by node that nothing deletes. `fitValues()`
   (`:81`) already skips disconnected nodes; have it `fitting.delete(f.node)` instead of
   `continue` when `!f.node.isConnected`. Then `resetFit()` (`:74`) can go with Batch 10.
3. `log.jsx:12` — gate the row map on visibility the way `DevicesView` (`devices-table.jsx:144`)
   does: `LogView` reads `tab.value` and `settingsTab.value` and renders `null` otherwise.
   Format the timestamp once in `addLog()` (`:6`) and store the string, removing 200
   `toLocaleTimeString()` calls per message.
4. `location.jsx:77` — hoist `const TZ = zones()` to module scope and memoise the option
   VNode array beside it. `Intl.supportedValuesOf('timeZone')` cannot change during a page
   load.
5. Formatter cache: a module-level `Map` keyed on `zone + '|' + JSON.stringify(opts)`
   returning an `Intl.DateTimeFormat`. Put it in `feeds/zone.js` and use it from
   `formatTime` (`:32`), `isDST` (`:25`), `offsetMinutes` (`:3`), and the `clock` renderer
   (`renderers.jsx:37`).
6. `main.jsx:38` — move `const raw = JSON.stringify(obj)` below the `isSelf(key)` test, or
   compute it lazily where `addLog` (`:46`) and `upsert`'s `raw` field need it. `upsert`
   stores `raw` on every record, so this needs care: store `obj` and stringify on demand in
   the log and the devices table, or keep `raw` and skip only the log call.
7. `devicesort.js:71` — decorate/sort/undecorate: build `{ r, k: key(r), n:
   deviceName(r).toLowerCase() }` once per record, hoist a module-level `Intl.Collator`, and
   compare against the decorated fields.
8. The devices table re-rendering every row per packet: `Rows()` (`devices-table.jsx:128`)
   maps every device and each device's fields. `DeviceRow` reads its own record's signals, so
   the fix is to stop `Rows` itself subscribing to `devices.value` for anything but the key
   set — memo `DeviceRow` on `r.key` and let its signal reads drive it.

**Test.** Playwright can count layout work only indirectly; assert behavior instead.
`cards.spec.js`: install a `MutationObserver` or wrap `measureGrid`/`fitValues` through the
`window` hook, send 10 messages that change no value count, and assert the call count did not
grow by 10. `fontfit.spec.js` already covers that values stay fitted — it is the regression
guard for the dependency arrays. For `fitting`: expose its size for the test, hide and show a
card 50 times, assert the size does not grow. For the log: assert `#logrows tr` count is zero
while the cards tab is up. For `sortDevices`: `devicesort.test.js` already asserts order;
add a fixture with names differing only in case to pin the collator's behavior.

**Risk.** High for item 1. Dependency arrays on these two effects are exactly what the
`fontfit` and `cards` specs exist to protect; an under-specified array silently stops
re-fitting and the failure shows as an ellipsis in one card at one size. Land item 1
separately from the rest of this batch if review is uneasy. Item 6 changes what `raw` holds
and `cards.spec.js`/`devices-table.spec.js` read it through `window.devices`.

## Batch 10 — Delete dead code and close the small gaps

Backlog items: the dead-code list; the four smaller items.

**Files:** delete `src/render-loop.js`; edit `src/grid.js`, `src/store.js`,
`src/feeds/cache.js`, `src/feeds/nws.js`, `src/cards.jsx`, `src/sources.jsx`,
`src/geocode.js`, `test/store.test.js`.

**Change.**

- Delete `src/render-loop.js` entirely — nothing imports it, by name or by symbol.
- Delete `resetFit()` (`grid.js:74`) after Batch 9 makes it unnecessary, and `cellSide()`
  (`:9`), which the tests reach through the `window.cellSide` getter in `main.jsx:185`, not
  this function.
- Delete `orderedKeys()` (`store.js:202`) **and** its three assertions in
  `test/store.test.js:32,34,75`.
- Delete `cacheDrop()` (`feeds/cache.js:40`), the unused `const alias` in `Label`
  (`cards.jsx:117`), and the no-op `onPointerDown` on the same element (`:128`).
- `feeds/nws.js:19` assigns `err.retryAfter` and nothing reads it, so the backoff ladder
  ignores `Retry-After`. Either read it in `feed.js`'s catch (prefer
  `Math.max(err.retryAfter, jittered)`) or delete the assignment. Reading it is the better
  behavior against a rate-limited API; do that and say so in `architecture.md`.
- `sources.jsx:27` returns before `useState` when `Capacitor.isNativePlatform()` is false.
  Constant per platform, so it works, but it is a conditional hook. Move the early return
  into the parent (`SourcesView` renders `<ScanButton />` only when native) so `ScanButton`
  itself is unconditional.
- `store.js:9` — `storageBroken` is never reset. `loadAliases` (`alias.js:38`) and
  `loadSettings` (`settings.js:149`) both clear theirs. Clear it at the top of
  `loadCardState()`.
- `geocode.js:12` — `cache` is unbounded. Cap it: on `cache.set`, if `cache.size > 100`
  delete the oldest key (`cache.keys().next().value`).
- `RenameInput`'s Enter path (`cards.jsx:152`) calls `postAlias` then `setRenaming(false)`,
  which unmounts the input; the `onBlur` at `:159` would `postAlias` a second time if the
  browser fires blur on removal. The backlog marks this unconfirmed. Confirm it with a spec
  that counts `$alias` POSTs on an Enter-committed rename before changing anything; if it
  double-posts, set a `committed` ref in the Enter handler and have `onBlur` bail on it.

**Test.** `build.test.js` already builds the bundle; a deletion that breaks an import fails
there. For the geocode cap, a unit test issuing 150 distinct queries and asserting
`resetGeocode`-visible size stays bounded — or expose the size for the test. For the rename,
the POST-count spec described above.

**Risk.** Low, except the rename change, which is behavioral and currently unverified. Do not
change the rename path without the failing count first.

## Batch 11 — Card layout geometry

Backlog items: `Body()` sizes columns from card width; `LINE_HEIGHT` duplicates the CSS;
`measureGrid()`'s arithmetic assumes no `gap`; nothing caps how far one card pulls the page
type down; `fitValues()` measures only the font family; `#grid-size` overlaps below ~320px;
the view column cap is derived from width alone.

**Files:** `src/cards.jsx`, `src/grid.js`, `src/style.css`, `docs/architecture.md`,
`test/cards.spec.js`, `test/mobile-grid.spec.js`, `test/fontfit.spec.js`.

**Change.**

1. **Empty half-cards.** `Body()` (`cards.jsx:177`) sets
   `gridTemplateColumns: repeat(${w}, minmax(0,1fr))`, one value per grid cell of card width,
   so a 2-wide Clock card showing only the time fills the left half. Size the columns from
   the visible count instead: `cols = Math.min(w, vis.length)` and rows
   `Math.max(h, Math.ceil(vis.length / cols))`. This changes every card, scalar ones
   included — expect the fill-ratio and overflow assertions in `cards.spec.js` to move.
2. **`LINE_HEIGHT`.** `grid.js:79` hardcodes `1.05`, repeating `.card .val`'s `line-height`
   in `style.css` — which is declared **twice**, at `:71` and `:100`. Collapse the two CSS
   rules into one, publish the value as a custom property (`--val-line-height:1.05`) on
   `.card .val`, and have `fitValues()` read it once per run via `getComputedStyle`. Then one
   change moves both.
3. **`gap`.** `measureGrid()` (`:23`) computes `cols × cell` against `grid.clientWidth` with
   no gap term. Re-adding a `gap` would overflow by `(cols-1) × gap`. Read
   `parseFloat(cs.columnGap) || 0` and `rowGap`, subtract `(cols-1) * gap` from `width` and
   `(rows-1) * gap` from `height`. That makes the arithmetic correct rather than
   accidentally correct, and costs two `getComputedStyle` reads already being made.
4. **One crowded card drags the page down.** `fitValues()` (`:81`) takes the global minimum
   across every tracked value, floored at `FONT_MIN` 11px. Add a second floor relative to the
   page: compute the median `fits` and clamp `global` to no less than, say, 0.6 × median, so a
   single pathological card stops at its own ellipsis rather than shrinking the page. This is
   a design decision, not a mechanical fix — write down the chosen ratio and why in
   `architecture.md`'s "Value fit" section.
5. **Font measurement.** `textWidthEm()` (`:59`) builds its probe font from
   `getComputedStyle(document.body).fontFamily` only, so a `letter-spacing` or
   `font-feature-settings` change on `.fv` would silently bring the ellipsis back. Measure
   against a `.fv` element instead: read `font`, `letterSpacing` and `fontFeatureSettings`
   off the first tracked node and set them on the canvas context (`letterSpacing` and
   `fontStretch` are settable on `CanvasRenderingContext2D` in Chromium; add the per-character
   letter-spacing term by hand for engines that lack it).
6. **`#grid-size`.** `style.css:110` fixes it at `right:12rem`, about 7rem wide, so below
   ~320px of viewport it reaches the left edge and overlaps the grid in edit mode. Add a
   media query below 400px that stacks the edit-mode controls in a row along the bottom
   instead of positioning each by `right`.
7. **Column cap.** `grid.js:33` derives `cols` from width and `MIN_CELL` alone, so a
   landscape phone gets the same 3 columns a portrait one does at the same width, and a very
   short window scrolls. Add a height term: cap `cols` so that `Math.ceil(cardCount / cols)`
   rows at `MIN_CELL` still fit `height`, or simply raise the cap when
   `window.innerWidth > window.innerHeight`. Pick one and say which in `architecture.md`.

**Test.** `cards.spec.js`: a 2-wide card showing one value has a `.body` whose single `.val`
spans the full width (item 1). `mobile-grid.spec.js`: at 320×640 in edit mode, `#grid-size`'s
bounding box does not intersect `#cards` (item 6); at 800×360 landscape the column count
differs from 360×800 portrait (item 7). `fontfit.spec.js`: add `letter-spacing:.2em` to `.fv`
via `page.addStyleTag` and assert no value overflows (item 5) — this fails today.

**Risk.** High. This is the batch most likely to move assertions across `cards.spec.js`,
`fontfit.spec.js` and `mobile-grid.spec.js`. Items 1, 4 and 7 change what the page looks
like; 2, 3 and 5 do not. Land 2/3/5 as one commit and 1/4/6/7 as another if the diff gets
large.

## Batch 12 — Gesture mutual exclusion

Backlog items: `setValueMode`, `setCardHidden`, `setGrid` and Enter-committed rename all save
layout mid-resize; nothing drives a drag and a resize at once.

**Files:** `src/store.js`, `src/cards.jsx`, `src/grid.js`, new
`test/gestures.spec.js`.

**Change.** `beginDrag` (`grid.js:249`) is guarded by `currentResize()` at `cards.jsx:99` and
`beginResize` (`:259`) by `currentDrag()` at `:311`. `setValueMode` (`store.js:160`),
`setCardHidden` (`:193`), `setGrid` (`:244`) and `RenameInput`'s Enter path
(`cards.jsx:152`) guard against neither, and the first two are now reachable from the device
table as well as from a card. Add a single `if (gestureInFlight()) return` at the top of each
— `store.js` cannot import `grid.js` without closing a cycle, so route it the way
`setEditHook` (`:18`) already does: a `setGestureHook(fn)` registered from `grid.js`,
defaulting to `() => false`.

The backlog notes no corruption results today, because the in-flight resize has written
nothing and `endResize` re-renders over whatever the second finger did. So this is closing a
rule violation, not a bug. Say that in the commit message.

**Test.** New `test/gestures.spec.js`. The suite already dispatches synthetic bubbling events
from `page.evaluate`; for genuine multi-touch, open a CDP session
(`page.context().newCDPSession(page)`) and drive `Input.dispatchTouchEvent` with two
`touchPoints`. Start a resize on card A, then with a second point start a drag on card B, and
assert `window.dragging` stayed null. Then start a resize and call
`window.setValueMode(...)` mid-gesture and assert `localStorage` did not change.

**Risk.** Low to the app, moderate to the test. `Input.dispatchTouchEvent` is Chromium-only
and the config already pins Chromium; if the CDP path proves flaky, the guard is still
testable by setting `resizing.value` through a `window` hook and calling the four entry
points.

## Batch 13 — Test debt

Backlog items: the cell-side test re-derives `measureGrid()`'s own arithmetic; the
"no card overflows its box" name overclaims; that test survives a value-overflow mutation;
nothing covers `forgetLayouts()` against a throwing `localStorage` or Escape out of a rename;
`test/fixtures.js` has drifted from the receiver's; `[data-key$=]` selectors are unanchored;
`test/card-memo.test.js` tests a function that does not ship.

**Files:** `test/cards.spec.js`, `test/layout.spec.js`, `test/fixtures.js`,
`test/card-memo.test.js`, `docs/architecture.md`.

**Change.**

1. `cards.spec.js:403` re-derives `Math.min(width/6, height/4)` and compares it to `cellSide`,
   which is what that arithmetic wrote, so a mistake mirrored in both places passes, and the
   20px floor at `grid.js:44` is never exercised. Replace the derivation: render a 1×1 card
   and measure its `getBoundingClientRect()`, asserting that against `--cell`. Add a case at a
   viewport small enough to hit the floor.
2. `cards.spec.js:1082` — `scrollWidth`/`scrollHeight` ignore content above or left of the
   box, and `.lbl` sits at `top:-.65em` by design, so rename the test to what it checks:
   "no card's content extends past its right or bottom edge". Add a note in the body.
3. The same test survives a mutation making every value overflow its `.val`, because
   `overflow:hidden` on `.card .val` (`style.css:72`) and `.card .fv` (`:97`) clips before
   the metrics it reads. The value-level guarantee is already covered by "every value in a
   card shares the size its widest reading needs" (`cards.spec.js:1339`). Cross-reference the
   two in a comment rather than duplicating coverage.
4. Add two cases: `forgetLayouts()` (`store.js:256`) with a `localStorage.removeItem` that
   throws, asserting the page survives and `storageBroken` latches; and Escape out of a rename
   (`cards.jsx:155`), asserting the alias is unchanged and no `$alias` POST fired.
5. `test/fixtures.js` and `receiver/test/fixtures.js` have drifted: the receiver's is
   CommonJS `module.exports` and has `ACURITE_WIND`/`ACURITE_RAIN` (`:38`, `:45`) the
   dashboard's ESM copy lacks. Make one the source. The receiver's copy is the CommonJS one
   and the dashboard's is ESM, so keep the data in a single `.json` or a `.cjs` module and
   have both re-export it — or, cheaper, add a test in whichever suite runs first that reads
   both files and asserts the shared names have identical values. The re-export is the real
   fix; the drift test is the fallback if the module systems fight.
6. `[data-key$="…"]` appears 33 times in `cards.spec.js` and is unambiguous only while a spec
   file runs a single source. Do not mass-edit: instead add a note to `architecture.md`'s
   Tests section stating the constraint, and in any spec that adds a second source, scope
   through a per-source root locator rather than a suffix.
7. `test/card-memo.test.js` defines its own `areEqual` comparing `props.key`, `props.merged`
   and `props.alias`. The shipped one (`cards.jsx:72`) takes `props.cardKey`, has no `merged`
   or `alias` prop, and returns `false` unconditionally outside a gesture. Eleven of its
   twelve tests exercise branches that do not exist. Delete the file and replace it with a
   spec that drives the real thing: start a gesture on card A, push a new reading for A, and
   assert A's DOM did not change while another card's did. Note separately that because
   `areEqual` always returns false outside a gesture, `memo()` provides no memoisation — and
   whether the gesture freeze survives signal-driven updates, which re-render the inner
   component directly, is unverified. That is what the new spec settles.

**Test.** These are the tests. Each new assertion must be shown to fail against the current
code before it counts (item 1 against a deliberately wrong `cell`, item 4 against the
unpatched paths, item 7 against a mid-gesture reading).

**Risk.** Low to the app, none of this ships. Item 5 crosses into `receiver/`, so it needs
that sub-project's tests run too.

## Batch 14 — Split the README

Backlog item: `dashboard/README.md` carries install, build and test commands; the bridge
splits the same material into `docs/install.md` and `docs/development.md`.

**Files:** `README.md`, new `docs/install.md`, new `docs/development.md`, `docs/quickstart.md`.

**Change.** Move `npm install` and requirements into `docs/install.md`; move build, test,
lint and the `--progmem` path into `docs/development.md`. Leave the README with what the
dashboard is, who it is for, the one example, the install one-liner and the links. Follow
`bridge/README.md` and its `docs/` for the shape. `docs/quickstart.md` already exists and
covers the shortest path to a served page; check it still agrees after the move.

**Test.** None. Read the result against `bridge/`'s.

**Risk.** None.

---

## Not worth doing

- **A device seen through two bridges is two cards.** Merging needs a device identity that
  survives the source prefix, which the key format (`${base} ${topic}`, `alias.js:9`) does
  not have. That is a design change, not a fix. Leave it filed.
- **No authentication to a source.** Already filed in the bridge's backlog, which is where
  the fix has to happen. The dashboard inherits whatever the bridge does.
- **`exposeForTests()` on `window`.** Deliberate and endorsed: 44 of `cards.spec.js`'s 122
  tests drive the page through the globals the firmware version had at script level, and
  rewriting them would destroy the evidence that the extraction lost nothing.
  `store.js`'s `getCardState`/`setCardState` go with it. Delete when the suite drives the DOM
  instead — not before, and not as part of any batch here.
- **Renaming a module itself.** Needs a runtime equivalent to the receiver's build-time
  `MDNS_PREFIX`, which does not exist (see `receiver/docs/backlog.md`). Blocked on the
  firmware.
- **NWS's required `User-Agent`.** A browser refuses to send it — forbidden header name,
  `fetch` drops it (`feeds/nws.js:10`). The only fix is a proxy, which the browser-direct
  design rules out.
- **Weather is United States only.** A worldwide provider is a new feed file, not a fix.
  Roadmap, not backlog mitigation.
- **The observation station's identity and distance are not shown.** A feature, and a small
  one; it needs card space that the layout batch is already contending for.
- **Moonrise/moonset accurate to a couple of minutes.** The ten-minute sampling and
  interpolation in `astro.js` is a deliberate accuracy/size tradeoff.
- **Sun events degrade above 60° latitude.** Same tradeoff; the tests already relax to five
  minutes there.
- **"Use my location" cannot work on the receiver-served page.** Plain http on a LAN address
  is not a secure context (`location.jsx:39`), and the harness serves on 127.0.0.1, which is
  secure, so the branch is not coverable either. Outside our control.
- **The DST flag is wrong for a zone that changed rules mid-year.** `zone.js:25` already
  documents this and the card shows the exact offset alongside. There is no API for "is DST
  in effect".
- **Container queries and the minimum Capacitor WebView.** Unconfirmed, and the stated
  fallback (inherited body type) is not a break. Confirm the minimum WebView first; that is a
  question, not a work item.
- **"Clear" clears only the local location.** The receiver's published `$location`
  immediately supplies the fallback. Deleting the published value needs a firmware endpoint
  that does not exist. Blocked, same as the rename item.
- **No host-testable seam for `web_ui.cpp`'s `/$mqtt` dispatch.** Receiver-wide, and a
  receiver-side item. Batch 8's new `bridges.spec.js` covers the dashboard half.
