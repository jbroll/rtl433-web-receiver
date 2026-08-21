# Site-default dashboard layout (`$layout`)

## Why

Dashboard layout — grid size, card arrangement, which values show and where —
lives only in `localStorage`, per browser (`dashboard/docs/user-manual.md`).
Every new user who sets up their own receiver starts from a blank grid and
has to arrange it by hand, even though the receiver already knows every
device it has decoded.

## Scope

This round: a receiver-writable, model-keyed layout template, propagated
read-only to a cloud bridge over MQTT. Two things are explicitly deferred:

- **Writing to a cloud bridge from the dashboard.** `AUTH_TOKEN`-gated POST
  needs the dashboard to hold a bearer token per source, which it has no UI
  for today (`bridge/docs/backlog.md` already flags this same gap for
  `$alias`). Cloud writes wait for that; this round ships receiver-only
  writes, with cloud *reads* working via MQTT propagation (see below).
- **Per-device (non-model) precision.** Two devices sharing a model get the
  same card settings from a template; there is no way to disambiguate them
  further this round.

## Data shape

A new root-level (not per-device) topic, `<source>/$layout`, following the
exact convention `$alias` and `$tz` already use: single JSON blob, GET/POST,
no receiver-side auth — same trust boundary as `$alias` today (LAN access is
already unauthenticated for renaming/relocating devices; a site-default
layout write is the same boundary, not a new one).

Keyed by **model**, not device key, so it survives moving to hardware with
different device IDs:

```json
{
  "grid": { "cols": 6, "rows": 4 },
  "order": ["Acurite-5n1", "BMP280", "Receiver"],
  "models": {
    "Acurite-5n1": { "w": 2, "h": 2, "valueOrder": [...], "hiddenValues": [...], "bottomValues": [...] },
    "BMP280": { "w": 1, "h": 1, "valueOrder": [...], "hiddenValues": [...], "bottomValues": [...] },
    "Receiver": { "w": 1, "h": 1, "valueOrder": [...], "hiddenValues": [...], "bottomValues": [...] }
  }
}
```

Excluded on purpose: aliases (personal names), units/decimals/location
(personal preferences, not layout), feeds (app-generated cards, no `model`).

## Receiver firmware

- `layout_store.h/.cpp` — one NVS blob, mirroring `alias_store`'s pattern.
  `LAYOUT_STORE_MAX` 2048 bytes, matching `ALIAS_BLOB_MAX`'s precedent (see
  NVS sanity check below).
- `topic.cpp` — `isLayout()`, shaped like `isTz()`: accepts both bare
  `$layout` and `<source>/$layout`.
- `web_ui.cpp` — `handleLayoutPost`/GET mirror `handleTzPost`/the alias GET
  path: same-origin-or-bare gating, `204`/`400`/`404`, SSE broadcast via a
  new `web_ui::broadcastLayout()`. `drainReplay()`'s cursor (currently: sub
  table, then the alias table) gets a final step for `$layout` — one extra
  frame, not a table — so a brand-new `/events` connection is replayed the
  stored layout on connect, the same way it already is for aliases. This is
  what makes "load the default when nothing local exists" actually work for
  a genuinely new browser: auto-apply fires from the SSE replay itself, not
  only from a live push after some other client's `POST`.
- `mqtt_publish.cpp` — publishes the stored `$layout` (retained) to
  `<mdnsHostname()>/$layout` right after a successful POST, and replays it
  alongside device records on every (re)connect (extending `replayAll()`,
  not `signal_store`'s per-record hook mechanism — `$layout` isn't a decoded
  radio record). A dashboard reading via a cloud bridge gets the site
  default read-only, with zero bridge code changes: it's just another
  topic, already covered by the generic HTTP binding.

### NVS sanity check

`receiver/docs/architecture.md`'s NVS budget: 20 KB total `nvs` partition,
which can't easily grow (same hardcoded-offset constraint as `app0`).
Current worst-case usage: `phy/cal_data` ~1,950 B, `nvs.net80211` a few
hundred B, `wifi_store` <100 B, `alias_store` capped at 2,048 B,
`mqtt_publish_store`/`ota_token_store`/`tz_store`/boot counters a few
hundred B combined — roughly 4.5–5 KB against 20 KB, the "about three times"
headroom the doc already documents.

