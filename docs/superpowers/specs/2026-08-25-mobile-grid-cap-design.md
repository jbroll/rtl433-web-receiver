# Mobile card grid design

## The problem

On a 390 px phone the dashboard renders cards 48 px square. Card titles ellipsize to a
single letter, value labels clip mid-word, and the bottom row and age stamp are drawn
through the values.

Three defects share one cause. `measureGrid` (`dashboard/src/grid.js:26`) sizes a cell as
`min(width / cols, height / rows)` with a 20 px floor, and `cols` is 6 because that is what
the saved desktop layout says. 358 px of usable width over 6 columns gives a 59.7 px cell,
48 px once the card's own margins are taken. Into that the card puts 17.6 px of padding,
leaving about 30 px of body, and the fixed-size chrome around it does not scale down with
the cell:

- `.card .btm` and `.card .age` are `position:absolute; bottom:.25rem`, while `.card .body`
  is `height:100%` across the whole content box. Nothing reserves a band for them, so
  `BATTERY OK` renders on top of `72.3`. At a 150 px desktop cell there is enough slack
  that it is not visible.
- `.card .fn` is `white-space:nowrap` with no `text-overflow`, inside `.val { overflow:hidden }`,
  so `TEMPERATURE` becomes `TEMPER`.
- `.card .lbl` is capped at `calc(100% - 1.4rem)`, which on a 48 px card is 25.6 px.

`FONT_MIN` of 11 px in `grid.js` compounds all three: below a certain cell size the text
cannot shrink to fit, so it clips.

## The approach

A view column count, derived from the viewport, distinct from the saved
`cardState.grid.cols`. Rendering reads the derived value; everything that persists keeps
reading the saved one.

That separation is what keeps `Save as default layout` honest. Deriving a template from the
capped view would write 3 columns to the receiver and replace the 6-column desktop default
for every browser. `deriveTemplate()` reads `cardState` directly and is not touched, so
saving from a phone writes the same template as saving from a desktop, and a card moved or
resized on the phone still applies to the real grid.

## What changes

**`dashboard/src/grid.js`** gains `MIN_CELL = 110` and computes

    viewCols = clamp(1, floor(usableWidth / MIN_CELL), g.cols)

110 px is the number that decides a phone gets 3 columns rather than 2 or 4. At any desktop
width the clamp lands on `g.cols` and nothing changes.

When `viewCols < g.cols` the cell is sized from width alone, `usableWidth / viewCols`,
rather than `min(width/cols, height/rows)`. Dropping to 3 columns means more rows than fit
on a phone screen, and the alternative — shrinking cells until every row fits — is what
produced the 48 px cell in the first place. The page scrolls vertically instead.
`gridTemplateRows` stops being pinned to `g.rows` so auto-placement can grow.

**`dashboard/src/cards.jsx:92`** clamps the span to `Math.min(w, viewCols())`, so the
5-wide Weather card renders 3 wide instead of overflowing. The resize handle at
`grid.js:250` clamps to `viewCols` for the same reason: a card cannot be dragged wider than
the visible grid.

**`dashboard/src/style.css`** takes three fixes. They are independent of the cap and are
worth making at any cell size:

- `.card` `padding-bottom` rises from `.6rem` to `1.15rem`, reserving the band `.btm` and
  `.age` occupy. `.age` is on every card, so the band is always reserved.
- `.fn > span:first-child` gets `min-width:0; overflow:hidden; text-overflow:ellipsis`, and
  `.fn .u` gets `flex:0 0 auto`, so a long label ellipsizes rather than clipping mid-word.
- `.card .lbl`'s `max-width` drops from `calc(100% - 1.4rem)` to `calc(100% - .9rem)`. The
  label sits at `right:.7rem`, so .9rem still clears the right offset; the old 1.4rem
  reserved a matching gutter on the left that nothing needs.

## What does not change

`cardState`, `deriveTemplate()`, `postLayout()`, `applyTemplate()`, the `$layout` payload
shape, and the receiver and bridge. This is a rendering change in the dashboard.

## Testing

`dashboard/test/layout.spec.js` and `fontfit.spec.js` are the patterns to follow.

- A spec at a 390 px viewport: the rendered grid has 3 columns, and for every card the
  `.body` and `.btm` bounding rectangles do not intersect. Rectangle intersection is the
  assertable form of "the bottom row is not drawn through the values"; asserting on visible
  text would not catch it, since both elements render either way.
- A spec asserting every `.fn > span:first-child` computes `text-overflow: ellipsis`. A
  label that needs to ellipsize legitimately has `scrollWidth > clientWidth`, so overflow
  alone is not the defect — clipping without an ellipsis is.
- A spec at a desktop viewport: the rendered grid still has 6 columns, so the cap is inert
  where it should be.
- A unit test that `deriveTemplate()` returns `grid.cols === 6` while the view is capped to
  3, which is the guarantee that a phone cannot rewrite the site default.
