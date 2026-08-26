# Backlog

- A device seen through two bridges is two cards. Nothing merges them.
- `setValueMode`, `setCardHidden`, `setGrid`, and a rename committed with Enter all save
  layout, and all are reachable with a second finger while a resize is in flight, which
  the project's rules say must not write. No corruption results today: the in-flight
  resize has written nothing yet, and `endResize` re-renders over whatever the second
  finger did. The drag and resize entry points already guard against each other; these
  four do not guard against either. `setValueMode` and `setCardHidden` are now reachable
  from the device table as well as from a card.
- `fitValues()` measures on a canvas at the font family `getComputedStyle(document.body)`
  reports, ignoring letter-spacing and font-feature settings, so a style change to `.fv`
  could bring the ellipsis back. A reading that cannot fit even at 11px still
  ellipsizes.
- One size for the page means one crowded card sets it for every other. Nothing caps
  how far a single card can pull the rest down short of the 11px floor.
- `Body()` in `cards.jsx` lays the values out as `repeat(w, minmax(0,1fr))` columns, one
  value per grid cell of card width, so a card showing fewer values than it is wide leaves
  the rest of the card empty. A 2-wide Clock card showing only the time fills the left half
  and nothing else, at any type size. Sizing the columns from the visible value count would
  fix it, and would change every card, scalar ones included.
- `LINE_HEIGHT` in `grid.js` repeats the `line-height` on `.card .val` in CSS. Changing
  one without the other leaves the height fit off by that ratio.
- `measureGrid()`'s `cols × cell` arithmetic is exact only because the grid has no `gap`.
  Re-adding one would overflow the grid by `(cols-1) × gap`. Nothing in the file says so,
  and no test guards it.
- A stored `w` or `h` outside 1–24 is discarded rather than clamped, so the card is
  re-sized from its value count instead of pinned to 24.
- `#grid-size` is fixed at `right:12rem` and about 7rem wide, so below roughly 320px of
  viewport width it reaches the left edge and overlaps the grid in edit mode.
- Nothing covers `forgetLayouts()` against a throwing `localStorage`, or the Escape path
  out of a rename.
- The cell-side test re-derives `measureGrid()`'s own arithmetic and compares against the
  global that arithmetic wrote, so a mistake mirrored in both places passes, and the 20px
  floor is never exercised. Measuring a rendered 1×1 card's box instead would test the
  arithmetic independently of it.
- "no card overflows its box at any size or value count" can only catch overflow right
  and below: `scrollWidth`/`scrollHeight` ignore content above or left of the box, and
  `.lbl` sits at `top:-.65em` by design. The name overclaims what the test checks.
- The same test survives a mutation that makes every value overflow its `.val`:
  `.card .val` and `.card .fv` both carry `overflow:hidden` (`src/style.css:71, 95`), so
  clipped text never reaches the `.card`/`.body` scroll metrics it reads. The value-level
  guarantee is covered separately, by "every value in a card shares the size its widest
  reading needs" (`cards.spec.js:1339`), which does fail on that mutation.
- Nothing drives a card drag and a corner resize in flight at once, the only way to reach
  the mutual-exclusion guards. It is testable: the suite already dispatches synthetic
  bubbling events from `page.evaluate`, and Chromium exposes real multi-touch through
  `Input.dispatchTouchEvent` over a CDP session.
- `src/main.jsx` exposes page internals on `window` through `exposeForTests()`, because
  tests in `test/cards.spec.js` drive the page through the globals the firmware version had
  at script level. 44 of its 122 tests reach for `window.` or `page.evaluate`. Deliberate
  and endorsed, since rewriting them would destroy the evidence that the extraction lost
  nothing, but it is debt: delete the hook when the suite drives the DOM instead.
  `store.js`'s `getCardState`/`setCardState` exist only to serve it.
- A sortable column header carries no accessible name for the action it performs. It is a
  `th` with `aria-sort` and a `tabIndex`, so a screen reader announces the column and its
  sort state but nothing says the header can be activated to change it. Nesting a
  `<button>` inside the `th` is the usual shape, and it would also drop the hand-wired
  Enter/Space handling in `table.js`.
