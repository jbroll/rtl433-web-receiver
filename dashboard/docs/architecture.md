# Architecture

## Modules

Preact with `@preact/signals`, bundled by `esbuild` into one `<script>`.

| Module | Holds |
|---|---|
| `main.jsx` | wiring: boot order, the SSE sources, the feed scheduler, the test hooks |
| `app.jsx` | the tab shell and the cards toolbar |
| `units.js` | the meta and status field sets, `splitUnit()`, `fmtValue()`, `displayValue()`, `ageText()`, reading extraction |
| `alias.js` | keys, the alias map, name resolution, the alias POST, `isFeed()` |
| `auth.js` | the bridge access token, in `localStorage` keyed by origin |
| `devices.js` | the live device map, capped at `DEVICE_MAX` per source |
| `store.js` | card layout in `localStorage`, and `forgetLayouts()` |
| `settings.js` | units, decimals, and the location, in `localStorage`, with a source-published location and units as fallback |
| `sources.js` | the source list and its storage |
| `bridges.js` | the receiver's MQTT push-bridge list, fetched from `/$mqtt`, and its mutations |
| `stream.js` | one source's SSE connection and its reconnect |
| `grid.js` | cell arithmetic, the resize and drag gestures, and value fitting |
| `cards.jsx` | the card grid, one card, and its values |
| `render-values.js` | the renderer registry for values that draw their own cell |
| `renderers.jsx` | those renderers |
| `devices-table.jsx` | the device table and the settings section above it |
| `devicesort.js` | the table's sort column, its direction, and its storage |
| `log.jsx` | the log tab |
| `location.jsx` | the location controls inside settings |
| `geocode.js` | Nominatim search |
| `astro.js` | solar and lunar arithmetic, no I/O |
| `zone.js` | zone-local date arithmetic over a cache of `Intl.DateTimeFormat` instances |
| `tick.js` | the one-second signal that is the app's only timer |
| `settings.jsx` | the settings pane, and the panels below it |
| `sources.jsx` | the source list controls and the mDNS scan |
| `bridges.jsx` | the push-bridge panel and its add and remove forms |
| `toast.js` | the transient message signal, expired off `tick.js` |
| `toast.jsx` | the message itself |
| `layout_template.js` | the source-published `$layout`, and the latch that stops adopting one |
| `feeds/` | the feed scheduler, its cache, and one module per feed |

`build.js` pins `absWorkingDir` to the dashboard directory. PlatformIO runs it
from `receiver/`, where there is no `node_modules`, and esbuild resolves alias
targets against the working directory.

## Grid sizing

`measureGrid()` in `grid.js` derives a view column count from the viewport:
`clamp(1, floor(usableWidth / 110), grid.cols)`. 110px is the width below which
a cell stops being legible; at any desktop width the clamp lands on the saved
`grid.cols` and the derived count is inert.

Width alone would give a short landscape window the same column count as a
tall portrait one at the same width, needing more rows than fit and scrolling
the page. A second, height-derived count raises the column count, up to
`grid.cols`, to whatever keeps `ceil(cardCount / cols)` rows at 110px within
the available height; the final count is the larger of the two.

The derived count is separate from the saved `cardState.grid.cols`, and only
rendering reads it: the card's rendered span, the resize gesture's upper bound,
and `gridTemplateColumns`. `deriveTemplate()` reads `cardState` directly, so
saving a layout from a phone writes the same template as saving from a desktop
rather than pushing 3 columns onto every other browser, and a card moved or
resized on the phone still applies to the real grid.

When the derived count is below the saved one, the cell is sized from width
alone rather than from `min(width/cols, height/rows)`, and `gridTemplateRows` is
left to `grid-auto-rows`. Fewer columns means more rows than a phone screen
holds, and shrinking the cell until they all fit is what made cards illegible in
the first place. The page scrolls instead.

When the height-derived count instead raises `cols` up to the saved `grid.cols`,
the cell falls into the other branch, `min(usableWidth/cols, usableHeight/g.rows)`,
which carries no 110px floor. The only floor there is 20px, and it is a
legibility minimum rather than a guarantee: `grid.js` raises the cell to 20px
only when the width alone already allows it, since forcing it when the viewport
cannot fit `g.cols` at 20px would overflow the page sideways. A
short, wide window (a landscape phone, a resized desktop window) can still land
a cell under 110px there: raising columns to avoid scrolling and keeping every
cell legible are in tension, and this branch resolves it in favor of not
scrolling. That is a deliberate exception to the 110px floor, not a bug.