Adding `layout_store` at the same 2,048-byte cap pushes worst-case to
~6.5–7 KB — headroom drops to ~2.3x, still comfortably safe. NVS blob
overhead at this size is minimal (roughly 32-byte-aligned chunks, so a 2 KB
blob costs close to 2 KB). A realistic `$layout` (a handful of models) will
likely land well under 1 KB in practice, the same way most real alias
tables don't approach `ALIAS_BLOB_MAX` either.

## Dashboard

New module `dashboard/src/layout_template.js`, mirroring `alias.js`'s shape:

- `deriveTemplate()` — reads `cardState.value` plus each card's `model`
  (via `devices`, the same accessor `devicesort.js`'s `deviceName` uses),
  skips feed cards (`isFeed`), groups into the `{grid, order, models}` shape
  above.
- `applyTemplate(template)` — validates defensively like `loadCardState`
  (clamp grid via the existing `gridNum`, filter arrays to strings). For
  each currently known non-feed device, looks up its model and applies that
  model's card settings; rebuilds `order` as matched-model devices in the
  template's model order, then unmatched devices appended in their current
  relative order. Ends through the same persist path `saveCardState()` uses.
- `applyLayoutFrame(key, payload)` — the SSE handler, mirrors
  `applyAliasFrame`, but never touches `cardState` directly — it only
  records the template into a new `layouts` signal (`Map<source,
  template>`). Auto-applying on every incoming frame would silently
  clobber a customized dashboard whenever another tab saves a layout.

Connection points:

- `stream.js` — `LAYOUT_SUFFIX = '/$layout'` and an `onLayout` handler,
  wired the same way `$alias` frames already are.
- `main.jsx` — once, on the *first* `$layout` frame received for a
  same-origin source, if `cardState.value.order.length === 0` (a true first
  load, nothing local yet), auto-apply it. A one-shot flag prevents
  re-triggering, so a later "Forget layouts" isn't silently undone by the
  still-open SSE stream replaying its retained frame.

Settings panel, next to "Forget layouts":

- **Save as default layout** — visible only when `location.origin` is one
  of the connected sources, the same rule `postAlias` already uses for
  writes. POSTs `deriveTemplate()` to `${location.origin}/$layout`. No
  confirmation, matching alias's no-confirm precedent.
- **Load default layout** — visible when `layouts.value` has an entry for
  the current origin. Confirmation prompt first (destructive to the current
  arrangement, like Forget layouts), then `applyTemplate()` + persist.

## Bridge

No code change. `POST`/`GET` to `<source>/$layout` already works as an
ordinary topic through the generic HTTP binding, gated by `AUTH_TOKEN` when
one is configured — the same as every other topic. Documented as a
convention in `bridge/docs/user-manual.md`, not implemented there.

## Testing

- `receiver/test/host`: `layout_store` unit tests (mirroring
  `alias_store`'s), `topic.cpp`'s `isLayout()` added to the shared
  `test/topic_cases.txt` table (also consumed by `bridge/src/topic.js`'s
  suite, though `$layout` there needs no special handling — it is just
  another topic).
- `dashboard/test`: `layout_template.js` unit tests for `deriveTemplate`/
  `applyTemplate` (model matching, order rebuilding, malformed-input
  rejection), plus a harness-level test for the SSE `$layout` frame →
  auto-apply-when-blank path and the Settings buttons' same-origin gating.

## Out of scope

- Dashboard token-config UI for writing `$layout` (or `$alias`) to an
  `AUTH_TOKEN`-protected cloud bridge — tracked as a followup.
- Per-device disambiguation within a shared model.
- Propagating `$alias` over MQTT — a related, pre-existing gap
  (`bridge/docs/backlog.md`), not touched by this work.
- Units, decimals, location, sort order, and feed cards in the template.