- `test/fixtures.js` started as a copy of `receiver/test/fixtures.js` and has already
  drifted: the receiver's copy moved to CommonJS `module.exports` and gained
  `ACURITE_WIND`/`ACURITE_RAIN` fixtures the dashboard's ESM `export const` copy lacks.
  Nothing detects drift between them, so the receiver's binding tests and the dashboard's
  card tests now silently disagree about what a device looks like.
- `test/cards.spec.js`'s `[data-key$="…"]` selectors are unanchored tail matches,
  unambiguous only while a spec file runs a single source. A second source added to that
  file would make a suffix match two rows, and the failure would look like a page bug
  rather than a test that needs `:not(.vrow)`-style narrowing. The drag ghost now clones
  the card, key included, so the card selectors already carry `:not(.ghostcard)`.
- `dashboard/README.md` carries the install and build commands and the test commands.
  The bridge splits the same material into `docs/install.md` and `docs/development.md`.
  The dashboard should match.
- No way to rename a module itself (the receiver or bridge a source points at), only the
  individual device cards it reports. Settings has no field for a source's own label or for
  the receiver's mDNS hostname, which today has no runtime equivalent to its build-time
  `MDNS_PREFIX` (see `receiver/docs/backlog.md`).

- The flash class latches on and never clears. `cards.jsx` and `devices-table.jsx` both
  test `rec.flashUntil.value > tick.value`, comparing an epoch timestamp
  (`Date.now() + 1000` in `main.jsx`, about 1.75e12) against the seconds-since-load counter
  `tick` starts at zero, so it is true for the rest of the session. `.flash` is a one-shot
  CSS animation and only replays when the class is removed and re-added, so a device
  flashes on its first message and never again, while every card and row that has ever had
  data carries `.flash` permanently. `cards.spec.js` asserts only that the class appears,
  so it passes with the bug. Comparing against `Date.now()` fixes it and also drops the
  per-second re-render below.
- Every card re-renders once a second. `Card` reads `tick.value` for the flash class and
  `Age` reads it for the age string, so the whole subtree — `Label`, `Body`, every `Value`,
  `BottomStrip` — re-renders and runs `displayValue()` per value every second when only the
  age text changed. Fixing the flash comparison confines the tick read to `Age`, one small
  leaf per card.
- `trim()` in `devices.js` ends with `devices.value = devices.value`, and signals skip
  notification when the new value is `===` the old. It deleted from the same Map `upsert`
  installed, so once the device count passes `DEVICE_MAX × sources` the evicted card and
  table row stay on screen until some unrelated signal re-renders the tree, and the Map and
  the DOM disagree in the meantime.
- `activeZone()` in `settings.js` reads `resolvedLocation().zone`, and `resolvedLocation()`
  returns the local settings object only when `lat` and `lon` are both non-null. The time
  zone `<select>` in `location.jsx` calls `setLocation({ zone })` without touching
  coordinates, so a zone chosen with no local coordinates is stored and displayed but never
  used. On a dashboard whose coordinates come from a source's `$location`, the select shows
  the picked zone while the Clock and Sun cards and the forecast day names run on the
  receiver's — the reverse of "your own location always wins once you set it". The zone
  needs its own fallback chain, independent of the coordinates.
- `onBoundsChanged` in `location.jsx` calls `setLocation({ zoom })` on every zoom change,
  and `setLocation` POSTs `$tz` and `$location` unconditionally when the origin is a
  configured source. Scroll-zooming the picker from z3 to z15 issues about 24 POSTs the
  ESP32 has to answer plus 12 settings serializations, each re-rendering `CardsView` and
  triggering a full font re-fit. Zoom is a view preference; it should not reach the wire.
- `fitting` in `grid.js` grows without bound. `trackFit()` inserts by node and nothing
  deletes; `resetFit()` is exported and called from nowhere in `src/`. Every hide/show,
  every device eviction and every keyed remount leaks an entry holding a detached node, and
  `fitValues()` — which runs after each `CardsView` render — walks the whole accumulated set.
