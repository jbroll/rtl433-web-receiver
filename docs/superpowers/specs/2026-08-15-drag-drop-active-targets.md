# Design: active-target drag-and-drop indicators

## Problem

The dashboard's card grid lets users reorder cards and values by dragging, but
the current interaction gives almost no feedback:

- It is hard to tell whether a pointer press will drag the whole card or a
  single value.
- There is no visible indication of where the dragged item will land.
- Drop targets are implicit: the code computes the nearest midpoint, but the UI
  never shows it.

## Goal

Make drag-and-drop predictable by showing an active drop target only where the
drop will happen, and by making the drag ghost clearly identify what is being
moved.

## UX

### Drag ghost

- Card drag: ghost is a compact card-shaped badge showing the card name.
- Value drag: ghost shows the field name and current reading, smaller than a
  card ghost.

Both ghosts have enough styling to be immediately distinguishable from normal
content.

### Drop zones

Drop zones are rendered only while a drag is in progress, and only the type
relevant to the drag:

- Card drag: one zone before the first card, one between each pair of cards, and
  one after the last card. No value-level zones are created.
- Value drag: one zone before the first value, one between each pair of values,
  and one after the last value, all inside the source card. No card-level zones
  are created.

A zone is visible only when it is the active target. Inactive zones are
invisible or nearly invisible.

### Active target selection

On each pointer move, the zone whose center is closest to the pointer becomes
active. The active zone is rendered as a clear horizontal or vertical marker.
On drop, the active zone determines the insertion point.

## Implementation

### DOM markers

- `#cards` gets `data-drag="card"` while a card is being dragged.
- The source card's `.body` gets `data-drag="value"` while a value is being
  dragged.

These markers let CSS scope drop-zone visibility and style to the current drag
mode.

### Drop-zone elements

Drop zones are real DOM elements created at drag start:

- `.card-dropzone` elements are inserted as siblings of `#cards .card`.
- `.value-dropzone` elements are inserted as siblings of `.card .val` inside the
  source card.

Each zone carries a `data-before` attribute identifying the key/field it inserts
before, or an empty value to mean "append".

### Drag flow changes

In `dashboard/src/grid.js`:

- `dragMove` creates the appropriate zones after the drag crosses `CLICK_SLOP`.
- It recomputes the active zone on every move and toggles the `.active` class.
- It updates the ghost position and appearance based on `dragging.field`.

In `endDrag`:

- Read `data-before` from the active zone instead of using the midpoint
  algorithm.
- Call `moveCard` or `moveValue` with that target.
- Remove all zones and reset drag markers.

### Styling

In `dashboard/src/style.css`:

- Base drop-zone styles make zones zero-size or transparent.
- `#cards[data-drag="card"] .card-dropzone.active` renders a visible gap/line.
- `.card .body[data-drag="value"] .value-dropzone.active` renders a visible
  gap/line.
- Ghost styles differentiate `.ghostcard.card-ghost` from
  `.ghostcard.value-ghost`.

### State preservation

Rendering is already suppressed while a drag is in flight
(`gestureInFlight()`). Drop zones created at drag start therefore persist until
`endDrag`. The drag markers are set via direct DOM attribute manipulation, not
through a render pass, so they survive render suppression as well.

## Testing

Update `dashboard/test/cards.spec.js`:

- Existing reorder tests should continue to pass.
- Add a test that starts a card drag and asserts exactly one active card drop
  zone exists at a time and that no value drop zones exist.
- Add a test that starts a value drag and asserts exactly one active value drop
  zone exists inside the source card and that no card drop zones exist.
- Add a test dropping a card after the last card using the trailing drop zone.

## Files touched

- `dashboard/src/grid.js`
- `dashboard/src/card.js` (minor: ensure value elements are easy to select)
- `dashboard/src/style.css`
- `dashboard/test/cards.spec.js`
