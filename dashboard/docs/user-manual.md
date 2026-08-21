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
alias and puts the topic's own key back as the name. The box only trims and
posts on blur or Enter, not on every keystroke, so a trailing or leading space
can be typed while editing.

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
grid's own dimensions. Every reading on the page takes one size: the largest
that still fits the tightest value box, whether that box runs out of width or
of height. A card holding two readings reads at the same size as a card of five
beside it, so a small card packed with readings sets the size for the page.
Cards that do not fit in the set number of rows render below the fold.

Layout is per browser, in localStorage under `rtl433.dashboard.v1`: the grid size,
the card order, which cards are hidden, and per card a size in cells, the
value order, and which values are hidden or at the bottom. No name is stored
there; a card's name is the published alias, or the device's key if none is
set. Layout is never sent to the device by default, so two browsers can
arrange the same receiver differently.

A receiver can also hold one site-default layout, at `$layout`, keyed by
device model rather than by individual device. **Save as default layout**
(next to Forget layouts, visible only when the served receiver is one of
the dashboard's connected sources) posts the current arrangement there.
**Load default layout** (visible once one has been read from the receiver
serving this page) replaces the current arrangement with it, after a
confirmation prompt. A genuinely fresh browser — nothing in localStorage
yet — applies the serving receiver's `$layout` automatically on first load,
so a new user does not start from a blank grid if the receiver already has
a saved default. Auto-apply also un-hides any device card whose model is
covered by the template and was not hidden when the template was saved.

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

## Settings

The Devices tab opens with the Settings section collapsed. A collapsed Settings
shows only its summary line; expanding it reveals the controls.

**Decimals** selects how many decimal places a card displays, from 0 to 5.
`fmtValue` rounds to that precision and strips trailing zeros, so `1.00`
becomes `1` and `1.50` becomes `1.5`.

**Units** chooses between Metric, Imperial, and Custom. Metric is the default.
Imperial converts temperature to °F, rain to inches, and wind speed to mi/h;
pressure stays in hPa, the metric value.
Custom exposes four selects — Temperature (°C/°F), Rain (mm/in), Wind
(km/h/mi/h/m/s), and Pressure (hPa/kPa) — that each apply independently.

Conversion runs at display time only. Temperature, rain, wind, and pressure
are each converted through a canonical unit (°C, mm, km/h, hPa), so any
source unit composes with any display unit. The stored readings in `devices`
are never modified; a Celsius reading stays Celsius in the device object and
receives an °F conversion only when rendered.

## Location

The Settings section carries a location, which the information feed cards need
and nothing else uses. The page makes no third-party request until one is set.

Type a place name and press Enter or Search to look it up through
OpenStreetMap's Nominatim, then pick from the results. There is no search as you
type, because Nominatim's usage policy rules it out. You can also type a latitude
and longitude directly, or drag the pin on the map. "Use my location" appears
only on an origin the browser counts as secure, so it is absent on the page the
receiver serves over plain http on your LAN and present on localhost.

The time zone defaults to this device's. Choosing another moves the clock, the
sunrise and sunset times, and the forecast day names with it.

Setting the weather location pushes the local GMT offset to the receiver so
its daily rain counter resets at your midnight, not UTC midnight, and
publishes the location itself so other dashboards can pick it up. Both are
sent only when the location changes, and only from a page the receiver itself
serves; a DST transition leaves the reset boundary off by an hour until the
location is set again.

## Feed cards

Once a location is set, four cards appear alongside the sensor cards. They also
appear with no location of your own, if one of your sources has published one —
a dashboard loaded from the bridge gets the receiver's location and time zone
that way. Your own location always wins once you set it. They are
ordinary cards: drag them, resize them, rename them, and show, hide or move
individual values from the Devices tab exactly as with a radio device.

**Weather** shows current conditions and seven forecast days, each day its own
value so you can keep the three you care about and hide the rest. Readings from
the nearest reporting station — temperature, humidity, wind, pressure — arrive
as ordinary readings, so the Units setting converts them like any sensor. It
refreshes every 15 minutes.

Weather comes from the National Weather Service, which covers the United States
only. Elsewhere the card says so and stops asking; the other three cards work
anywhere.

**Sun** opens on a dial: the day drawn as an arc with the twilight bands under
the horizon, a marker at where the sun is now, and sunrise and sunset written
below it. Solar noon, the three twilights and day length sit beside it as
ordinary values.

**Moon** opens the same way: the disc drawn with its terminator, moonrise and
moonset beside it, and the phase and how much is lit underneath.

Because each dial already carries its rise and set times, those two values start
hidden on the card. They are still listed on the Devices tab, so set either back
to shown if you would rather read them as numbers.

Both cards are computed here from your latitude, longitude and the date, so they
need no network at all. In polar summer or winter the dial says "up all day" or
"down all day", and a time that does not occur reads as a dash.

**Clock** shows the time in the chosen zone as two values: `local_time_12` in 12-hour form with AM/PM, and `local_time_24` in 24-hour form. Only the 12-hour value appears on the card by default. Choose `shown` for `local_time_24` in the Devices tab if you want the 24-hour value as well, or hide `local_time_12` to see only the 24-hour clock. The value's header shows a three-letter zone abbreviation such as PDT or MST. The card also shows the date, UTC offset, time-zone name, and whether daylight saving is in effect. The offset is exact. The DST flag is worked out by comparing the current offset against the smallest that zone uses across the year, which is right for the ordinary cases and wrong for a zone that changed its rules mid-year.

A feed card shows no age, because the values are computed fresh. Weather does
show one: it is how old the fetched data is. If a fetch fails the card keeps its
last good values and adds an error line you can hide like any other value.
Results are cached, so reopening the page paints immediately without refetching.

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

Inside the native app shell, a "Scan for receivers" button browses the LAN over mDNS and
lists services whose name starts with `rtl433-`; tap a result to add it as a source. The
button only appears in the app, not in a plain browser. Manual URL entry always works as a
fallback, including for a receiver built with a custom `MDNS_PREFIX`, which the scan won't
find.
