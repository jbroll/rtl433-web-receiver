# Architecture

## Modules

Preact with `@preact/signals`, bundled by `esbuild` into one `<script>`.

| Module | Holds |
|---|---|
| `main.jsx` | wiring: boot order, the SSE sources, the feed scheduler, the test hooks |
| `app.jsx` | the tab shell and the cards toolbar |
| `units.js` | the meta and status field sets, `splitUnit()`, `fmtValue()`, `displayValue()`, `ageText()`, reading extraction |
| `alias.js` | keys, the alias map, name resolution, the alias POST, `isFeed()` |
| `devices.js` | the live device map, capped at `DEVICE_MAX` per source |
| `store.js` | card layout in `localStorage`, and `forgetLayouts()` |
| `settings.js` | units, decimals, and the location, in `localStorage` |
| `sources.js` | the source list and its storage |
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
| `feeds/` | the feed scheduler, its cache, and one module per feed |

`build.js` pins `absWorkingDir` to the dashboard directory. PlatformIO runs it
from `receiver/`, where there is no `node_modules`, and esbuild resolves alias
targets against the working directory.

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
so the rename stays local and survives reloads from `localStorage`.

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

`cards.jsx` and `devices-table.jsx` both render readings through `displayValue`.
`CardsView` reads the settings signal as a dependency, so any settings change
triggers a re-fit: font size is recomputed against the new display values and the
card re-renders with the updated numbers and units.

## Value fit

`fitValues()` in `grid.js` sets the type size of every `.fv`. It measures the
number on a canvas at 100px once, in `textWidthEm()`, and stores the result as a
width in ems against the node; the width the box allows is then `box ÷ em` at
any later size, with no re-measure. The unit is not in that width because it
renders in the `.fn` header, not beside the number.

Every reading on the page takes one size. Each value bounds it twice: by width,
at `box ÷ em`, and by height, at what its box leaves under the field name
divided by the line height. The smallest bound any value produces is the size
they all get, with a floor of 11px. A card of two readings therefore reads at
the same size as a card of five beside it, rather than each card sizing to its
own boxes.

`fitValues()` is the only writer of `.fv` font size. Setting an initial size in
the JSX as well would let a re-render put the unfitted size back, which is what
made a card snap to small type after a grid resize.

A value box on a hidden tab measures zero, so `fitValues()` skips a node it
cannot measure rather than fitting it to the floor. `CardsView` watches the grid
with a `ResizeObserver`, which fires when the tab comes back and the boxes get
their size, and re-fits then.

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
- `ensureCard()` hides every new card. Feeds pass `autoShow`, applied only on
  creation so a later user hide is never undone.

A record with `seenAt` of 0 shows no age. The sun, moon and clock come off the
system clock and are never stale; weather stamps the time its data came from, so
its age corner reads as genuine staleness.

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

Type inside a rich cell scales by container query against the cell itself. An
engine without container queries drops the `clamp()` and falls back to inherited
body type, which is legible.

The sun and moon renderers are composites: they draw their rise and set times
inside the SVG rather than beside it, so the whole thing scales as one unit and
one cell tells the whole story. Type sizes there are chosen so the longest
string each slot can hold still fits the viewBox, because an SVG clips overflow
rather than scaling it away; `test/feeds.spec.js` measures that against the
worst case. A feed can name values a composite already covers in
`defaultHidden`, and `ensureCard()` seeds them into the card's hidden set when
it creates the card. They stay in `valueOrder` and stay reachable from the
devices table.

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
cached. Browsers send `Referer` automatically, which is the identification the
policy asks for.

A failed run keeps the last good values on the card and adds the error as a
plain string, so it renders through the scalar path and can be hidden like any
other value. Retries climb 30m, 1h, 2h, 4h and stop at 6h, jittered so several
feeds failing on one outage do not come back in lockstep. A point outside the
United States makes NWS return 404, which is terminal: that feed stops rather
than climbing the ladder against a permanent answer. The locally computed feeds
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

## Tests

`test/*.test.js` are node tests over the modules that touch no DOM. `test/cards.spec.js`
is Playwright against the built bundle, in front of `receiver/test/binding-server.js` — a
JS model of the binding, which keeps the suite fast and independent of a broker.
