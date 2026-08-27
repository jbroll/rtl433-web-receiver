# Backlog

- `feeds/feed.js`'s `publish()` calls `saveCardState()` unconditionally on every feed
  run, on top of the save `ensureCard()` already makes when the card actually changed.
  Every feed tick writes `localStorage` and notifies subscribers even when nothing about
  the card changed.
- A device seen through two bridges is two cards. Nothing merges them.
- A reading that cannot fit even at 11px still ellipsizes.
- A below-floor noise reading has no error marking on the receiver's card. The firmware
  already publishes the signature: `radio_ok`, `noise_dBm` and `rssi_thresh` are all in
  the telemetry, and a radio stuck refusing `OP_MODE` writes reads at or below the
  SX1231's own measurement floor of about -120 dBm. The card renders `noise_dBm` as a
  plain value, so a broken radio reads as merely quiet. Needs an indicator keyed on
  `radio_ok`.
- `src/main.jsx` exposes page internals on `window` through `exposeForTests()`, because
  tests in `test/cards.spec.js` drive the page through the globals the firmware version had
  at script level. 39 of its 88 tests reach for `window.` or `page.evaluate`. Deliberate
  and endorsed, since rewriting them would destroy the evidence that the extraction lost
  nothing, but it is debt: delete the hook when the suite drives the DOM instead.
  `store.js`'s `getCardState`/`setCardState` exist only to serve it. `store.js`'s
  `isStorageBroken()` and `exposeForTests()`'s `window.storageBroken` grew the same
  hook further.
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
  selectors. Its assertions also assume the Capacitor shell's origin probe aborts, since
  they wait for the devices sub-tab to be selected with an empty source list, which is
  what `abortProbe()` leaves behind. Nothing has confirmed the probe fails there. If it
  succeeds instead, the script lands on the cards tab and fails at its first wait.

- `Card`'s gesture freeze (`memo(Card, areEqual)` in `cards.jsx`) does not survive a
  live reading arriving for the card being dragged, resized, or renamed: `Card` reads
  `rec.merged.value` directly, and `@preact/signals` re-renders a component that read a
  changed signal on its own, bypassing `memo`/`areEqual` entirely. Confirmed by
  `test/cards.spec.js`, "a card's own signal update reaches its DOM mid-gesture, despite
  areEqual" (see `docs/architecture.md`'s "Card memo"). The gesture mechanics themselves
  (ghost, `lifting` class, drop zones) are unaffected since none of it lives in `Card`'s
  render output; only the frozen-values guarantee is missing. `areEqual` would need to
  gate on the signal read too, not just on props, to actually freeze the display.

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
- The alias rename input has no `maxlength`. `postAlias` now reads the POST response,
  but only a `401` reaches the user; every other failure goes to the console. The
  firmware's `ALIAS_NAME_MAX` (`receiver/alias_store.h`) is 32, so a name of 32 or more
  characters is rejected with a `400` the user never sees, and the local alias map keeps
  the name the device refused. Needs a `maxlength` on the input and a toast on the
  non-401 failures.