Both cell-size formulas subtract the grid's `column-gap`/`row-gap` from the
usable width and height before dividing by column and row counts — `(cols-1)`
and `(rows-1)` gaps sit between cells, not around them.

A stored layout is read back through two different repairs, on purpose. A card's `w`
and `h` go through `clampGrid`, which pulls an out-of-range value into `GRID_MIN` to
`GRID_MAX`, because a card that is too wide is still that card and its position is worth
keeping. `grid.cols` and `grid.rows` go through `gridNum`, which discards an
out-of-range value for the default, because a bad grid size would carry every card on
the page with it, and the default is a page that can be read.

`.card`'s bottom padding (`1.2rem`) reserves the band `.btm` and `.age` are
absolutely placed in. `.body` is `height:100%` of what is left, so the bottom
row is not drawn through the values at any cell size.

`Body()` in `cards.jsx` sizes `.body`'s own `gridTemplateColumns` from
`min(w, visible value count)`, not the card's width `w` directly, so a card
wider than the values it shows spreads them across its full width instead of
leaving empty columns.

Below 400px wide, `#edit-controls` (the edit-mode buttons and `#grid-size`)
switches from each child's own `position:fixed; right:Nrem` to a wrapping flex
row along the bottom; the individual `right` offsets otherwise push
`#grid-size` past the left edge and into the grid.

## Drag zones

`grid.js` builds the drop zones once, when a drag starts, as fixed rectangles
over the card or value layout. Card zones come from the grid grouped into
visual rows: a strip before the first card, one after the last, one between
horizontally adjacent cards in a row, and a full-width gap strip between rows.
Rows that interleave when a tall card spans two rows leave no gap, so the strip
is skipped. Value zones are the same idea inside a card's value grid.

The active zone is the nearest zone *rectangle*, measured to the closest point
on its edge rather than its center. A drop inside a large zone, such as the
after-the-last-card slot beside a tall card, must not be stolen by a narrow
gap strip whose center happens to be nearer.

The ghost is a clone of the card or value being moved, sized to the original,
with the close and resize handles stripped; the browser's native drag is
suppressed in edit mode so a grab cannot start a text selection instead. A drop
on a card's own slot is a no-op in `store.js`, so dragging a card back where it
was cannot move it.

The grid flows sparsely (`grid-auto-flow: row`). Dense packing would backfill a
dropped card into an earlier hole left by mixed card sizes, so a drop into an
empty cell would reorder the DOM without moving the card on screen.

A gesture excludes the layout writers that are not part of it. `setValueMode`,
`setCardHidden` and `setGrid` in `store.js` return early while a drag or resize is in
flight; `moveCard`, `moveValue` and `setCardSize` do not, because they are how a gesture
commits itself. `store.js` cannot import `grid.js` without closing a cycle, so `grid.js`
registers `dragOrResizeInFlight` through `setGestureHook`, the same shape `setEditHook`
already uses. `dragOrResizeInFlight` deliberately excludes `renaming.value` where
`gestureInFlight()` includes it, so a rename can commit its own name through the same
writers. Nothing corrupts today without these guards — an in-flight resize has written
nothing, and `endResize` re-renders over whatever a second finger did — so this closes a
rule violation rather than an observed bug.

## Card memo

`Card` in `cards.jsx` is wrapped in `memo(Card, areEqual)`. `areEqual` returns `true`
while a drag, resize, or rename is in flight on that same card's key, `false` otherwise
-- freezing a card's DOM while a gesture has it, so a live reading arriving mid-drag
doesn't move or resize it under the pointer.

