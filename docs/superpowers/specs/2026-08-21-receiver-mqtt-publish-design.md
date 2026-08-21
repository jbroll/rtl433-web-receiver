# Receiver pushes readings to a bridge over MQTT

The receiver and bridge are two independent implementations of the same HTTP
binding today (`docs/architecture.md`) — the receiver never speaks MQTT. This
closes that gap: a receiver can optionally publish its readings to a remote
bridge's embedded MQTT broker (e.g. `weather.rkroll.com`), so a home-local
dataset becomes visible on a public dashboard without the receiver itself
being internet-reachable. Opt-in, off by default.

## Configuration

Three values, all optional (feature is off until a broker URL is set):

- **Broker URL** — `mqtt://host:port` or `mqtts://host:port`. The scheme
  picks the transport: `mqtt://` uses a plain `WiFiClient`, `mqtts://` wraps
  `PubSubClient` in `WiFiClientSecure` with the ISRG Root X1 cert compiled in
  for real certificate validation (no `setInsecure()` — the token would
  otherwise leak to a spoofed endpoint). Same shape as source URLs elsewhere
  in this project (`dashboard/src/sources.js`'s `normalizeBase()`).
- **Token** — sent as the MQTT CONNECT password when set. Blank is valid: a
  local Mosquitto/Home Assistant broker on the LAN often needs no auth at
  all. `weather.rkroll.com` requires one (`bridge/docs/install.md:39`:
  `AUTH_TOKEN` gates CONNECT when the broker is TLS-embedded).
- **Enabled toggle** — off by default; the broker URL being unset is
  equivalent to off.

New module `mqtt_publish_store` (`receiver/mqtt_publish_store.h/.cpp`),
following `wifi_store`/`ota_token_store`'s existing shape exactly:

```c
namespace mqtt_publish_store {
bool        begin();              // opens its own NVS namespace
bool        hasBroker();
const char* brokerUrl();          // NVS value, else the MQTT_BROKER_URL build flag, else ""
const char* token();              // NVS value, else the MQTT_TOKEN build flag, else ""
bool        set(const char* brokerUrl, const char* token);
void        clear();
}
```

`ota_token_store::token()`'s existing precedence comment — "stored token,
else the build flag, else empty" — is the exact rule to copy for both
`brokerUrl()` and `token()`: NVS overrides `.env` build flags, and portal
input flows through the same `set()`/`clear()` a future reconfiguration or
factory-reset would use.

### `.env` / build-time path

`receiver/.env.example` gains two lines, following the existing
`WIFI_SSID`/`OTA_TOKEN` pattern (`load_env.py` already turns any `.env` line
into a `-D` build flag with no changes needed to that script):

```
MQTT_BROKER_URL="mqtts://weather.rkroll.com:8883"
MQTT_TOKEN="generate-your-own-32-hex-chars"
```

### Provisioning-portal path

`provisioning.cpp`'s existing single `/save` form (SSID + password required,
OTA token optional and non-fatal — `provisioning.cpp:107-184`) gains two more
optional fields, broker URL and token, parsed and stored in `handleSave()`
the same non-fatal way the OTA token field already is (`provisioning.cpp:183-184`:
WiFi is the essential part of the form; a failed secondary field doesn't
block provisioning). Saving ends in `ESP.restart()` as it already does for
every other field on this form — no hot-reload path for broker settings.

## Publishing

**Library:** `PubSubClient`, matching this firmware's existing style of
handling networking inline in the main loop (WiFi reconnect, `MDNS.begin()`)
rather than introducing an async framework. Its default 256-byte buffer is
bumped to fit `SIGNAL_PAYLOAD_MAX` (600, from `signal_store.h`) plus topic
length.

**Trigger:** a second `RecordHook` (`signal_store::setRecordHook` already
supports only one hook today — see Open Questions) fires per new record and
publishes the same JSON `signal_store` already builds, unmodified, to:

```
<mdnsHostname()>/<model>/<id>
```

matching the existing binding's `<source>/<model>/<id>` topic shape
(`bridge/src/topic.js`, `receiver/topic.cpp`) — `mdnsHostname()` (already
computed in `WebReceiver.ino:118-126`) disambiguates receivers sharing a
broker, whether that's the public bridge or a home-automation broker with
other publishers on it.

Every publish sets the MQTT **retain** flag, matching the binding's existing
contract that `GET <topic>` returns "the last message published to that
topic" (`bridge/docs/user-manual.md`) — a subscriber connecting to the
public bridge later expects the same replay-on-connect semantics the local
HTTP/SSE surface already gives.

**Replay on connect:** on every successful MQTT connect (first boot with the
feature enabled, or any reconnect after a drop), walk `signal_store`'s
existing iteration API — `deviceCount()`, `slotAt(i)`, `latestPayload(slot)`
(`signal_store.h:44-46,55`) — and republish every currently-held record. This
backfills the remote broker's state immediately rather than waiting for each
device's next natural transmission, which matters for sensors that only
report once an hour or so.

**Reliability:** `PubSubClient::loop()` runs every main-loop iteration,
alongside the existing WiFi/mDNS handling. Reconnect attempts are backed off
with a new build-flag constant, matching the `RECOVERY_BACKOFF_MS` convention
already in `receiver/platformio.ini`. Publishing is fire-and-forget: if the
client isn't connected when a record fires, that one publish is skipped —
no per-message retry queue. The replay-on-reconnect step above already
backfills anything missed, and a live sensor reports again soon regardless.

## Out of scope

- The bridge or dashboard changing in any way — this is a receiver-only
  feature. The bridge's existing embedded MQTT broker and `AUTH_TOKEN`
  mechanism are consumed as-is.
- Any UI for configuring this outside the SoftAP provisioning portal and
  `.env` (no dashboard-side control of a receiver's own MQTT publish
  settings).
- MQTT QoS above the default (`PubSubClient` defaults to QoS 0 for publish);
  no acknowledgment or delivery guarantee beyond "retained, so eventually
  consistent via replay-on-reconnect."
- Publishing anything other than device records — no health/telemetry
  topics, no LWT (last-will), in this pass.

## Open questions for the implementation plan

- `signal_store::setRecordHook` currently supports exactly one hook
  (`RecordHook hook`, a single function pointer — `signal_store.h:41`,
  `signal_store.cpp:58`), and `WebReceiver.ino:520` already wires it to
  `device_hooks::dispatch`. Adding MQTT publish as a *second* hook needs
  either: (a) widening `signal_store` to support multiple registered hooks,
  or (b) having `device_hooks::dispatch` itself call into the new MQTT
  publish module after its existing per-model dispatch. (b) is less
  invasive (no `signal_store` API change) but couples an unrelated module's
  dispatch function to networking; (a) is cleaner separation but touches a
  well-tested core module. Pick one when writing the implementation plan.
