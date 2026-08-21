# Feed location/timezone propagation

Feed cards (Weather/Sun/Moon/Clock) work when the dashboard is loaded from a
receiver's own IP, because `settings.value.location` lives in that origin's
`localStorage`. Load the same dashboard from the bridge — a different
origin — and `localStorage` is empty, `hasLocation()` is false, and every
feed card is missing. `$tz` has the same origin problem: it's receiver-local
and write-only today, so a bridge-loaded dashboard can't pick it up either.

Fix: give both `$location` and `$tz` a full round trip (NVS store → MQTT
publish → GET → SSE broadcast → dashboard subscribe), matching the pattern
`$layout` already uses. A dashboard with no local location/zone falls back to
whichever configured source publishes one.

## Receiver

### `location_store.cpp`/`.h` (new)

Mirrors `tz_store`/`layout_store`: NVS namespace `"location"`, storing
`{ lat, lon, label, zone }` as one JSON blob (same shape as
`settings.value.location` on the dashboard side). `set()` writes NVS and
triggers publish/broadcast (see below). `begin()` loads at boot.

### `tz_store` (existing, extended)

Storage unchanged. Add the same publish/broadcast triggering `set()` gets
below.

### Topic dispatch (`topic.cpp`, `web_ui.cpp`)

- `topic::isLocation()` — same shape as `isLayout`/`isAlias`/`isTz`: last
  `/`-segment equals `$location`.
- `handleTopic()`:
  - `$location`: add POST (accepts bare `$location` or `<source>/$location`,
    same origin-trust check `handleLayoutPost`/`handleTzPost` already use)
    and GET (currently missing for `$tz`, doesn't yet exist for `$location`).
  - `$tz`: add the missing GET branch. POST handling is unchanged.

### Publish (`mqtt_publish.cpp`)

- `publishLocation()` and `publishTz()`, each publishing retained
  `<source>/$location` / `<source>/$tz`. Called from the same two places
  `publishLayout()` is: immediately after a local `set()`, and from
  `replayAll()` on reconnect.

### SSE (`web_ui.cpp`)

- `broadcastLocation()` / `broadcastTz()`, mirroring `broadcastLayout()`,
  fired after a local `set()` so any dashboard with an open `/events`
  connection to this receiver gets the update live, not just on next
  connect.

## Bridge

No code changes. `<source>/$location` and `<source>/$tz` are opaque topics
to the bridge's `#`-wildcard broker subscription and generic SSE replay
cache, exactly like `<source>/$layout` today.

## Dashboard

### Read path (`stream.js`, `main.jsx`)

- `stream.js`: add `LOCATION_SUFFIX = '/$location'` and start dispatching
  `$tz` frames (`TZ_SUFFIX = '/$tz'`) — today `$tz` frames aren't dispatched
  at all, since the receiver never emitted them over SSE.
- `main.jsx`: `onLocation(base, topic, payload)` and `onTz(base, topic,
  payload)` handlers, same shape as `onAlias`/`onLayout`. Each records the
  value in a `Map<sourceBase, value>`, same structure `layouts` already uses.

### Fallback resolution (`settings.js`)

- `hasLocation()` and the zone lookup fall back, in order:
  1. `localStorage` (`settings.value.location` / explicit zone) — unchanged,
     always wins once set.
  2. The first configured source (in `sources.value` order) that has
     published a `$location` / `$tz` value — same "first source wins"
     convention `layoutForSources()` already established for `$layout`.
- This fallback is resolution-only. It never writes the network value into
  `localStorage`; if the user later sets a location locally, that
  immediately takes over.

### Write path (`settings.js`)

- `setLocation()` already POSTs `/$tz` (bare, own-origin) when the user sets
  location from a receiver-hosted dashboard. Extend it to also POST
  `/$location` in the same call. Gated the same way the `$layout` Save
  button is: only when `location.origin` is itself a configured source.

## Out of scope

- No UI for viewing/editing which source "owns" the published location —
  the first-source-wins resolution is silent, matching `$layout`'s existing
  behavior.
- No per-feed enable/disable toggle. All four feeds keep registering
  unconditionally (`main.jsx`); this change only fixes location/tz
  reachability across origins.
- No change to `$layout` itself — feed cards remain excluded from
  `deriveTemplate()`.
