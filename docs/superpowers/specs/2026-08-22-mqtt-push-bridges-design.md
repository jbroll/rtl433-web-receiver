# Multi-bridge MQTT push from the Settings tab

A receiver can already push its own decoded readings to one MQTT broker, but
that broker's URL and token are set once, in the captive-portal provisioning
form, and can't be changed afterward without re-provisioning. Move that
config to the dashboard's Settings tab, on the receiver itself, and let a
receiver push to more than one bridge at a time — the reverse of the
Settings → Sources panel, which lets a dashboard *pull* from several bridges.

## Receiver

### `mqtt_publish_store.h`/`.cpp` (rework)

Single url/token pair becomes a fixed 3-slot table, one JSON blob in one NVS
key — the same shape `alias_store`'s 32-slot table uses, and for the same
reason: NVS keys are capped at 15 characters, so one key per slot doesn't
scale, and rewriting the whole blob on every edit (a rare, user-driven
action) costs nothing worth avoiding.

```
bool        begin();
uint8_t     count();
const char* urlAt(uint8_t i);
const char* tokenAt(uint8_t i);
bool        add(const char* url, const char* token);    // updates in place if url exists
bool        remove(const char* url);
int         indexOf(const char* url);                   // -1 if absent
```

`MQTT_PUBLISH_SLOTS = 3`. `add()` validates the same way `set()` does today
(`mqtt://`/`mqtts://` scheme, length caps) and fails with slots full and no
matching url. The `MQTT_BROKER_URL`/`MQTT_TOKEN` build flags stay as a
separate, always-on 4th connection outside this table — a deploy-time
default (`.env`, `deploy.sh`) keeps working, and dashboard-added bridges are
additive to it, not a replacement.

**Migration:** `begin()` checks for the old single `url`/`token` NVS keys; if
present and the new table is empty, it copies them into slot 0 and removes
the old keys. One-time, silent.

### `mqtt_publish.h`/`.cpp` (rework)

One `PubSubClient` + `WiFiClient`/`WiFiClientSecure` pair per active
connection (up to 4: 3 table slots + the build-flag default) instead of the
current singleton. Each connects/reconnects/backs off independently and runs
its own `replayAll()` on connect. `onRecord()`, `publishLayout()`,
`publishLocation()`, and `publishTz()` fan out to every connected slot
instead of the one `_mqtt` client.

Adds:

```
uint8_t count();                 // active connections, table slots + build-flag default
const char* urlAt(uint8_t i);
bool        connectedAt(uint8_t i);
```

used by the new HTTP endpoint to report status. `begin()` re-reads the store
and rebuilds all connections; called once from `add`/`remove` handling below,
same as it's called once at boot today.

### HTTP endpoint (`web_ui.cpp`)

New bare `/$mqtt` path, registered directly (not routed through the generic
`handleTopic()` topic/filter parser, since `$mqtt` isn't a 3-segment topic).
Same same-origin-or-bare trust gating `$tz`/`$layout`/`$location` already
use.

- `GET /$mqtt` → `[{"url":"mqtts://...","connected":true}, ...]`, one entry
  per active connection (table slots + build-flag default if set). Token is
  never returned.
- `POST /$mqtt` with `{"url":"...","token":"..."}` → `mqtt_publish_store::add()`,
  then `mqtt_publish::begin()` to pick up the change. `204` on success, `400`
  on an invalid url/token or a full table, `403` off-origin.
- `POST /$mqtt/remove` with `{"url":"..."}` → `mqtt_publish_store::remove()`,
  then `mqtt_publish::begin()`. `204` on success (including if the url wasn't
  present), `403` off-origin. The build-flag default connection can't be
  removed this way (it isn't in the table); `remove()` on its url is a no-op.

### Provisioning (`provisioning.cpp`)

Drop the MQTT broker URL/token fields, their validation
(`MQTT_PUBLISH_STORE_URL_MAX`/`MQTT_PUBLISH_STORE_TOKEN_MAX` checks), and the
`mqtt_publish_store::set()` call from the captive-portal form handler. The
form becomes WiFi credentials + OTA token only.

## Bridge

No changes. `<source>/$mqtt` doesn't exist as an MQTT topic — the endpoint is
receiver-local HTTP only, never published or forwarded.

## Dashboard

### `bridges.js`/`bridges.jsx` (new)

Structurally mirrors `sources.js`/`sources.js` but reversed: no
`localStorage`, no client-side list. `loadBridges()` does `GET /$mqtt`
against `location.origin`; `addBridge(url, token)` and `removeBridge(url)`
`POST` to `/$mqtt` and `/$mqtt/remove` the same way, then reload. State is a
signal holding the last-fetched array, refetched after every mutation —
there's no SSE push for this list, it's polled on tab open and after edits.

`BridgesView`: list with a status dot (`connected` from the GET response) and
a remove button per row, an add form (url + optional token). On `/$mqtt`
404ing (dashboard not served by a receiver — e.g. viewed through the
standalone bridge), the panel renders nothing rather than an error, the same
way `LocationView`'s `$tz`/`$location` POSTs are silently origin-gated today.

### `settings.jsx`

Add `<BridgesView />` alongside `<SourcesView />` in `SettingsView`.

## Testing

- `mqtt_publish_store::selfTest()` (`FAKE_SIGNALS`, host-run): extend for
  multi-slot add/update-in-place/remove/full-table rejection/migration from
  the old single-key format.
- `test/host/run.sh`: no topic-shape changes needed (`$mqtt` isn't parsed by
  `topic.cpp`), but add coverage if `web_ui.cpp`'s bare-path dispatch gets a
  host-testable seam for the new route.
- Dashboard: `dashboard/test/bridges.test.js`, following `sources.test.js`'s
  pattern, against a fake `/$mqtt` endpoint.

## Out of scope

- No editing a stored token without re-adding the bridge (POST with an
  existing url updates the token in place, which covers the practical case).
- No UI distinction for the build-flag default connection beyond it showing
  up in the `GET /$mqtt` list like any other; it just can't be removed from
  the dashboard.
- No retry/backoff tuning changes; each connection keeps today's
  `MQTT_RECONNECT_BACKOFF_MS` behavior, just per-connection instead of
  global.
