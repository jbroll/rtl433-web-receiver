# Architecture

## Modules

Plain ES modules, no framework, bundled by `esbuild` into one `<script>`.

| Module | Holds |
|---|---|
| `render.js` | the render callback `main.js` installs, so no module has to import `main.js` back |
| `units.js` | `el()`, the meta and status field sets, `splitUnit()`, `fmtValue()`, `ageText()`, and reading extraction |
| `alias.js` | keys, the alias map, name resolution, and the alias POST |
| `devices.js` | the live device map, capped at `DEVICE_MAX` per source |
| `store.js` | layout and settings in `localStorage`, and `forgetLayouts()` |
| `sources.js` | the source list, its storage, and the settings panel |
| `stream.js` | one source's SSE connection and its reconnect |
| `grid.js` | cell arithmetic, the resize and drag gestures, and value fitting |
| `card.js` | one card's DOM, its value modes, and rename |
| `devicesort.js` | the device table's sort column, its direction, and its storage |
| `table.js` | the device table and the log |
| `main.js` | wiring: the render tick, the tabs, the grid inputs, edit mode |

`render.js` exists because `store.js` has to ask for a redraw and `main.js` has to import
`store.js`. A callback holder breaks the cycle without an event bus.

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

## Sources

One SSE stream per source, each reconnecting on its own, so one source being down does
not affect another. Connection state shows as a dot in the settings panel and never
becomes a column in the device table. With no sources configured the dashboard reads the
origin it was served from, so the firmware-served build works with no setup.

## Tests

`test/*.test.js` are node tests over the modules that touch no DOM. `test/cards.spec.js`
is Playwright against the built bundle, in front of `receiver/test/binding-server.js` — a
JS model of the binding, which keeps the suite fast and independent of a broker.