- The status readout reports "live" when there are no sources at all: `live === states.length`
  is `0 === 0` on an empty `sourceState` map and that branch is tested first (`app.jsx`), so
  a fresh browser, or one where the last source was just removed, shows a green header while
  nothing is connected.
- `ensureCard()` pushes into `s.order`, `s.hidden` and `s.cards` on the object
  `cardState.value` already holds, with no `bump()` and no `saveCardState()` (`main.jsx`,
  `store.js`). The card still appears, because `upsert` replaces `devices.value`, but the
  layout is unpersisted. With no location set nothing else calls `saveCardState`, so a
  session's worth of new devices' default sizes and hide-on-arrival flags never reach
  `localStorage`.
- `ensureCard()` in `store.js` mutates `cardState.value` in place — `s.cards[key] = c`,
  `s.order.push(key)`, and the `hidden` push — and never calls `bump()`, so nothing
  subscribed to `cardState` is notified. Rendering only recovers because `CardsView` also
  subscribes to `devices`, which a new device reassigns. Any subscriber that reads
  `cardState` alone sees a stale value until the next `saveCardState()`.
- `pruneCardState()` writes `s.order = s.order.filter(...)` back into the live signal value,
  and `bump()` copies `grid` and `cards` but passes `order` and `hidden` through by
  reference (`store.js`), so a consumer holding an earlier `cardState` sees its `order`
  mutated. No caller exploits it today; it defeats the immutable-snapshot pattern the rest
  of the file follows.
- `stream.js` reconnects on a fixed 5 s `setTimeout` with no backoff and no jitter, in the
  case its own comment names ("every slot busy"). Several tabs pointed at a receiver whose
  SSE slots are full re-open in phase every five seconds indefinitely. The receiver's
  matching entry is "SSE eviction and auto-reconnect can churn".
- The row key in `log.jsx` is `entry.at + entry.raw`, which collides for two identical
  payloads in the same millisecond; Preact warns and may reuse the wrong row. A monotonic
  counter would fix it.
- Dead code: `src/render-loop.js` is imported by nothing — `setRender`, `scheduleRender`
  and `startRenderLoop` have no references. So do `resetFit` and `cellSide()` in `grid.js`
  (the latter shadowed by the `window.cellSide` getter the tests use), `orderedKeys` in
  `store.js`, `cacheDrop` in `feeds/cache.js`, the `const alias` in `Label` and the no-op
  `onPointerDown` in `cards.jsx`. `err.retryAfter` in `feeds/nws.js` is assigned and never
  read, which means the backoff ladder ignores `Retry-After` entirely.
- `playwright.config.js` matches `**/*.spec.js`, so an untracked scratch spec dropped into
  `test/` runs under `npm test` right alongside the real suite. A local run and a clean
  checkout run different sets as a result.
- Both Android smoke steps are stale after the gear-panel split. `test/android-smoke.js`
  clicks `#settings summary`, but `settings.jsx` replaced `<details><summary>` with a plain
  `<div id="settings">`, so the click hangs to the Playwright timeout; and it clicks
  `#tab-devices` and waits for `#devices tr[data-key]`, but `main.jsx` already sets
  `settingsTab='settings'` and `devices-table.jsx` gates rows on
  `settingsTab.value === 'devices'`, so the rows never render. They want `#subtab-settings`
  and `#subtab-devices`.

- The devices table renders a rich value as the literal text "undefined". `ValueRow` in
  `devices-table.jsx` is passed `r.merged.value[f]` straight through to
  `<td colSpan={3}>{value}</td>`, and `cardFields()` returns the `$r`-tagged values (`sun`,
  `moon`, `now`, `day0`, `local_time_12`) along with the scalars. A plain object as a Preact
  child falls through every branch of child normalisation and is treated as a VNode with
  `type === undefined`, which `diffElementNodes` turns into a text node of `undefined`.
  Preact also stamps `_parent`, `_depth` and `_index` onto the stored reading. The
  `reading()` helper twelve lines above handles the same case correctly, which is what makes
  this look like an oversight. Derived from reading Preact's diff source rather than observed
  in a browser; a one-line check on `tr.vrow[data-f="sun"] td` would settle it.
