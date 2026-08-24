# Backlog

- A device seen through two bridges is two cards. Nothing merges them.
- No authentication to a source. The bridge has none, and a dashboard reaching one over
  anything but localhost inherits that. Filed in the bridge's backlog.
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
- Eighteen of the nineteen `debug-*` and `fill-ratio*` specs are scratch files that cannot
  fail on a regression, and `playwright.config.js` matches `**/*.spec.js`, so `npm test`
  runs them. Ten navigate to a hardcoded LAN address (`http://192.168.1.171/` in
  `debug-device-values{,2..7}`, `debug-ellipsis`, `debug-wrap`, `debug-wrap2`), so the suite
  cannot pass off that subnet — this is what keeps the dashboard tests out of CI. The other
  nine use the real harness but their only assertion is
  `expect(page.locator("#status")).toHaveText(/live/)`, a connectivity check;
  `debug-sweep.spec.js` has none, and their payload is `console.log`. The exception is
  `fill-ratio.spec.js`, which genuinely asserts `minRatio > 0.8` over `.fv`
  `scrollWidth/clientWidth` across five grid sizes. Delete the eighteen and fold that
  assertion into `fontfit.spec.js` under a name that says what it pins. The same glob also
  picks up untracked scratch specs, so a local run and a clean checkout run different sets.
- Both Android smoke steps are stale after the gear-panel split. `test/android-smoke.js`
  clicks `#settings summary`, but `settings.jsx` replaced `<details><summary>` with a plain
  `<div id="settings">`, so the click hangs to the Playwright timeout; and it clicks
  `#tab-devices` and waits for `#devices tr[data-key]`, but `main.jsx` already sets
  `settingsTab='settings'` and `devices-table.jsx` gates rows on
  `settingsTab.value === 'devices'`, so the rows never render. They want `#subtab-settings`
  and `#subtab-devices`.

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