`memo`'s comparison only gates a re-render `Card`'s parent asks for. `@preact/signals`'
Preact integration re-renders a component directly, bypassing `memo`, when a signal it
read during its own last render changes -- so any component under `Card` that reads
`rec.merged.value` itself would freeze past `areEqual` regardless of what `Card` does.
`Card` reads `rec.merged` once, through `useFrozenValue`: while the gesture holds this
card's key, the hook returns the value it last read instead of touching `sig.value`,
so it doesn't resubscribe for the duration and the forced re-render a change would
otherwise trigger doesn't happen. `Card` passes the result down as a plain `merged`
prop; `Body`, `Value`, `RichValue`, and `BottomStrip` read fields off that prop rather
than the signal, so none of them can independently subscribe and leak an update past
the freeze. The gesture's own imperative state (the ghost element, the `lifting` class,
drop zones) lives outside `Card`'s render output and is unaffected either way.

## Render cost per message

Two render costs that look obvious from reading the source turn out not to be there, both
measured by counting calls rather than inferred.

A message does not force two synchronous layouts in `cards.jsx`. A repeat message to a
device already on the page re-renders `CardsView` zero times, because `upsert()` on an
existing record writes only that device's own signals, and a new device coalesces the
`devices.value` and `cardState.value` writes into a single render. The layout effects run
once per render, not twice. The dependency arrays those effects carry do have one real
effect: a change to `devices.value` alone — an eviction, `clearSource()`, `clear()` — no
longer refits the grid on its own, so the refit is driven explicitly where it is needed.

The devices table does not re-render every row per packet either. `Rows()` in
`devices-table.jsx` does re-run its whole loop on any one device's change, since it reads
every device's `r.merged.value` to build the field lists. But `@preact/signals` installs a
global `shouldComponentUpdate` that skips a signal-reading component when no state changed
and every prop is reference-equal, and `upsert()` mutates the record in place, so
`props.r` keeps its identity and `DeviceRow` does not re-render. What is real is `Rows()`'s
own per-packet work: one `sortDevices()` and one `cardFields()` call per device.

## Keys

A device is keyed `<base> <topic>` — the source's base URL, a space, and the topic. A
space cannot appear in a valid topic, so the split is unambiguous. Two sources publishing
the same topic are two devices with two cards, and a card's stored layout uses the same
key, so moving a device between bridges gives it a new card rather than one inherited
from another source's device of the same name.

## The build

`build.js` bundles `src/main.js` and `src/style.css` separately and substitutes both into
`src/index.html`, which carries `/*CSS*/` and `/*JS*/` markers. The output is one
self-contained file with no external requests, which is what a browser loads and what the
firmware embeds — one artifact, one thing to test.

`@devioarts/capacitor-mdns` is a dependency of both `app/package.json` and
`dashboard/package.json`. `app/`'s copy is the native Android plugin; `dashboard/`'s is the
JS import used by `sources.jsx`. Since `dashboard/` bundles standalone into `dist/index.html`
— loaded directly by a plain browser and by the Capacitor WebView alike — the import has to
resolve from `dashboard/`'s own `node_modules`, not `app/`'s.

`DEVICE_MAX` is an esbuild `define` read out of `../receiver/signal_store.h`, so it tracks
one firmware's slot count. `devices.js` uses it as a per-source cap, multiplied by the
number of configured sources, rather than a cap on the whole device table — a page reading
several receivers holds up to `DEVICE_MAX` devices from each, not `DEVICE_MAX` total. Node
tests that import `devices.js` directly set `globalThis.DEVICE_MAX` themselves.

## Name layering

Per the binding, a display name resolves in three steps: the browser's own configuration
first, the source's published `$alias` next, the stable topic segment last. The dashboard
keeps its own aliases in `localStorage` under `rtl433.aliases.v1`, so in practice
`displayName()` is `aliasOf(key) || shortKey(key)`.

When the dashboard is served by a receiver, a rename still posts to the source's `$alias`
topic so the receiver can persist it. When the dashboard is served by a separate broker or
static server, the source is external and has no persistent alias store for that client,
so the rename stays local and survives reloads from `localStorage`. That POST, and the `$tz`, `$location`, and `$units` POSTs `settings.js` makes on a
location or units save, carry `Authorization: Bearer <token>` via `authHeader()` when
`auth.js` holds a token for the posting origin — the only origin any of them ever posts
to, since each is gated on `location.origin` (or `sourceOf(key) === location.origin` for
the alias write) in the first place.