- `Card` in `cards.jsx` dereferences `cardEntry(key)` without checking it exists.
  `loadCardState` validates `order` and `cards` independently, so an entry in `order` with
  no matching `cards[k]` survives, and `CardsView` filters only on `devs.has(k)`. A corrupt
  or hand-edited blob then throws on `c.w` and takes the whole tree down. Dropping unbacked
  keys in `loadCardState` is the cleaner half of the fix.
- `EventSource` error handling in `stream.js` reads the wrong socket after a retry. `es` is
  a single closure variable that every `connect()` reassigns, and the old socket's `onerror`
  closes over the variable rather than the instance, so a late error from a superseded
  socket inspects the current socket's `readyState`. It can schedule a duplicate five-second
  retry, overwriting `retry` and leaking the earlier timer past `close()`. Capturing the
  instance in a local fixes it.
- Reverse geocoding can clobber a newer location pick. `location.jsx` awaits
  `reverseGeocode(latitude, longitude)` and writes the label with `setLocation`, and
  `geocode.js` serialises requests behind a one-second gap, so the write lands at least a
  second later. A search result picked in the meantime keeps its new coordinates and gets
  the stale label. Capturing the coordinates before the await and skipping the write when
  they no longer match is the fix.
- `loadBridges()` has no request sequencing. It is called from `addBridge`/`removeBridge`
  and from the settings-tab effect in `main.jsx`, so two overlapping fetches resolve in
  arbitrary order and the loser wins. Low impact, since the list is small and refetched on
  the next tab switch, but a monotonic request id is two lines.
- `$tz` is posted once and never refreshed, so the receiver's rain-day boundary drifts at
  every DST transition. `settings.js` computes `offsetMinutes(new Date(), zone)` at save
  time and POSTs it; the firmware stores it in `device_hooks.cpp` and uses it for the local
  day rollover that resets `rain_today_mm`. A fixed offset is wrong for half the year until
  someone re-opens Settings and re-saves. The tick effect in `main.jsx` already runs every
  second and could re-post on a change against a cached last-posted value.
- The log pane re-renders 200 rows on every message, including while it is hidden.
  `addLog()` copies the whole array per message and `LogView` maps all 200 rows, calling
  `toLocaleTimeString()` — an Intl formatter construction — once per row. `app.jsx` only
  sets `hidden` on the pane, never unmounts it, so the cost is paid whichever tab is up.
  `DevicesView` already establishes the fix by gating its body on visibility, and formatting
  the timestamp once in `addLog` removes the other 200 Intl calls. Same family as the
  devices-table entry under Information feeds.
- Every message forces two synchronous layouts. Neither the `useLayoutEffect` calling
  `measureGrid()` nor the `useEffect` calling `fitValues()` in `cards.jsx` has a dependency
  array, and `CardsView` subscribes to `devices.value`, so both run after every message.
  `measureGrid` does a `getComputedStyle` plus a `getBoundingClientRect`, and `fitValues`
  reads `clientWidth`/`clientHeight`/`offsetHeight` per tracked node. Neither depends on the
  reading that changed; both depend on cell size, grid dimensions and the set of values.
  (`cellSignal.value` is also read inside the `useEffect` body, which is not a reactive
  context, so it subscribes to nothing.)
- The time-zone `<select>` rebuilds its option list on every settings render.
  `location.jsx` calls `zones()` at module scope through `const TZ = zones()` but
  `Intl.supportedValuesOf('timeZone')` returns a fresh ~450-entry array, and `TZ.map(...)`
  builds ~450 `<option>` VNodes on each `LocationView` render — including every keystroke in
  the Place field, which is `useState`-backed. The list cannot change during a page load.
- Intl formatters are constructed rather than cached in three places. The `clock` renderer
  in `renderers.jsx` builds a new `Intl.DateTimeFormat` every second; `formatTime` in
  `feeds/zone.js` builds one per call and `sun.js` calls `hhmm` eleven times per run; and
  `isDST` builds three. Construction is the expensive half of Intl and formatting is cheap,
  so a module-level Map keyed on zone and format covers all three.
