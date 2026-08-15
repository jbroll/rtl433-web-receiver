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
heap allocation on an ESP32, the other is node. `receiver/test/host/run.sh` and
`bridge/test/topic.test.js` cover the same rules from both sides. Changing a rule means
changing both files and both suites in one commit.

## The dashboard's two lives

`dashboard/build.js` emits one self-contained `index.html`: markup, styles, and script
inlined, no external requests. That file is what a browser loads from a static server and
what the firmware serves. There is one artifact, so there is one thing to test.

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

## Cross-origin

A dashboard served from one origin and reading a bridge on another is a cross-origin
request, so both the bridge and the receiver answer every request with
`Access-Control-Allow-Origin: *`. Neither has authentication, so this exposes nothing a
direct request did not already expose. It does mean a page on any site the user visits
can read a reachable bridge; see the bridge's backlog.
