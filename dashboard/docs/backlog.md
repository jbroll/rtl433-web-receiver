# Backlog

- The suite runs against `receiver/test/binding-server.js`, a JS model of the binding,
  not against the real `bridge/`. Running it over an in-process `aedes` would test what
  ships. See [`../../docs/backlog.md`](../../docs/backlog.md).
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
- `main.js` exposes page internals on `window` through `exposeForTests()`, because tests
  in `test/cards.spec.js` drive the page through the globals the firmware version had at
  script level. 36 of its 67 tests reach for `window.` or `page.evaluate`. Deliberate and
  endorsed, since rewriting them would destroy the evidence that the extraction lost
  nothing, but it is debt: delete the hook when the suite drives the DOM instead.
  `store.js`'s `getCardState`/`setCardState` exist only to serve it.
- A sortable column header carries no accessible name for the action it performs. It is a
  `th` with `aria-sort` and a `tabIndex`, so a screen reader announces the column and its
  sort state but nothing says the header can be activated to change it. Nesting a
  `<button>` inside the `th` is the usual shape, and it would also drop the hand-wired
  Enter/Space handling in `table.js`.
- `test/fixtures.js` is a copy of `receiver/test/fixtures.js`, and nothing detects drift
  between them. If a fixture changes on one side, the receiver's binding tests and the
  dashboard's card tests silently disagree about what a device looks like.
- `test/cards.spec.js`'s `[data-key$="…"]` selectors are unanchored tail matches,
  unambiguous only while a spec file runs a single source. A second source added to that
  file would make a suffix match two rows, and the failure would look like a page bug
  rather than a test that needs `:not(.vrow)`-style narrowing. The drag ghost now clones
  the card, key included, so the card selectors already carry `:not(.ghostcard)`.
- `dashboard/README.md` carries the install and build commands and the test commands.
  The bridge splits the same material into `docs/install.md` and `docs/development.md`.
  The dashboard should match.
- The card age display doesn't tick. `Age` in `cards.jsx` reads `Date.now() - rec.seenAt.value`
  at render time, but nothing re-renders it on an interval; only `seenAt` itself is a signal.
  A card's "time since last update" only updates when a new message arrives, at which point
  it resets, so it never shows time actually elapsing between messages.
- No way to rename a module itself (the receiver or bridge a source points at), only the
  individual device cards it reports. Settings has no field for a source's own label or for
  the receiver's mDNS hostname, which today has no runtime equivalent to its build-time
  `MDNS_PREFIX` (see `receiver/docs/backlog.md`).

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