## Display pipeline

`units.js` owns three functions that shape every reading as it reaches the UI.

`splitUnit(field)` strips the trailing unit suffix from the field name and returns
`{ name, unit }`. The suffix comes from rtl_433's naming convention, so no table of
sensor types is needed.

`fmtValue(v, decimals)` rounds the number to the given precision and strips trailing
zeros — `1.00` → `"1"`, `1.50` → `"1.5"`.

`displayValue(field, raw, settings)` calls `splitUnit`, then checks whether the field
belongs to a converting group (temperature, rain, wind, pressure). If it does, it
converts the raw value through the canonical unit for that group — °C for temperature,
mm for rain, km/h for wind, hPa for pressure — and then to the target unit the
settings specify. Fields outside any converting group pass through unchanged. The
result is `{ name, num, unit }`.

`settings.js` owns the `rtl433.settings.v1` signal, whose value is
`{ units: "metric" | "imperial" | "custom", decimals: 0–5, custom: { temp, rain, wind, pressure } }`.
The presets are Metric (°C, mm, km/h, hPa) and Imperial (°F, in, mi/h, hPa).
Choosing a preset overwrites all four custom fields; in Custom mode the four
fields are stored independently and changed one at a time.

The signal also carries the location. Behind it sits a network fallback: the
`$location` and `$tz` a source publishes, kept in a per-source map and
consulted by `resolvedLocation()` only when nothing is set locally. The
fallback is never written into `localStorage`, so a location set locally takes
over the moment it exists. Setting a location also POSTs `$location` and `$tz`
back, but only to an origin that is itself a configured source; a change that
touches only `zoom` skips both POSTs, since zoom is a view preference. `activeZone()`
resolves the zone on its own chain — the local zone if one is set, else the
fallback's, else the browser's — independent of whether local coordinates exist,
so a zone chosen with no coordinates still wins. `refreshTz()` recomputes the
offset every tick and POSTs `$tz` again only when it has changed, which keeps
the receiver's rain-day rollover correct across a DST transition. The DST flag
`isDST()` in `zone.js` reports is inferred by comparing a date's offset against
January's and July's, not read from any API, so it is wrong for a zone that
changed its DST rules mid-year.

`location.jsx`'s "Use my location" button only renders when `navigator.geolocation`
exists and `isSecureContext` is true. Geolocation is refused outside a secure
context, and the page the receiver serves over plain http on a LAN address is not
one, so the button is absent there. The suite cannot cover that branch: `harness.js`
serves on 127.0.0.1, which browsers treat as secure regardless of scheme.

`$units` carries the same three unit fields the settings signal holds, in a
per-source map of its own. It resolves differently from the location: rather
than sitting behind the signal, a frame is adopted into it, because every
reading is rendered from the signal and nothing reads a fallback layer. Adoption
is a one-way latch, the same discipline `layout_template.js` uses for the site
default layout: the visitor's first unit change closes it, and `saveSettings()`
records that as `unitsChosen` so a reload closes it again. Saving a location
alone leaves the marker false and adoption open. A blob written before `$units`
existed carries no marker at all and counts as a choice, so upgrading never
overrides units someone had already picked. An adopted frame is never saved, so
a browser where no choice was made takes whatever the receiver publishes on each
load. `setUnits`, `setDecimals` and `setCustomField` each POST the whole object
back through `publishUnits()`, origin-gated the way the location POSTs are. The
Save as default layout button calls `publishUnits()` too, so a receiver nobody
has changed a unit control on still ends up with stored units instead of
404ing `GET /$units`.

`cards.jsx` and `devices-table.jsx` both render readings through `displayValue`.
`CardsView` reads the settings signal as a dependency, so any settings change
triggers a re-fit: font size is recomputed against the new display values and the
card re-renders with the updated numbers and units.

## Value fit

`fitValues()` in `grid.js` sets the type size of every `.fv`. For each tracked
node it measures the displayed number on a canvas, in `textWidthEm()`, and
divides the box width by that to get the size the box allows. `trackFit()`
stores the number, not a precomputed width, so the measurement is fresh on
every `fitValues()` run rather than fixed at mount — a CSS-only change to
`.fv` (letter-spacing, font-feature-settings) is picked up without a
re-render. The probe font comes off a tracked `.fv` node's own computed style,
not `document.body`, so it matches what is actually on screen. The unit is not
in that width because it renders in the `.fn` header, not beside the number.

