# Backlog

- The suite runs against `receiver/test/binding-server.js`, a JS model of the binding,
  not against the real `bridge/`. Running it over an in-process `aedes` would test what
  ships. See [`../../docs/backlog.md`](../../docs/backlog.md).
- A device seen through two bridges is two cards. Nothing merges them.
- No authentication to a source. The bridge has none, and a dashboard reaching one over
  anything but localhost inherits that. Filed in the bridge's backlog.
- `measureGrid()` floors the cell side at 20px, which breaks letterboxing: at 24 columns
  on a 360px viewport the grid comes out 480px wide and the page scrolls sideways.
- Cards overflowing the row count grow a scrollbar, which shrinks `#cards`'s
  `clientWidth` and so the next cell size. It settles rather than looping, but the grid
  visibly jitters between two sizes.
- `setValueMode`, `setCardHidden`, `setGrid`, and a rename committed with Enter all save
  layout, and all are reachable with a second finger while a resize is in flight.
- The font-size factor of 0.42 and the 11–64px clamp were tuned against a handful of
  synthetic devices.
- `fitValues()` measures on a canvas at the font family `getComputedStyle(document.body)`
  reports, ignoring letter-spacing and font-feature settings, so a style change to `.fv`
  could bring the ellipsis back. It errs about 4px high per value at 64px.
- `measureGrid()`'s `cols × cell` arithmetic is exact only because the grid has no `gap`.
  Re-adding one would overflow the grid by `(cols-1) × gap`.
- A stored `w` or `h` outside 1–24 is discarded rather than clamped, so the card is
  re-sized from its value count instead of pinned to 24.
- `#grid-size` is fixed at `right:12rem` and about 7rem wide, so below roughly 320px of
  viewport width it reaches the left edge and overlaps the grid in edit mode.
- Nothing covers `forgetLayouts()` against a throwing `localStorage`, or the Escape path
  out of a rename.
- The cell-side test re-derives `measureGrid()`'s own arithmetic and compares against the
  global that arithmetic wrote, so a mistake mirrored in both places passes, and the 20px
  floor is never exercised.
- "no card overflows its box at any size or value count" can only catch overflow right
  and below: `scrollWidth`/`scrollHeight` ignore content above or left of the box.
- Nothing drives a card drag and a corner resize in flight at once, the only way to reach
  the mutual-exclusion guards. Chromium exposes real multi-touch through
  `Input.dispatchTouchEvent` over a CDP session.
- `main.js` exposes page internals on `window` through `exposeForTests()`, because 26
  tests in `test/cards.spec.js` drive the page through the globals the firmware version
  had at script level. Deliberate and endorsed — rewriting those tests would destroy the
  evidence that the extraction lost nothing — but it is debt: delete the hook when the
  suite drives the DOM instead. `store.js`'s `getCardState`/`setCardState` exist only to
  serve it.
- `test/fixtures.js` is a copy of `receiver/test/fixtures.js`, and nothing detects drift
  between them. If a fixture changes on one side, the receiver's binding tests and the
  dashboard's card tests silently disagree about what a device looks like.
