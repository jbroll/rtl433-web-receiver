# Card grid redesign

The Cards tab lays cards on a grid whose dimensions the user sets, rather than
one that fills itself from a minimum column width. Cells are square. A card
spans whole cells and holds one value per cell. Value type size follows from
the measured size of a cell, so nothing is tuned by hand.

This replaces the `auto-fill, minmax(170px, 1fr)` grid, the fixed 150px row
height, and the square/horizontal/vertical aspect model.

## The grid

Two number inputs in edit mode set columns and rows, defaulting to 6 × 4. They
sit beside the pencil and Forget layouts buttons and are hidden in normal mode.

Cells are square. The side is `min(available width ÷ cols, available height ÷
rows)`, where available height is the viewport less the header and the grid's
padding. The grid is therefore letterboxed: it fits entirely on screen, with
unused margin on whichever axis is not the binding constraint.

The side is recomputed on window resize and whenever the inputs change. It is
written to a CSS custom property on `#cards`, and the grid's tracks are
`repeat(cols, var(--cell))` and `repeat(rows, var(--cell))`.

Columns and rows are clamped to 1–24. A value outside that range, or a
non-number, reverts to the last good value.

## Card size

A card spans `w × h` cells. On first detection it is sized to hold its visible
values one per cell, packed into the most compact rectangle:

    w = ceil(sqrt(V)), h = ceil(V / w)

for `V` visible values. So 1 value gives 1×1, 2 gives 2×1, 3 or 4 gives 2×2, 5
or 6 gives 3×2, 7 through 9 gives 3×3. An Acurite 5n1 showing three readings
defaults to 2×2.

The default is computed once, when the card has no stored entry. Hiding or
showing a value afterwards changes the type size, not the card size.

Cards keep their stored order and `grid-auto-flow: dense` backfills holes left
by larger cards.

## Resizing

In edit mode a card carries a resize handle in its bottom-right corner. Dragging
it snaps to whole cells, with a minimum of 1×1 and a maximum of the grid's own
dimensions. The handle uses the same hand-rolled pointer events as the existing
drags, and a drag on it moves neither the card nor a value.

The aspect button (`▭`) and the square/horizontal/vertical cycle are removed.

## Values

The value grid inside a card matches the card's own cells: `w` columns and
`max(h, ceil(V / w))` rows. At the default size that is exactly one value per
cell. Growing the card gives each value more room; shrinking it packs more
values per cell.

Each value block keeps its current shape: the field name in small caps above
the value with its unit, left-aligned within its box.

Type size follows the measured box rather than a hand-tuned constant:

    font-size = 0.42 × (h × cell ÷ valueRows) px, clamped to 11–64px

The factor and the clamp are starting points to check against real cards. Width
is not part of the formula; `.fv` keeps `overflow: hidden` with an ellipsis, so
a long value is trimmed rather than allowed to overflow. This drops `bodyCols`
and its estimated per-aspect ratio constants, which were never measured against
the live grid.

## Overflow

Cards that do not fit within `rows` rows render below the fold and the page
scrolls. Nothing is clipped and nothing is hidden. The letterboxed fit
guarantees the first `rows` rows are visible at once, not that everything is.

## Persistence

The existing key, `rtl433.cards.v1`, gains a grid entry and per-card sizes:

```json
{ "grid": { "cols": 6, "rows": 4 },
  "order": ["Acurite-5n1/396"],
  "hidden": [],
  "cards": { "Acurite-5n1/396": {
      "name": "Roof station", "w": 2, "h": 2,
      "valueOrder": ["temperature_F", "humidity", "wind_avg_mi_h"],
      "hiddenValues": ["battery_ok"] } } }
```

A stored entry carrying the old `aspect` field and no `w`/`h` is migrated on
load: `sq` becomes 1×1, `h` becomes 2×1, `v` becomes 1×2. The `aspect` field is
then dropped. An entry with neither is sized from its value count.

A missing or invalid `grid` entry falls back to 6 × 4.

Everything else about storage is unchanged: writes happen on each completed
edit action and never during a drag, entries are never pruned automatically,
Forget layouts is the only thing that clears them, corrupt JSON is discarded and
defaults rebuild, and a throwing localStorage leaves state in memory for the
session.

## Testing

Playwright drives the served page through the existing harness:

- cell side is the smaller of the two divisions, at several viewport sizes
- the grid re-measures on window resize
- default card size for value counts 1 through 9
- resizing by corner drag snaps to cells and persists
- resize clamps at 1×1 and at the grid's dimensions
- a card resized larger renders larger type, from the measured box
- an old `aspect` entry migrates to the right `w`/`h`
- an out-of-range column or row input reverts
- no card overflows its box, checked by `scrollWidth`/`scrollHeight` against
  `clientWidth`/`clientHeight`, across several card sizes and value counts

Two gaps found in the current suite are closed here rather than carried:
`fmtValue` gains a negative-number case, since rtl_433 temperatures go below
zero, and the overflow check covers several card sizes rather than one.

## Flash

The card page is already about 2.5 KB past the 15 KB the original spec
expected. This change removes `bodyCols`, `cardCells`, and the aspect handling
and adds the grid measurement and resize handling, so it is roughly neutral.
Measure the delta and report it. The budget itself needs revisiting rather than
defending; that is a separate decision.

## Docs

README's Cards section describes the grid inputs, the corner resize, and the
default sizing rule, and drops the aspect cycle.
