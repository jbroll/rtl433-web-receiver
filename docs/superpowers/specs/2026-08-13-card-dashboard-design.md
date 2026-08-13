# Card dashboard design

A third tab, Cards, showing each tracked device as a card in a grid. Layout is
per browser and editable in place: cards reorder by drag, values reorder and
toggle within a card, cards hide, rename, and change shape.

## Placement and serving

- Cards joins the Devices and Log tabs on `/`.
- Markup, CSS, and script live in a new `cards_html.h` PROGMEM array.
  `handleRoot()` streams `INDEX_HTML` then `CARDS_HTML` into one response.
  `INDEX_HTML` loses its closing `</body></html>`, which moves to the end of
  `CARDS_HTML`.
- No new endpoints, no other firmware changes.

## Data flow

- The card view is a second renderer over the existing `devices` Map.
  `upsert()` and `refresh()` call `renderCards()` beside `renderDevices()`;
  the existing 1 s interval ticks ages.
- Re-rendering is suppressed while a drag is in progress.
- A card flashes on update as a table row does now.

## Card anatomy

- An outlined rounded box. The label, nickname plus RSSI, sits small in the
  upper right overlapping the top border, page background behind it,
  legend-style. Age sits tiny in the bottom-right corner.
- The body is the device's visible values in stored order, wrapping. Each
  value block is the field name in small caps above the value with its unit.
- All values in a card render at one size:
  `font-size = 2.4rem × √(cells ÷ visibleCount)`, clamped to 0.9–2.6rem,
  where `cells` is the card's span area (1, 2, or 4). Hiding a value grows
  the rest; growing the card grows everything. The 2.4rem base is a starting
  point to tune against real cards.

## Grid and aspect

- The grid is `repeat(auto-fill, minmax(170px, 1fr))`, fixed row height
  ~150px, `grid-auto-flow: dense`. Order is respected; `dense` backfills
  holes left by wide cards.
- Aspect is per card: square 1×1, horizontal 2×1, vertical 1×2. A square
  card with more than 6 visible values spans 2×2.
- On narrow screens the grid drops to one or two columns and spans clamp to
  what fits.

## Edit mode

A pencil/lock button in the Cards view. Normal mode: cards are inert, touch
scrolls. Edit mode:

- Drag a card to reorder it. A drag starting on a value block moves the
  value; a drag starting anywhere else on the card moves the card. A ghost
  follows the pointer; the drop slot comes from the nearest card midpoint.
- A value drag reorders within its card only. Values never move between
  cards.
- Click a value (pointer travel under ~6px) to toggle its visibility.
  Hidden values render ghosted in edit mode, absent in normal mode.
- An aspect button cycles square → horizontal → vertical.
- A hide button (✕) hides the card. Hidden cards render ghosted at the end
  of the grid in edit mode, absent in normal mode.
- Double-click or long-press the label to rename via an inline text input.
  Empty input reverts to the model/id key.

Drag uses hand-rolled pointer events (`pointerdown`/`pointermove`/
`pointerup` with `setPointerCapture`). No libraries.

## Defaults on first detection

- A new device is visible and appends to the end of the card order.
- Value order is payload order. A built-in list of status fields
  (`battery_ok`, `mic`, `test`, and similar flags) starts hidden; readings
  start visible.
- Aspect defaults to square for up to 3 visible values, horizontal above.
- Defaults apply only when a device or field has no stored entry; after
  that, storage wins.

## Persistence

One localStorage key, `rtl433.cards.v1`:

```json
{ "order": ["Acurite-5n1/396"],
  "hidden": ["Oregon-THN132N/23"],
  "cards": { "Acurite-5n1/396": {
      "name": "Roof station", "aspect": "h",
      "valueOrder": ["temperature_F", "humidity", "wind_avg_mi_h"],
      "hiddenValues": ["battery_ok"] } } }
```

- Writes happen on each completed edit action, not during drag.
- Devices or fields absent from storage get defaults and are appended, so a
  sensor adding a field or a device reappearing after eviction keeps its
  layout.
- Entries are never pruned.
- Corrupt or unparseable JSON is discarded and defaults rebuild. If
  localStorage throws (private browsing), state lives in memory for the
  session.

## Testing

- `FAKE_SIGNALS` provides synthetic decodes; Playwright drives the served
  page: tab switching, default card creation, visibility toggling, both drag
  reorders, hide/unhide, rename, aspect cycling, persistence across reload.
- The store self-test is untouched.
- Check the flash-size delta after build; expected under 15 KB added.

## Docs

README's pages section gains the Cards tab.
