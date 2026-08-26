# Backlog

- `feeds/feed.js`'s `publish()` calls `saveCardState()` unconditionally on every feed
  run, on top of the save `ensureCard()` already makes when the card actually changed.
  Every feed tick writes `localStorage` and notifies subscribers even when nothing about
  the card changed.
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

- `fitting` in `grid.js` grows without bound. `trackFit()` inserts by node and nothing
  deletes; `resetFit()` is exported and called from nowhere in `src/`. Every hide/show,
  every device eviction and every keyed remount leaks an entry holding a detached node, and
  `fitValues()` — which runs after each `CardsView` render — walks the whole accumulated set.
- Dead code: `src/render-loop.js` is imported by nothing — `setRender`, `scheduleRender`
  and `startRenderLoop` have no references. So do `resetFit` and `cellSide()` in `grid.js`
  (the latter shadowed by the `window.cellSide` getter the tests use), `orderedKeys` in
  `store.js`, `cacheDrop` in `feeds/cache.js`, the `const alias` in `Label` and the no-op
  `onPointerDown` in `cards.jsx`. `err.retryAfter` in `feeds/nws.js` is assigned and never
  read, which means the backoff ladder ignores `Retry-After` entirely.
- `flashUntil` is dead for rendering: `devices.js` writes it on every `upsert`, `main.jsx`
  and `feeds/feed.js` set it, and five test files construct records with it, but the flash
  class on a card comes from `rec.flashing`, which nothing reads `flashUntil` to derive.
  Removing it touches the `rec` shape in `devices.js`, the two writers, and every fixture
  that still passes it.
- `test/android-smoke.js` was updated for the gear-panel split (dropped the dead
  `#settings summary` click, switched to `#subtab-devices`) without a run against the
  tablet — no device was attached to verify it. Needs one manual run to confirm the
  selectors.

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
- `loadBridges()` has no request sequencing. It is called from `addBridge`/`removeBridge`
  and from the settings-tab effect in `main.jsx`, so two overlapping fetches resolve in
  arbitrary order and the loser wins. Low impact, since the list is small and refetched on
  the next tab switch, but a monotonic request id is two lines.
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
  `zone.js` builds one per call and `sun.js` calls `hhmm` eleven times per run; and
  `isDST` builds three. Construction is the expensive half of Intl and formatting is cheap,
  so a module-level Map keyed on zone and format covers all three.
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
- `moonTimes` in `astro.js` starts its scan window at `zoneDayStart(date, zone) -
  offsetMinutes(date, zone) * 60000`, using the offset at the instant passed in rather
  than the offset at true local midnight. Across a DST transition the two differ by an
  hour, so the window can start up to about 24 hours from true local midnight instead of
  the 14 the comment discloses. Confirmed wrong: New York (`America/New_York`) reports a
  real moonset as `null` on both 2027-11-06 and 2027-11-07, the DST transition day and the
  one before it. Self-corrects the day after; happens twice a year per zone, at its DST
  transitions.
- `sunEvents` in `astro.js` solves each event at an anchor and, when the result falls
  outside the requested zone's local day, re-solves at a shifted anchor; if that re-solve
  lands on the wrong day or returns null where the first solve found an event, it falls
  back to translating the original answer by 86,400,000 ms. That fallback fires on about
  0.68% of shifted solves (25 of 3,669 across 1,656 `sunEvents` calls) and carries the
  translation error; the other 99.3% are exact to about a second. Worst measured error is
  1,951 s (about 32.5 minutes) at Svalbard 78.22N for `nauticalDawn` on 2026-09-24, well
  past the five minutes the tests relax to above 60° latitude. Three cases below 60° also
  exceed 60 s: Denver 39.74N sunset 2026-10-30 at 69.6 s, Kathmandu 27.72N `civilDawn`
  2026-03-20 at 69.7 s, Punta Arenas 53.16S `civilDusk` 2026-03-08 at 146.4 s. The card
  renders HH:MM, so these shift the displayed minute by one or two. Solving directly
  within the local-day window, rather than solving at an anchor and correcting, would fix
  it.
- The same fallback is not unconditionally day-safe. On a spring-forward day the local day
  is 23 hours long, and the fallback's fixed 86,400,000 ms shift overshoots local midnight
  by 10 to 21 minutes. That produces an `astroDusk` dated one day late in three cases
  across a two-year, 277,193-event sweep: America/Nuuk 2026-03-28 and 2027-03-27, and
  America/Anchorage 71.29N 2027-03-14. In all three the correct answer is null: an
  independent bisection confirms none of those local days contains a true -18° falling
  crossing, so the emitted event is spurious. This predates the current implementation;
  the same three appear in commit 2edde71. Day selection is otherwise correct across a
  12,096-event sweep with zero wrong-day results.
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
- `runFeed()` discards a reply that lands after the location has moved on, but the request
  itself still runs to completion: nothing cancels the pending `fetch` inside `nws.js`'s
  `get()`. An `AbortController` threaded from `pump()` through `feed.run(ctx)` into `get()`
  would cancel the wasted request instead of just ignoring its answer.
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