`.card .val` publishes its line-height as the custom property
`--val-line-height`; `fitValues()` reads it once per run with
`getComputedStyle` rather than duplicating the number as a JS constant.

Every reading on the page takes one size. Each value bounds it twice: by width,
at `box ÷ em`, and by height, at what its box leaves under the field name
divided by the line height. The smallest bound any value produces is the size
they all get, with a floor of 11px. A card of two readings therefore reads at
the same size as a card of five beside it, rather than each card sizing to its
own boxes. A reading that still doesn't fit its box at 11px ellipsizes rather
than shrinking further — `overflow:hidden` on `.fv` clips it, and the floor is
deliberate: there is no smaller size worth reading.

A single crowded box would otherwise set that size for the whole page: one
card with an unusually tight cell shrinks every other card's type to match it.
`fitValues()` floors the page size at 0.6 of the median of every tracked
box's own fit, so that one outlier ellipsizes on its own instead. 0.6 is
chosen to still let a page of genuinely similar-sized readings track its true
minimum closely (a bound at, say, 0.9 would fight the legitimate case where
every card is about equally tight), while stopping a single pathological box
from pulling the whole page down to a fraction of what the rest can show.

The median needs no minimum sample size to apply: with only one or two tracked
boxes, "median" and "the tight one" can be the same value, and the 0.6 floor
then does nothing to protect against that box overflowing its own cell — there
is no second box for it to be an outlier against. A page with that few cards
has no crowding problem the floor exists to solve in the first place.

`fitValues()` is the only writer of `.fv` font size. Setting an initial size in
the JSX as well would let a re-render put the unfitted size back, which is what
made a card snap to small type after a grid resize.

A value box on a hidden tab measures zero, so `fitValues()` skips a node it
cannot measure rather than fitting it to the floor. `CardsView` watches the grid
with a `ResizeObserver`, which fires when the tab comes back and the boxes get
their size, and re-fits then.

At extreme aspect ratios (e.g. a 2x1 card) the fit is height-bound rather than
width-bound, so measuring width fill alone legitimately reads well below full;
checking whichever of width or height fill is tighter stays near full
regardless of which dimension bound the fit.

`test/cards.spec.js`'s "no card's content extends past its right or bottom
edge" only checks those two edges: `scrollWidth`/`scrollHeight` can't see
content above or left of the box, where `.lbl` sits by design (`top:-.65em`).
It also can't catch a value overflowing its own `.val`/`.fv` box, since
`overflow:hidden` (`style.css:72,97`) clips that before the metric sees it —
the value-level guarantee is the width/height-bound fit described above.

## Feed cards

Weather, sun, moon and clock need everything a card already does: ordering,
drag, resize, per-value hide and bottom placement, rename. All of that keys off
the device map, so a feed publishes through `upsert()` as a synthetic record
rather than growing a parallel system.

Feed keys use a reserved base, `local`, giving `local feed/Weather` and its
three siblings. `normalizeBase()` only ever yields an `http(s)` URL, so the base
cannot collide with a real source, and `shortKey()` already slices the topic
down to the bare name for display and rename.

Four places assumed every record came off a radio, and `isFeed()` guards each:

- `trim()` caps the map at `DEVICE_MAX` times the number of configured sources,
  which is zero until one is added. It counts and evicts radio records only.
- `clearSource()` matched anything sharing a base prefix.
- `pruneCardState()` kept only keys with a live device record, which would
  discard a feed's saved size and value layout before it ever ran.
  It also needs a source to have delivered at least one device before it will
  drop any of that source's hidden cards. `devices.value` is empty at boot and
  `primeFeeds()` saves before any stream opens, so pruning against it there
  threw away every hidden card's saved size — and left the Receiver card
  showing again on every load, because `ensureCard()` is the one place that
  never re-hides it.
- `ensureCard()` hides every new card. Feeds pass `autoShow`, applied only on
  creation so a later user hide is never undone.

