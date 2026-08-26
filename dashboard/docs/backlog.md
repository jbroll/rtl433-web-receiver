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
- A reading that cannot fit even at 11px still ellipsizes.
- A prior backlog entry claimed every message forced two synchronous layouts in
  `cards.jsx` because neither `useLayoutEffect` nor `useEffect` had a dependency array.
  Measured call counts before commit 6125356 disproved that: a repeat message to an
  existing device re-renders `CardsView` 0 times (`upsert` on an existing record writes
  only per-device signals), and a new device coalesces `devices.value` and
  `cardState.value` into one render, so the effects ran once, not twice. The commit's
  only real effect was that a `devices.value`-only change (eviction, `clearSource`,
  `clear`) stopped refitting the grid, which it now does again.
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

- `flashUntil` is dead for rendering: `devices.js` writes it on every `upsert`, `main.jsx`
  and `feeds/feed.js` set it, and five test files construct records with it, but the flash
  class on a card comes from `rec.flashing`, which nothing reads `flashUntil` to derive.
  Removing it touches the `rec` shape in `devices.js`, the two writers, and every fixture
  that still passes it.
- `test/android-smoke.js` was updated for the gear-panel split (dropped the dead
  `#settings summary` click, switched to `#subtab-devices`) without a run against the
  tablet — no device was attached to verify it. Needs one manual run to confirm the
  selectors.

- `test/card-memo.test.js` tests a function that does not ship. It defines its own
  `areEqual` comparing `props.key`, `props.merged` and `props.alias`; the one in `cards.jsx`
  takes `props.cardKey`, has no `merged` or `alias` props at all, and returns `false`
  unconditionally outside a gesture. Eleven of its twelve tests exercise branches that do
  not exist, and the file cannot fail on a regression in `cards.jsx`. Separately, because
  the shipped `areEqual` always returns `false`, `memo()` provides no memoisation and only
  adds a wrapper component; whether the gesture freeze it does provide survives
  signal-driven updates, which re-render the inner component directly, is unverified.

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
- A prior backlog entry claimed the devices table re-renders every row on every packet.
  Measured: `Rows()` in `devices-table.jsx` does re-run its whole loop on any one device's
  change, since it reads every device's `r.merged.value` to compute field lists, but
  `@preact/signals`'s global `Component.prototype.shouldComponentUpdate` already skips a
  signal-reading component when no state changed and every prop is reference-equal, and
  `upsert()` mutates the record in place so `props.r` keeps its identity — confirmed by
  counting `DeviceRow` calls across a packet to one of two devices. `Rows()`'s own
  per-packet work (`sortDevices()` and
  a `cardFields()` call per device) is real but untouched by this correction.
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
- No test exercises `web_ui.cpp`'s `/$mqtt` HTTP dispatch directly — there's no
  host-testable seam for `web_ui.cpp` routes at all, receiver-wide.
