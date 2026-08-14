# One repo, three sub-projects, and the dashboard lifted out of the firmware

The roadmap in `docs/backlog.md` names three projects: the HTTP binding, the
bridge, and the dashboard. The first two are done and live in two GitHub
repos. This design puts them in one repo as sibling directories and builds the
third.

## Why one repo

The three parts are one program. The receiver's `topic.cpp` is a deliberate
mirror of the bridge's `src/topic.js`, and the two can only be kept honest by
being read together. The dashboard is a build of the page the firmware serves
today, so a change to what the page expects and a change to what the firmware
serves belong in the same commit. Two repos cannot hold that commit.

## Repo shape

`rtl433-web-receiver` stays the repo and keeps its remote. The firmware moves
into `receiver/`. `mqtt-http-bridge` is merged in under `bridge/` with
`git merge --allow-unrelated-histories`, so its history stays in the combined
log. `jbroll/mqtt-http-bridge` is archived on GitHub afterward, by hand.

    README.md              indexes the three sub-projects
    docs/architecture.md   how source, bridge, and dashboard fit
    docs/backlog.md        the roadmap and anything spanning sub-projects
    receiver/  WebReceiver.ino, *.cpp, *.h, platformio.ini, test/, README.md, docs/
    bridge/    bin/, src/, test/, package.json, README.md, docs/
    dashboard/ src/, test/, build.js, package.json, README.md, docs/

`binding.md` stays in `bridge/docs/`, beside the code that implements it.

`install.md` and `development.md` stay per sub-project rather than at the
root: a PlatformIO build with a serial port and two node packages have nothing
to share. Each sub-project keeps its own `backlog.md`; the roadmap and the
duplicated-`topic` question move to the root one.

Nothing about the receiver's or the bridge's behavior changes in the move.

## The dashboard

Plain ES modules, no framework. `esbuild` is the one dependency: it bundles
the modules and the CSS and inlines both into a single self-contained
`index.html`. That output is what a browser loads and what the firmware
embeds, so there is one artifact and one thing to test.

`cards_html.h` and `index_html.h` are split along the seams they already have,
carried over rather than rewritten:

- `grid.js` — `measureGrid()`, cell arithmetic, the resize and drag gestures
- `card.js` — one card's DOM, `fitValues()`, value modes, rename
- `table.js` — the device table
- `stream.js` — one source's SSE connection, its filters, and its reconnect
- `alias.js` — resolving a display name from the three layers
- `store.js` — layout and settings in localStorage, and `forgetLayouts()`
- `sources.js` — the source list and the settings panel
- `main.js` — wiring

### Sources

The dashboard reads a list of base URLs. With none configured it uses the
origin it was served from, so the firmware-served build works with no setup at
all. A settings panel adds and removes URLs and stores the list in
localStorage beside the layout state.

One SSE stream per source. A device is keyed by source base URL plus topic, so
two bridges publishing the same topic stay two devices. Each stream reconnects
on its own; one source being down does not affect another. Per-source
connection state shows as a dot in the settings panel. It does not become a
column in the device table.

A card's stored layout is keyed by the same source-plus-topic key, so moving a
device between bridges gives it a new card rather than inheriting one.

Alias layering is unchanged: the browser's own config wins, then the source's
`$alias` topic, then the stable topic segment.

## Embedding in the firmware

A PlatformIO `extra_script` pre-build hook runs `node dashboard/build.js`,
which writes a gzipped PROGMEM byte array to a gitignored directory on the
include path. `web_ui.cpp` serves those bytes with `Content-Encoding: gzip`
through the existing chunked-write budget. `index_html.h` and `cards_html.h`
are deleted in that commit.

The generator also emits `DEVICE_MAX` from `SIGNAL_DEVICE_SLOTS`, which closes
the duplicated-constant gap in the backlog: the page can no longer disagree
with the firmware about how many device slots there are.

Node becomes a requirement for `pio run`. It was already required to run the
tests.

Expected sizes: the two literals are 37,352 bytes today against a build at
90.3% of flash. Gzip on this page should land near a third of that. The
figure is measured as a linked-size difference and recorded in
`receiver/docs/architecture.md`, not assumed.

## Tests

`test/cards.spec.js` and `test/harness.js` move to `dashboard/test/` and run
Playwright against the built bundle. The harness stays a fake bridge written
in JS, which keeps the suite fast and independent of a broker. Replacing it
with the real `bridge/` against an in-process `aedes` is filed in the
dashboard's backlog, not done here.

`test/binding.spec.js` stays with the receiver as `receiver/test/`, since it
tests the firmware's own HTTP surface. `receiver/test/host/` and
`bridge/test/` are untouched.

The extraction is verifiable because the moved suite passes today: a bundle
that fails it has lost something the PROGMEM page did.

## Sequencing

Four landings, each green on its own.

1. **Restructure.** Move the firmware into `receiver/`, merge the bridge into
   `bridge/`, write the root README and architecture, split the backlogs. No
   code changes. `pio run`, `pio test`, `npm test` in `bridge/`, and the
   Playwright suite all pass unchanged but for paths.
2. **Extract.** `dashboard/` builds a bundle that passes the moved suite,
   served as a static file. The firmware still serves its own PROGMEM page, so
   nothing on the device changes yet.
3. **Multi-source.** The source list, the settings panel, per-source streams,
   and source-keyed devices and layouts. New tests for two sources, for one
   source down, and for the same topic on two sources.
4. **Embed.** The pre-build hook, gzip serving, deleting the two headers, and
   the measured flash figure.

## Out of scope

- Authentication between the dashboard and a bridge. The bridge has none, and
  a dashboard reaching a bridge over anything but localhost inherits that. It
  stays in the bridge's backlog.
- Merging duplicate devices seen through two bridges into one card.
- Any change to the bridge's or the receiver's protocol behavior.
- Rewriting the page's DOM code. This is a port.