A record with `seenAt` of 0 shows no age. The sun, moon and clock come off the
system clock and are never stale; weather stamps the time its data came from, so
its age corner reads as genuine staleness.

Sun and moon events are solved against the local day of the card's zone, not the UTC
day. A card in a zone hours from UTC otherwise shows yesterday's or tomorrow's sunrise.

`sunEvents` takes the two instants that bound that local day, samples solar altitude
across them every minute, and bisects each event's altitude crossing inside the window.
The window is 23 to 25 hours long across a DST transition. Each bound is the first
instant carrying that local date, bisected against the zone rather than derived from an
offset, which reads the wrong side of a transition and has no answer at all where local
midnight is skipped (Santiago springs forward at 24:00) or happens twice. An event has
no representation outside the window, so none can be dated on the wrong day and none can
be reported on a day whose crossing does not exist. Solar noon is the one instant of
zero hour angle inside the window, solved rather than searched.

A day near the polar summer boundary can hold two crossings of one altitude in the same
direction, one left over from the previous evening. The dawn reported is the first and
the dusk the last, so each pairs with that day's own sunrise and sunset. A day holding
one horizon crossing has its daylight measured to the window edge; falling through to
zero there printed "0h 0m" and put the dial's sun below the horizon on a day with 22
hours of it. An earlier version solved each event at a fixed anchor and corrected the
answer afterwards, which mistimed the events it had to correct by up to 1,951 s and
emitted spurious ones on short days.

Moonrise and moonset use a coarser method than the sun's bisection: `moonAltitude` is
sampled every ten minutes across the local-day window and each crossing found by
interpolating between samples. `test/astro-sweep.js`'s sweep (44 sites, 2026-2027,
32,120 calls, 55,963 emitted moon events) found no wrong-day or spurious events, but
timing is only good to about 3 minutes, not seconds — worst case 194.6s at Reykjanes,
with the next-largest errors also at high latitude (Tromsø, Murmansk, Reykjavik, Nuuk),
where the moon crosses the horizon at a shallow angle and a ten-minute sample spacing
resolves the crossing time poorly. The sweep also missed 2 events: grazing rise/set
pairs minutes apart that a ten-minute sampler cannot distinguish. An accuracy bound,
not a defect.

The sun dial's `riseText` and `setText` are `''` when there is no event that day, not an
em dash. The renderer tests the field for emptiness to decide whether to draw the label
at all, and a placeholder character is not empty. The flat `sunrise`/`sunset` fields go
through `zone.js`'s formatter, which does render `—` for a null, because those go down
the ordinary scalar path where a placeholder is what a reader wants.

## Value renderers

A merged field's value is normally a scalar. A feed may instead supply an object
tagged with `$r`, naming a component in the `render-values.js` registry that
draws the whole cell — a forecast day is a sky glyph, a high, a low and a chance
of rain, not one number.

`units.js` is not involved. The three places that turn a value into text — the
card body, the bottom strip, the devices table — test for a rich value first, so
a non-scalar never reaches `displayValue()` and the scalar path keeps its
existing behaviour and its existing tests.

A rich cell keeps `.val` and `data-f`, because `valueDropZones()` selects on
both, so drag reordering costs `grid.js` no changes. It never emits `.fv` and
never calls `trackFit()`, and that is what keeps it out of the font fit:
`fitValues()` only sees nodes `trackFit()` registered. The exclusion is
structural rather than a flag because the failure is silent — the same text
rendered as a scalar takes its whole card from 47px to 11px.
`test/fontfit.spec.js` pins it.

Type inside a rich cell scales by container query against the cell itself, in
two terms: how much of the cell height the slot has, and what the string costs
in cell width at that size. The smaller of the two is the size, so the type
grows until whichever dimension runs out first, the way the dials fill their
cell. The width term needs the string, which only a measurement gives, so the
renderer computes it with `textWidthEm()` and sets `font-size` on the element;
the stylesheet holds the parts that share a row at fractions of it. Nothing
joins the page-wide fit. Fixed pixel ceilings used to cap these, which left a
large card mostly empty. An engine without container queries drops the `min()`
and falls back to inherited body type, which is legible.

