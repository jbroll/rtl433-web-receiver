# User manual

Three tabs — Devices, Log, Cards — and the page opens on Cards. The status
indicator in the header reads `connecting`, `live`, or `reconnecting`.

## Drag-and-drop in edit mode

In edit mode, press and drag a card's label to reorder cards, and a value
inside a card to reorder values within that card. A ghost of the card or value
follows the cursor, and the active drop zone highlights where it will land:
before the first card, between cards, in the gap between rows, or after the
last card. Dropping a card onto the slot it already sits in leaves it where it
is.

Edit mode blocks text selection, so a drag can't turn into a browser text
selection; the rename box still accepts its own text.

## Devices

One row per device: Model, ID, Reading (every field merged from messages seen
so far, since a device like the Acurite 5n1 splits its data across message
types), RSSI, Msgs, Age, an Alias box, and a Card checkbox.

The table sorts alphabetically by Model. Clicking a column header sorts by that
column, and clicking the sorted header again reverses it; an arrow marks which
column is in use. Model, ID, RSSI, Msgs, Age, and Alias sort. Reading does not,
since it is every field of a device run together, and neither does Card. A
device with no value in the sorted column goes last in both directions, so
reversing never buries the rows that do have one. Ascending Age is the most
recently heard device first. ID counts numerically rather than as text, so 5
comes before 396, and a device identified only by its channel sorts after every
device with an id. A header also sorts from the keyboard, with Enter or Space.
The choice is stored per browser under `rtl433.devicesort.v1` and survives a
reload.

The Reading column excludes the fields the page treats as metadata rather than
a sensor value: `model`, `id`, `channel`, `protocol`, `rssi`, `duration`,
`mic`, `message_type`, `sequence_num`, `time`, `count`, and `build`. A value in
the merge can come from an earlier message than the row's own Age, which
tracks the newest message regardless of which fields it carried; a value can
therefore be older than the age column shows.

The Alias box names that device's card, the same name double-clicking the card
label sets; both post to `<topic>/$alias`, so a name assigned in either place
is visible to every viewer. Emptying the box posts `""`, which removes the
alias and puts the topic's own key back as the name.

A new device gets no card. The Card checkbox is how it gets one, and it reads
the same setting the ✕ on a card writes, so a device hidden from the Cards tab
shows unchecked here. The ✕ only hides; since a hidden card is not drawn at all,
this checkbox is the only way to bring one back. This is what keeps decodes from
protocols nobody owns, which arrive on any 433 MHz receiver, off the dashboard
by default.

The table rebuilds every second but holds still while a text box or a select
in it has focus, so an entry in progress is never interrupted. Only the tab on
screen is rebuilt; switching to one draws it.

Under each device is one row per reading, carrying that reading's current
value and a select for its display mode. This is where a card's contents are
chosen; the card's own edit mode only arranges what is already there.

Every reading has three display modes: Shown puts it in the card body at full
size, Bottom puts it small and labelled along the bottom-left edge (mirroring
the age at bottom-right, which is where a battery flag belongs), and Hidden
drops it. rtl_433's status fields (`battery_ok`, `test`, `tamper`, and the
rest) start at Bottom; everything else starts Shown.

## Log

Raw messages as they arrive, newest first, capped at 200 rows in the browser.
The device keeps no history of its own, so the Log starts empty on every page
load — nothing before the page connected can be replayed into it.

## Cards

Cards is the tab the page opens on. It lays every device whose card is checked
in the device table on a grid of square cells. Two number inputs in edit mode
set the columns and rows, 6 × 4 by default and 1–24 each; the cell side is
whichever of width ÷ columns and height ÷ rows is smaller, so the grid fits on
screen with margin on the other axis. Nothing narrows the default for a small
screen, so a phone gets the full 6 × 4 grid of very small cells until the user
sets smaller numbers.

A card spans whole cells. On first detection it is sized to hold its visible
readings one per cell, in the most compact rectangle: one reading gives 1×1,
three or four give 2×2, seven through nine give 3×3. Dragging the corner
handle in edit mode resizes it, snapped to whole cells, from 1×1 up to the
grid's own dimensions. Type size follows the measured cell, so a bigger card
reads bigger, and shrinks further where a reading is too wide to fit at that
size. Every reading on a card takes the same size, the one its widest needs.
Cards that do not fit in the set number of rows render below the fold.

Layout is per browser, in localStorage under `rtl433.dashboard.v1`: the grid size,
the card order, which cards are hidden, and per card a size in cells, the
value order, and which values are hidden or at the bottom. No name is stored
there; a card's name is the published alias, or the device's key if none is
set. Layout is never sent to the device, so two browsers can arrange the same
receiver differently.

A card the user showed or renamed is kept even after its device goes quiet, so
a sensor that returns finds its card as it left it. A card that was never
shown is dropped once its device is gone from the table, which is what keeps a
band full of one-off false decodes from growing the stored layout without
limit.

Forget layouts, in edit mode, clears the lot after a confirmation prompt. The
devices on screen at the time keep their cards; only ones seen afterwards
start hidden.

## Cards edit mode

The pencil button opens edit mode, which arranges the card and nothing else:
cards drag to reorder, values drag to reorder within their card, the corner
handle resizes, ✕ hides the card, and double-clicking the label renames it (and
posts the alias). A card shows the same values in edit mode as out of it; what
appears is the card's own controls. A hidden card is not drawn in either mode,
so the Devices tab's checkbox is what brings one back. A long
device name in the label ellipsizes rather than overflowing the card; readings
round to one or two decimal places for display, without changing the stored
values.

## Sources

With no sources configured the dashboard reads the origin it was served from. The
settings panel adds and removes base URLs, stored in `localStorage` under
`rtl433.sources.v1` beside the layout.

A base URL is an origin with no trailing slash: `http://rtl433-a1b2c3.local` or
`http://bridge.local:8080`. Each gets its own SSE stream and reconnects on its own, so
one source being down does not affect another. A dot beside each URL shows that source's
connection state.

Two sources publishing the same topic stay two devices with two cards. Removing a source
drops its devices and its cards; re-adding it starts them from defaults again.

A source on another origin has to allow the dashboard's origin. The receiver and the
bridge both answer `Access-Control-Allow-Origin: *`, so any build of the dashboard can
read either.