- `pump()` in `feeds/feed.js` resolves the location five times per tick. It calls
  `hasLocation()`, `placeOf()` (which calls `resolvedLocation()` and `hasLocation()` again),
  `resolvedLocation()`, and `activeZone()` (another `resolvedLocation()` plus
  `localZone()`), driven by the one-second effect in `main.jsx`, and `localZone()`
  constructs an `Intl.DateTimeFormat` just to read `resolvedOptions().timeZone`. Resolving
  once at the top and threading the result through is enough.
- `main.jsx` stringifies every payload, including the ones it discards. The SSE frame
  arrived as a string and was parsed in `stream.js`; `JSON.stringify(obj)` re-serialises it
  before the `isSelf(key)` test that decides whether it is logged at all, so Receiver
  telemetry pays for a string nothing reads.
- `sortDevices` recomputes its tiebreak key inside the comparator.
  `deviceName(x).toLowerCase()` allocates twice per comparison and `localeCompare` builds a
  collator each call, so the sort costs O(n log n) string allocations. Decorate, sort and
  undecorate with a hoisted `Intl.Collator` gives the same order.
- `test/card-memo.test.js` tests a function that does not ship. It defines its own
  `areEqual` comparing `props.key`, `props.merged` and `props.alias`; the one in `cards.jsx`
  takes `props.cardKey`, has no `merged` or `alias` props at all, and returns `false`
  unconditionally outside a gesture. Eleven of its twelve tests exercise branches that do
  not exist, and the file cannot fail on a regression in `cards.jsx`. Separately, because
  the shipped `areEqual` always returns `false`, `memo()` provides no memoisation and only
  adds a wrapper component; whether the gesture freeze it does provide survives
  signal-driven updates, which re-render the inner component directly, is unverified.
- Smaller items: `sources.jsx` returns before its `useState` when
  `Capacitor.isNativePlatform()` is false, which is a conditional hook that happens to be
  constant per platform. `storageBroken` in `store.js` is never reset, where `loadAliases`
  and `loadSettings` both clear their flag on reload. `geocode.js`'s `cache` is unbounded, so
  a user typing many searches grows it for the page's lifetime. And `RenameInput`'s Enter
  path calls `postAlias` then unmounts the input, which most browsers do not fire `blur` on,
  so the `onBlur` handler's second `postAlias` probably does not run — unconfirmed, and if
  it does every rename POSTs twice.

## Information feeds

- NWS documents a required identifying `User-Agent`. A browser cannot send one:
  it is a forbidden header name and `fetch` drops it. This works today and is
  outside our control tomorrow. The only fix is a proxy, which the
  browser-direct design rules out.
- Weather is United States only. `feeds/nws.js` sits behind the generic feed
  interface, so a worldwide provider such as Open-Meteo would be a new file
  rather than a refactor.
- The observation station the weather card reads can be a long way from the
  point. Nothing shows which station, or how far.
- Moonrise and moonset are found by sampling altitude every ten minutes and
  interpolating, so they are good to a couple of minutes, not seconds.
- Sun events degrade above about 60° latitude, where the sun grazes the horizon
  and a truncated series loses precision. The tests relax to five minutes there.
- "Use my location" cannot work on the page the receiver serves, because plain
  http on a LAN address is not a secure context. The automated suite cannot
  cover that branch, since the harness serves on 127.0.0.1, which counts as
  secure.
- The DST flag is inferred by comparing offsets across the year and is wrong for
  a zone that changed its rules mid-year.
- The devices table re-renders every row on every packet while the tab is up.
- Container queries size the type inside a rich value cell. The minimum WebView
  the Capacitor shell ships with is unconfirmed; older engines fall back to
  inherited body type rather than breaking.
- An in-flight feed run is neither aborted nor discarded when the location changes.
  `pump()` in `feeds/feed.js` detects the new place, calls `cacheClear()` and resets
  `feedState`, but the pending `await feed.run(ctx)` still holds the old `ctx`. When it
  lands it publishes the old point's fields, re-writes the cache that was just cleared, and
  sets `nextAt` an interval out — so moving the location while an NWS fetch is in flight
  repaints the old city's forecast and does not refetch for 15 minutes. On the error path
  it installs a 30-minute backoff for a location that was never tried. There is no
  `AbortController` anywhere in `feeds/` or `geocode.js`.