`textWidthEm()`'s probe font is a tracked `.fv` node's computed style, not
`.cval .big`'s own — the two elements happen to share the body font today, so
nothing visibly moves, but a rule that touched only `.fv` (letter-spacing, say)
would resize `.cval .big` without touching what it targets. The em it returns
also varies with whatever size the probe node is currently fitted to, not a
fixed reference size. That is harmless for the letter-spacing and
font-feature-settings terms above, which scale with font size the same way the
em does, but would be wrong for anything using the em as a fixed pixel budget.

The sun and moon renderers are composites: they draw their rise and set times
inside the SVG rather than beside it, so the whole thing scales as one unit and
one cell tells the whole story. Type sizes there are chosen so the longest
string each slot can hold still fits the viewBox, because an SVG clips overflow
rather than scaling it away; `test/feeds.spec.js` measures that against the
worst case. A feed can name values a composite already covers in
`defaultHidden`, and `ensureCard()` seeds them into the card's hidden set when
it creates the card. They stay in `valueOrder` and stay reachable from the
devices table.

The clock renderer emits two variants from the same registration: `local_time_12`
draws the time with `hour12: true` and splits the AM/PM marker into the header
beside the zone abbreviation, while `local_time_24` draws the same time with
`hour12: false` and no marker. Both omit the seconds sub-line and keep the
`.cval` container-query sizing.

## Third-party requests

The page still loads with no external request. Once the user sets a location it
reaches three origins at runtime and no others, which `test/build.test.js`
enforces as an allowlist:

| Origin | For | When |
|---|---|---|
| `api.weather.gov` | forecast and current conditions | every 15 minutes |
| `nominatim.openstreetmap.org` | place search | on submit only |
| `tile.openstreetmap.org` | the map picker | while settings are open |

There is no proxy: the browser calls them directly, and all three answer
`Access-Control-Allow-Origin: *`.

NWS documents a required identifying `User-Agent`, which a browser refuses to
send — it is a forbidden header name and `fetch` drops it. Nothing else is sent
either, because a non-safelisted header would force a preflight the API does not
answer. If NWS ever enforces this, a browser-only design has no fix short of a
proxy.

Nominatim caps callers at one request a second and rules out autocomplete, so
searching happens on submit, one request at a time, with every answered query
cached. That cache holds 100 queries and evicts the oldest key when it overflows, so a
long session of searching cannot grow it without bound. Browsers send `Referer`
automatically, which is the identification the policy asks for.

A failed run keeps the last good values on the card and adds the error as a
plain string, so it renders through the scalar path and can be hidden like any
other value. Retries climb 30m, 1h, 2h, 4h and stop at 6h, jittered per feed
(a DJB2 hash of the feed id folded into the jitter) so several feeds failing on
one outage do not come back in lockstep. If the response carries a
`Retry-After` header, `nws.js` reads it into `err.retryAfter`, and `feed.js`'s
catch takes `Math.max(err.retryAfter, jittered)` — the server's own wait wins
when it asks for longer than the ladder would. A point outside the United
States makes NWS return 404, which is terminal: that feed stops rather than
climbing the ladder against a permanent answer. The locally computed feeds
work anywhere.

A feed that fetches declares `cached: true`, and its results go to
`localStorage` under `rtl433.feeds.v2`, so a reload paints the last good data
before anything runs and an entry younger than its interval defers the next
fetch. Moving the location discards the cache, along with the grid mapping and
station id a feed had stored about the old point.

The sun, moon and clock feeds are not cached. They recompute from the system
clock for nothing, so a cache buys no time and only creates a hazard: an entry
outlives the code that wrote it, and it is painted before anything reruns. When
the sun and moon dials became composites and their rich values gained
`riseText`, the entries already on disk lacked it and the moon card drew
"undefined". The key carries a version for the same reason, and a renderer
reads around a missing field rather than printing it.

## Sources

One SSE stream per source, each reconnecting on its own, so one source being down does
not affect another. Connection state shows as a dot in the settings panel and never
becomes a column in the device table. With no sources configured the dashboard reads the
origin it was served from, so the firmware-served build works with no setup.

