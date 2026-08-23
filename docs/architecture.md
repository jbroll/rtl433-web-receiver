# Architecture

Each sub-project has its own `docs/architecture.md` for its internals. This one covers
the seams between them.

## One protocol, three implementations of parts of it

[`bridge/docs/binding.md`](../bridge/docs/binding.md) is the contract. The bridge
implements all of it against a broker. The receiver implements the source-only subset:
it answers for topics under its own source and nothing else. The dashboard is a client of
both and implements none of it.

## Why one repo

The receiver's `topic.cpp` and the bridge's `src/topic.js` are the same rules written
twice, in two languages, and they are only kept honest by being read together. The
dashboard is a build of the page the firmware serves, so a change to what the page
expects and a change to what the firmware serves are one commit. Two repos could not hold
that commit.

## The duplicated topic rules

`receiver/topic.cpp` and `bridge/src/topic.js` implement `validTopic`, `validFilter`, and
`matchFilter` independently. Neither can share code with the other: one is C++ with no
heap allocation on an ESP32, the other is node. Both suites run the same case table,
`test/topic_cases.txt`, so a rule change that lands on one side only fails the other
suite. Empty segments are malformed: `GET /a//c` is `400` on both.

## The dashboard's two lives

`dashboard/build.js` emits one self-contained `index.html`: markup, styles, and script
inlined, nothing fetched to load the page. That file is what a browser loads from a static
server and what the firmware serves. There is one artifact, so there is one thing to test.

Loading it costs no external request. Running it can: once the user sets a location, the
information feed cards reach `api.weather.gov`, `nominatim.openstreetmap.org` and
`tile.openstreetmap.org` directly from the browser, with no proxy. `dashboard/test/build.test.js`
holds that as an allowlist, so a fourth origin fails the build. On a LAN with no route out,
those cards show an error and the locally computed ones keep working.

The firmware embeds it through a PlatformIO pre-build hook that runs the same build and
writes a gzipped PROGMEM byte array to a generated header on the include path. `node` is
therefore a requirement for `pio run`.

The generator also emits `DEVICE_MAX` from `SIGNAL_DEVICE_SLOTS` in
`receiver/signal_store.h`, so the page cannot disagree with the firmware about how many
device slots exist.

## Keys across sources

The dashboard reads several sources at once, so a device is keyed by its source's base
URL plus its topic, separated by a space — a character no valid topic can contain. Two
sources publishing the same topic stay two devices with two cards. A card's stored layout
uses the same key, so moving a device between bridges gives it a new card rather than
inheriting one.

## The saved default layout is keyed by slot, not by source+topic

`$layout` (`dashboard/src/layout_template.js`) is a second, separate notion of layout from
the per-browser `cardState` above. Each slot is `model/id`, using the same id/channel/0
tie-break `signal_store::buildKey` uses to key a topic — applied uniformly, so even the
Receiver's own pseudo-device (always id 0) gets the slot `Receiver/0`. This is what lets two
sensors sharing a model (two `Acurite-5n1` units) keep independent saved layouts instead of
colliding on one shared `Acurite-5n1` slot.

Feed cards take a slot too, their own topic — `feed/Weather` and its three siblings, which
no `model/id` slot collides with. A feed is computed from the location and time zone the
receiver stores, so every browser reading that receiver derives the same four cards, and
they belong in the site default like any radio device.

A card the template does not name — a device that has gone quiet since the layout was
saved, or one saved by an older dashboard — keeps the position it already holds, and the
template's own order is dealt back into the positions the rest left. Appending unnamed
cards after the matched ones instead, which is what `applyTemplate()` used to do, moved
every feed card to the end of the grid on each Load, so loading a layout saved a moment
earlier rearranged the page.

`deriveTemplate()` writes a spec per slot and omits what `applyTemplate()` already reads as
the default: an empty `hiddenValues` or `bottomValues`, and `hidden` on a shown card. That
is about 50 bytes a card against the receiver's `LAYOUT_STORE_MAX`.

## From dashboard build to mobile app

`dashboard/build.js` emits one self-contained `index.html`. The `app/` sub-project is a
Capacitor 8 shell whose `capacitor.config.ts` points `webDir` at `../dashboard/dist`. The
build order is therefore dashboard first, then `npx cap sync <platform>`, then the
platform build.

The generated `android/` and `ios/` trees are committed so a build host needs only `npm ci`
and `cap sync`. Build output, local SDK configuration, and the synced web assets under
`android/app/src/main/assets/public/` are gitignored and regenerated on every sync.

## Cross-origin

A dashboard served from one origin and reading a bridge on another is a cross-origin
request, so both the bridge and the receiver answer every request with
`Access-Control-Allow-Origin: *`. The dashboard is also on the other side of that
arrangement for its information feeds: weather.gov, Nominatim and the OSM tile server each
answer `Access-Control-Allow-Origin: *`, which is what lets the page call them without a
proxy. Neither has authentication, so this exposes nothing a
direct request did not already expose. It does mean a page on any site the user visits
can read a reachable bridge; see the bridge's backlog.