- The feed cache is wiped on every load of a fallback-location dashboard. `primeFeeds()`
  runs before any SSE frame, so `place` is empty and every cached entry — keyed
  `"40.015,-105.2705"` — is skipped; when the `$location` frame lands the effect re-runs
  `pump()`, `next !== place` is true, and `cacheClear()` deletes the lot. A dashboard whose
  location comes only from a source refetches weather, sun and moon from the upstream APIs
  on every page reload, and the cache `primeFeeds` describes can never accumulate. A
  local-location dashboard is unaffected. Priming `place` from `resolvedLocation()`, or not
  treating an empty-to-real transition as an invalidation, would fix it.
- Sun and moon events are computed for the UTC calendar day, not the location's local day:
  `sunEvents` and `moonTimes` in `astro.js` both floor to
  `Date.UTC(getUTCFullYear/Month/Date)`. At UTC-7, any time after 17:00 local the UTC day
  has rolled over, so the Sun card shows tomorrow's sunrise and sunset — a minute or two
  off — and the Moon card shows tomorrow's moonrise, which drifts about 50 minutes a day
  and can be null on one day and not the other. The dial's night/day state is unaffected,
  because `sunAngle` takes the value mod one day.
- The sun renderer treats the em-dash placeholder as a real time. `hhmm(null, z)` returns
  `'—'` (`feeds/zone.js`), `sun.js` puts it straight into `riseText`, and `{v.riseText && …}`
  in `renderers.jsx` is truthy for it. Above the Arctic circle on a day with no rise the dial
  draws "↑ —" and, because `!v.riseText` is false, suppresses the `v.brief` text ("up all
  day") that exists to replace it. The moon renderer handles this correctly through `timeOf`.
- The feed retry jitter is `(fails * 2654435761) % 1000`, which contains nothing
  feed-specific, so every feed gets the same value and they retry in lockstep — what the
  comment above it says the jitter prevents. Latent while `nws` is the only feed that
  fetches.
- "Clear" clears only the local location. On a page the receiver serves, the
  receiver's own published `$location` immediately supplies the fallback, so the
  feed cards stay and the location the user just cleared still resolves. There is
  no delete for the published value.
- The Bridges panel's remove button has no effect on the build-flag default bridge
  (matching spec, which put this out of scope), but it fails silently — the row
  simply reappears after the refetch, with no indication to the user that removal
  isn't possible for that entry.
- The Bridges panel gives no failure feedback beyond `aria-invalid` on the url
  field — a full table, an invalid url, and a network error all look identical to
  the user, and a failed `removeBridge()` produces no visible signal at all. The
  codebase already has a toast mechanism (`toast.js`'s `showToast`, used elsewhere)
  that could surface these.
- No test exercises `web_ui.cpp`'s `/$mqtt` HTTP dispatch directly (there's no
  host-testable seam for `web_ui.cpp` routes at all, receiver-wide) and no
  Playwright spec touches the Bridges panel's rendered UI; `bridges.test.js`
  covers the `bridges.js` module against a fake `fetch`, which is real but
  partial coverage.
- The view column cap is derived from width alone. A landscape phone gets the same 3
  columns a portrait one does at the same width, and a very short window still scrolls
  rather than fitting.
- The Playwright suite has no default network guard: a spec that adds a new call to
  a third-party API and forgets to route it will hit the live service, the same way
  the four weather.gov specs did. A single fixture wrapping `page` that installs a
  catch-all `page.route("**/*", ...)` aborting anything not aimed at 127.0.0.1 or
  localhost, with each spec's own routes taking precedence (Playwright matches the
  most-recently-registered route first, so a route added in a test body wins over
  one installed by the fixture beforehand), would close this for good. Not done now
  because it means changing the import line in every one of the ~20 *.spec.js files
  to pull `test`/`expect` from a shared fixtures module instead of
  `@playwright/test`, and `multi.spec.js`'s "same-origin alias..." test opens pages
  via `browser.newContext()` directly, bypassing the `page` fixture entirely, so it
  would need its own guard or stay uncovered.
