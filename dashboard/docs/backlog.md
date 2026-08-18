# Backlog

- The suite runs against `receiver/test/binding-server.js`, a JS model of the binding,
  not against the real `bridge/`. Running it over an in-process `aedes` would test what
  ships. See [`../../docs/backlog.md`](../../docs/backlog.md).
- Adding a source to the firmware-served page evicts the device serving it. `sources()`
  falls back to `[location.origin]` only while the stored list is empty, so the first
  `addSource()` makes the fallback stop applying: `syncSources()` closes the origin's
  stream and `clearSource()` drops its devices, cards, and aliases. The panel never listed
  that origin, so nothing on screen says where they went. Promoting the implicit origin
  into the stored list before the first add would fix both, at the cost of storing an
  address DHCP can change.
- The sources panel should be a fourth tab, and with nothing stored the page should probe
  its own origin and adopt it as the first source if a binding answers, instead of
  `sources()` falling back to it at read time. The landing tab is then Sources when the
  list is empty and Cards when it is not, which is the empty state the Capacitor shell
  needs and which a page served by a device or a bridge never reaches. Filed in
  [`../../docs/backlog.md`](../../docs/backlog.md).
- A device seen through two bridges is two cards. Nothing merges them.
- No authentication to a source. The bridge has none, and a dashboard reaching one over
  anything but localhost inherits that. Filed in the bridge's backlog.
- `measureGrid()` floors the cell side at 20px, which breaks letterboxing: at 24 columns
  on a 360px viewport the grid comes out 480px wide and the page scrolls sideways.
- Cards overflowing the row count grow a scrollbar, which shrinks `#cards`'s
  `clientWidth` and so the next cell size. It settles rather than looping, but the grid
  visibly jitters between two sizes. Fixing it means measuring against
  `documentElement.clientWidth` or reserving the scrollbar gutter.
- `setValueMode`, `setCardHidden`, `setGrid`, and a rename committed with Enter all save
  layout, and all are reachable with a second finger while a resize is in flight, which
  the project's rules say must not write. No corruption results today: the in-flight
  resize has written nothing yet, and `endResize` re-renders over whatever the second
  finger did. The drag and resize entry points already guard against each other; these
  four do not guard against either. `setValueMode` and `setCardHidden` are now reachable
  from the device table as well as from a card.
- The font-size factor of 0.42 and the 11–64px clamp were tuned against a handful of
  synthetic devices.
- `fitValues()` measures on a canvas at the font family `getComputedStyle(document.body)`
  reports, ignoring letter-spacing and font-feature settings, so a style change to `.fv`
  could bring the ellipsis back. It errs about 4px high per value at 64px. A card whose
  widest reading cannot fit even at 11px still ellipsizes.
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
  secure. Checked by hand against a flashed module: the button is absent and
  the rest of the location controls work.
- The DST flag is inferred by comparing offsets across the year and is wrong for
  a zone that changed its rules mid-year.
- `test/build.test.js` no longer forbids external requests outright; it holds an
  allowlist of three origins instead. A new origin has to be added there
  deliberately, but the check is weaker than it was.
- The devices table re-renders every row on every packet. It used to skip that
  while another tab was up by reading the section's `hidden` attribute during
  render, which is the previous render's value; it now reads the `tab` signal.
- Container queries size the type inside a rich value cell. The minimum WebView
  the Capacitor shell ships with is unconfirmed; older engines fall back to
  inherited body type rather than breaking.
- Flash headroom is now thin. The embedded page went from 22,872 to 42,352
  bytes, taking the `esp32s3-generic` app partition from 89.4% to 90.9% of the
  default 1.3MB, with about 119KB left. The map picker is 10.4KB of that
  increase. A custom partition table, or dropping the map, is the lever if the
  firmware needs room.