`stream.js` retries on a backoff ladder rather than a fixed interval:
`Math.min(30000, 1000 * 2 ** attempt) * (0.8 + 0.4 * Math.random())`, with `attempt`
reset to zero in `onopen`. It doubles from a second to a thirty-second ceiling, and the
jitter spreads the retries of several sources that dropped together instead of having
them all reconnect on the same beat. A flat 5 s was both too slow for a momentary blip
and too fast against a source that is off for the afternoon. `onerror` retries only when
the socket it fired on is still the current one and has reached `CLOSED`, so a socket
superseded by `close()` cannot overwrite the attempt count or leak a timer.

## Bridges

The reverse of Sources: `bridges.js` fetches `GET /$mqtt` against
`location.origin` and shows what this receiver currently pushes to, never
`localStorage` — there's nothing to cache, the receiver's own table is the
only copy. Adding or removing a bridge `POST`s to `/$mqtt` or
`/$mqtt/remove` and refetches. If `/$mqtt` isn't served here (the standalone
bridge, or a dashboard opened before the receiver's boot finished), the
panel renders nothing, the same as `LocationView`'s `$tz`/`$location` POSTs
being silently origin-gated today.

## Tests

`test/*.test.js` are node tests over the modules that touch no DOM. `test/*.spec.js` is
Playwright against the built bundle, served by `startServer()`'s own outer HTTP server
(`test/harness.js`). That server also reverse-proxies every other request to a real
`bridge/` running over an in-process aedes broker
(`bridge/test/helpers/dashboard-fixture.js`), so the suite exercises the real HTTP
binding rather than a model of it.

`main.jsx`'s `exposeForTests()` puts page internals on `window` — `store.js`'s
`getCardState`/`setCardState`, `isStorageBroken()` and `window.storageBroken` exist
only to serve it — because `test/cards.spec.js` drives the page through the globals
the pre-Preact version had at script level: 40 of its 89 tests reach for `window.` or
`page.evaluate`. Deliberate and endorsed rather than plain debt, since rewriting those
tests to drive the DOM instead would destroy the evidence that the Preact rewrite lost
nothing. Delete the hook once the suite drives the DOM instead of the globals.

Five of the dashboard's own `POST` paths are intercepted by the harness itself instead of
proxied, because they belong to the receiver's binding rather than the bridge's. MQTT
excludes topic names beginning with `$` from a `#` wildcard subscription, so a bare
`$tz`, `$layout`, `$location`, or `$units` publish never echoes back on the bridge's
subscription and its `POST` answers `503`. The receiver sidesteps that by canonicalizing
to `<source>/$tz` and friends before broadcasting whatever path was posted, so the
harness does the same before handing off. `$alias` with an empty body is the fifth: it
means delete the retained message, and the bridge stores it as the string it is.
`$layout` still goes through the bridge's own auth-gated `POST`, since `auth.spec.js`
drives it against a token-protected bridge and a missing token has to `401` there. All
five match what `receiver/test/binding-server.js` does, so the suite's assertions keep
meaning what they say.

Nothing in the suite reaches the network. Setting a location makes the weather feed
fetch the National Weather Service, and opening the settings tab makes the map fetch
OpenStreetMap tiles, so `harness.js` exports `routeWeather()` and `routeTiles()` and
every spec that does either calls them. `test/pw.js` wraps `@playwright/test` with a
`page` fixture that routes every request through `127.0.0.1`/`localhost` or aborts it,
so a spec that forgets `routeWeather()`/`routeTiles()` now fails instead of passing
against whichever service happens to be up. Playwright matches the most recently
registered route first, so a spec's own route still wins over this default. The two
`browser.newContext()` pages in `multi.spec.js` bypass the `page` fixture, so they call
`guardContext()` directly. Every spec imports `test`/`expect` from `./pw.js`, not
`@playwright/test`.

`playwright.config.js` lists the tracked spec basenames in `testMatch` rather than
globbing `test/*.spec.js`, so a scratch file dropped into `test/` never runs. A new
spec needs a line added there.

`cards.spec.js` selects a card with `[data-key$="..."]`, an unanchored suffix match
that is unambiguous only while a spec runs a single source (a two-source key differs
only in its base URL prefix). A spec that opens a second source must scope through a
per-source root locator instead of adding to the suffix.
