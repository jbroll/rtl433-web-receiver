# Receiver MQTT Publish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the receiver optionally publish every recorded reading to a remote MQTT broker (e.g. `weather.rkroll.com`'s embedded bridge broker), retained, so a home-local dataset becomes visible on a public dashboard without the receiver itself being internet-reachable.

**Architecture:** A new config store (`mqtt_publish_store`) holds broker URL + token, same NVS-backed shape as `wifi_store`/`ota_token_store`. A new networking module (`mqtt_publish`) owns a `PubSubClient`, connects/reconnects with backoff, and publishes retained messages. `signal_store`'s single record-hook slot is widened to two, so `mqtt_publish::onRecord` runs alongside the existing `device_hooks::dispatch` without coupling the two together.

**Tech Stack:** Arduino/ESP32 (PlatformIO), `PubSubClient` (new dependency), `WiFiClientSecure` (already in the `arduino-esp32` framework), `ArduinoJson`.

## Global Constraints

- Feature is opt-in and off by default: an unset broker URL is equivalent to off (spec "Configuration").
- `mqtts://` uses `WiFiClientSecure` with the ISRG Root X1 root CA compiled in for real certificate validation — never `setInsecure()` (spec "Configuration").
- The token is sent as the MQTT CONNECT password; blank is valid (spec "Configuration").
- `mqtt_publish_store` follows `wifi_store`/`ota_token_store`'s exact shape: fixed buffers, its own NVS namespace, "stored value, else the build flag, else empty" precedence (spec "Configuration").
- Publish topic is `<mdnsHostname()>/<model>/<id>` — identical to `signal_store`'s own key, since `signal_store::setSource(mdnsHostname())` is already called everywhere WiFi comes up (spec "Publishing").
- Every publish sets the MQTT retain flag (spec "Publishing").
- On every successful connect (first connect or any reconnect), replay every currently-held record via `signal_store::slotAt()`/`latestPayload()` (spec "Replay on connect").
- `PubSubClient::loop()` runs every main-loop iteration; reconnects are backed off by a new build-flag constant, matching the `RECOVERY_BACKOFF_MS` convention already in `platformio.ini` (spec "Reliability").
- Publishing is fire-and-forget: a publish while disconnected is simply skipped, no retry queue (spec "Reliability").
- `PubSubClient`'s default 256-byte buffer must be bumped to fit `SIGNAL_PAYLOAD_MAX` (600) plus topic length (spec "Publishing").
- Out of scope: any bridge/dashboard change, any UI outside the SoftAP portal and `.env`, QoS above 0, LWT/health topics (spec "Out of scope").
- Decision on the spec's open question: widen `signal_store` to support multiple record hooks (option (a)) rather than coupling `device_hooks::dispatch` to networking (option (b)) — keeps `device_hooks` a pure JSON-transform module with no MQTT dependency, and matches the spec's own "a second RecordHook fires per new record" phrasing.

---

## Task 1: Widen `signal_store`'s record-hook API to support two hooks

**Files:**
- Modify: `receiver/signal_store.h`
- Modify: `receiver/signal_store.cpp`
- Modify: `receiver/test/host/signal_store_test.cpp`
- Modify: `receiver/WebReceiver.ino:520`

**Model:** `sonnet` — touches a core, heavily self-tested module; needs care not to disturb existing hook-ordering behavior.

**Interfaces:**
- Produces: `signal_store::addRecordHook(RecordHook hook)`, replacing `setRecordHook`. Up to `SIGNAL_MAX_HOOKS` (2) hooks, called in registration order from `record()`, in the same place the single hook used to run (after `time`/`rssi`/`count` are stamped, before the size check and serialization).

- [ ] **Step 1: Write the failing host test**

Open `receiver/test/host/signal_store_test.cpp` and find the end of `selfTest()`, right before `Log.notice(F("selfTest overall: %s" CR), ok ? "PASS" : "FAIL");`. Add:

```cpp
  reset();
  static int hookACalls = 0;
  static int hookBCalls = 0;
  addRecordHook([](const char*, JsonDocument&) { hookACalls++; });
  addRecordHook([](const char*, JsonDocument&) { hookBCalls++; });
  record("{\"model\":\"Hooked\",\"id\":1}", -70);  // first sighting: pending, no hook fires
  ok &= check("a pending sighting does not fire hooks",
              hookACalls == 0 && hookBCalls == 0);
  record("{\"model\":\"Hooked\",\"id\":1}", -70);  // promotes: both hooks fire once
  ok &= check("both registered hooks fire on a promoted record",
              hookACalls == 1 && hookBCalls == 1);
  record("{\"model\":\"Hooked\",\"id\":1}", -70);  // a repeat fires both again
  ok &= check("hooks fire again on a repeat record",
              hookACalls == 2 && hookBCalls == 2);
```

This is the last scenario in the file — registering hooks here doesn't disturb any earlier check, since nothing before this point calls `addRecordHook`.

- [ ] **Step 2: Run it to confirm it fails to compile**

Run: `receiver/test/host/run.sh`
Expected: FAIL — `addRecordHook` is not declared (compile error), since only `setRecordHook` exists yet.

- [ ] **Step 3: Widen the header**

In `receiver/signal_store.h`, replace:

```cpp
typedef void (*RecordHook)(const char* key, JsonDocument& doc);
void        setRecordHook(RecordHook hook);
```

with:

```cpp
#define SIGNAL_MAX_HOOKS 2
typedef void (*RecordHook)(const char* key, JsonDocument& doc);
// Registers a hook to run in signal_store::record(), in registration order,
// after time/rssi/count are stamped and before the size check. Silently
// ignored once SIGNAL_MAX_HOOKS are already registered.
void        addRecordHook(RecordHook hook);
```

- [ ] **Step 4: Update the implementation**

In `receiver/signal_store.cpp`, replace:

```cpp
static RecordHook _hook = nullptr;
```

with:

```cpp
static RecordHook _hooks[SIGNAL_MAX_HOOKS];
static uint8_t    _hookCount = 0;
```

Replace:

```cpp
void setRecordHook(RecordHook hook) { _hook = hook; }
```

with:

```cpp
void addRecordHook(RecordHook hook) {
  if (_hookCount < SIGNAL_MAX_HOOKS) {
    _hooks[_hookCount++] = hook;
  }
}
```

Replace, inside `record()`:

```cpp
  if (_hook != nullptr) {
    _hook(key, doc);
  }
```

with:

```cpp
  for (uint8_t h = 0; h < _hookCount; h++) {
    _hooks[h](key, doc);
  }
```

Hooks are wiring, not per-run state, so `reset()` must keep not touching `_hooks`/`_hookCount` — leave `reset()` unchanged.

- [ ] **Step 5: Update the call site**

In `receiver/WebReceiver.ino:520`, replace:

```cpp
  signal_store::setRecordHook(device_hooks::dispatch);
```

with:

```cpp
  signal_store::addRecordHook(device_hooks::dispatch);
```

(Task 5 below adds the second `addRecordHook` call for MQTT publish once that module exists — don't add it yet.)

- [ ] **Step 6: Run the host test to confirm it passes**

Run: `receiver/test/host/run.sh`
Expected: all `signal_store_test` checks PASS, including the three new ones.

- [ ] **Step 7: Commit**

```bash
git add receiver/signal_store.h receiver/signal_store.cpp receiver/test/host/signal_store_test.cpp receiver/WebReceiver.ino
git commit -m "feat(receiver): widen signal_store to support two record hooks"
```

---

## Task 2: `mqtt_publish_store` — broker URL + token config store

**Files:**
- Create: `receiver/mqtt_publish_store.h`
- Create: `receiver/mqtt_publish_store.cpp`
- Modify: `receiver/WebReceiver.ino` (`begin()` call and `FAKE_SIGNALS` selfTest wiring only — no networking wiring yet)

**Model:** `sonnet` — new module, but the shape is a direct mirror of `wifi_store`/`ota_token_store` and the code below is complete.

**Interfaces:**
- Produces: `mqtt_publish_store::begin()`, `hasBroker()`, `brokerUrl()`, `token()`, `set(brokerUrl, token)`, `clear()`, `MQTT_PUBLISH_STORE_URL_MAX` (128), `MQTT_PUBLISH_STORE_TOKEN_MAX` (65) — consumed by Task 3 (provisioning) and Task 4 (`mqtt_publish`).

- [ ] **Step 1: Write the header**

Create `receiver/mqtt_publish_store.h`:

```cpp
#pragma once

#include <Arduino.h>

// mqtt://host:port or mqtts://host:port; "mqtts://weather.rkroll.com:8883" is
// 32 chars, so 128 leaves generous room.
#define MQTT_PUBLISH_STORE_URL_MAX   128
// The bridge's own AUTH_TOKEN is generated with `openssl rand -hex 24` (48
// hex chars); 65 matches WIFI_STORE_PASS_MAX's margin.
#define MQTT_PUBLISH_STORE_TOKEN_MAX 65

namespace mqtt_publish_store {
bool        begin();          // opens the "mqtt" NVS namespace
bool        hasBroker();
const char* brokerUrl();      // stored value, else the MQTT_BROKER_URL build flag, else ""
const char* token();          // stored value, else the MQTT_TOKEN build flag, else ""
bool        set(const char* brokerUrl, const char* token);
void        clear();
#ifdef FAKE_SIGNALS
bool selfTest();
#endif
} // namespace mqtt_publish_store
```

- [ ] **Step 2: Write the implementation**

Create `receiver/mqtt_publish_store.cpp`:

```cpp
#include "mqtt_publish_store.h"

#include <ArduinoLog.h>
#include <Preferences.h>

namespace mqtt_publish_store {

static Preferences _prefs;
static bool        _open = false;
static char        _url[MQTT_PUBLISH_STORE_URL_MAX] = "";
static char        _token[MQTT_PUBLISH_STORE_TOKEN_MAX] = "";

static void copyTruncated(char* dest, size_t destSize, const char* src) {
  strncpy(dest, src, destSize - 1);
  dest[destSize - 1] = '\0';
}

bool begin() {
  _open = _prefs.begin("mqtt", false);
  if (!_open) {
    Log.warning(F("mqtt publish store: NVS unavailable, settings will not persist" CR));
    _url[0] = '\0';
    _token[0] = '\0';
    return false;
  }
  String url = _prefs.getString("url", "");
  String token = _prefs.getString("token", "");
  copyTruncated(_url, sizeof(_url), url.c_str());
  copyTruncated(_token, sizeof(_token), token.c_str());
  Log.notice(F("mqtt publish store: %s" CR), hasBroker() ? "broker configured" : "no broker configured");
  return true;
}

const char* brokerUrl() {
  if (_url[0] != '\0') {
    return _url;
  }
#ifdef MQTT_BROKER_URL
  return MQTT_BROKER_URL;
#else
  return "";
#endif
}

const char* token() {
  if (_token[0] != '\0') {
    return _token;
  }
#ifdef MQTT_TOKEN
  return MQTT_TOKEN;
#else
  return "";
#endif
}

bool hasBroker() {
  return brokerUrl()[0] != '\0';
}

static bool validBroker(const char* url) {
  if (url == NULL || url[0] == '\0' || strlen(url) >= MQTT_PUBLISH_STORE_URL_MAX) {
    return false;
  }
  return strncmp(url, "mqtt://", 7) == 0 || strncmp(url, "mqtts://", 8) == 0;
}

static bool validToken(const char* token) {
  return token != NULL && strlen(token) < MQTT_PUBLISH_STORE_TOKEN_MAX;
}

bool set(const char* brokerUrl, const char* token) {
  if (!validBroker(brokerUrl) || !validToken(token)) {
    return false;
  }
  if (!_open) {
    return false;
  }
  char prevUrl[MQTT_PUBLISH_STORE_URL_MAX];
  char prevToken[MQTT_PUBLISH_STORE_TOKEN_MAX];
  copyTruncated(prevUrl, sizeof(prevUrl), _url);
  copyTruncated(prevToken, sizeof(prevToken), _token);
  copyTruncated(_url, sizeof(_url), brokerUrl);
  copyTruncated(_token, sizeof(_token), token);

  bool urlOk = _prefs.putString("url", _url) > 0;
  bool tokenOk;
  if (token[0] == '\0') {
    _prefs.remove("token");
    tokenOk = true;
  } else {
    tokenOk = _prefs.putString("token", _token) > 0;
  }
  if (urlOk && tokenOk) {
    return true;
  }
  copyTruncated(_url, sizeof(_url), prevUrl);
  copyTruncated(_token, sizeof(_token), prevToken);
  return false;
}

void clear() {
  _url[0] = '\0';
  _token[0] = '\0';
  if (_open) {
    _prefs.remove("url");
    _prefs.remove("token");
  }
}

#ifdef FAKE_SIGNALS
static bool check(const char* what, bool ok) {
  Log.notice(F("mqtt_publish_store selfTest %s: %s" CR), what, ok ? "PASS" : "FAIL");
  return ok;
}

bool selfTest() {
  bool ok = true;

  // Suppress NVS traffic across the checks below, same as wifi_store::selfTest().
  bool saved_open = _open;
  _open           = false;
  char saved_url[MQTT_PUBLISH_STORE_URL_MAX];
  char saved_token[MQTT_PUBLISH_STORE_TOKEN_MAX];
  copyTruncated(saved_url, sizeof(saved_url), _url);
  copyTruncated(saved_token, sizeof(saved_token), _token);

  _url[0] = '\0';
  _token[0] = '\0';
  ok &= check("a cleared store reports no broker", !hasBroker());
  ok &= check("set fails while NVS is closed", !set("mqtts://weather.rkroll.com:8883", "tok"));

  // set() can't be exercised end-to-end with NVS closed, so simulate a loaded
  // value by assigning the internal statics directly.
  copyTruncated(_url, sizeof(_url), "mqtts://weather.rkroll.com:8883");
  copyTruncated(_token, sizeof(_token), "tok");
  ok &= check("a loaded broker reports present", hasBroker());
  ok &= check("brokerUrl round-trips", strcmp(brokerUrl(), "mqtts://weather.rkroll.com:8883") == 0);
  ok &= check("token round-trips", strcmp(token(), "tok") == 0);

  _url[0] = '\0';
  _token[0] = '\0';
  ok &= check("clearing the internal state removes the broker", !hasBroker());

  char longUrl[MQTT_PUBLISH_STORE_URL_MAX + 1];
  memset(longUrl, 'a', sizeof(longUrl) - 1);
  longUrl[sizeof(longUrl) - 1] = '\0';

  char longToken[MQTT_PUBLISH_STORE_TOKEN_MAX + 1];
  memset(longToken, 'b', sizeof(longToken) - 1);
  longToken[sizeof(longToken) - 1] = '\0';

  ok &= check("validBroker rejects an empty url", !validBroker(""));
  ok &= check("validBroker rejects a scheme it does not recognize", !validBroker("http://weather.rkroll.com"));
  ok &= check("validBroker rejects an over-length url", !validBroker(longUrl));
  ok &= check("validBroker accepts mqtt://", validBroker("mqtt://broker.local:1883"));
  ok &= check("validBroker accepts mqtts://", validBroker("mqtts://weather.rkroll.com:8883"));
  ok &= check("validToken accepts an empty token", validToken(""));
  ok &= check("validToken rejects an over-length token", !validToken(longToken));

  // Seed a known pair directly so the "leaves prior settings in place" check
  // below has something real to verify was left untouched.
  copyTruncated(_url, sizeof(_url), "mqtts://weather.rkroll.com:8883");
  copyTruncated(_token, sizeof(_token), "tok");
  ok &= check("a rejected set leaves prior settings in place",
              strcmp(brokerUrl(), "mqtts://weather.rkroll.com:8883") == 0 &&
                  strcmp(token(), "tok") == 0);

  copyTruncated(_url, sizeof(_url), saved_url);
  copyTruncated(_token, sizeof(_token), saved_token);
  _open = saved_open;
  Log.notice(F("mqtt_publish_store selfTest overall: %s" CR), ok ? "PASS" : "FAIL");
  return ok;
}
#endif

} // namespace mqtt_publish_store
```

- [ ] **Step 3: Wire `begin()` and the on-device selfTest into `WebReceiver.ino`**

This module is not host-tested — `wifi_store` and `ota_token_store` aren't either, despite having `selfTest()`s; only `signal_store` and `alias_store` are (see `receiver/test/host/run.sh`). Its `selfTest()` runs on-device under `FAKE_SIGNALS`, same as those two.

In `receiver/WebReceiver.ino`, add the include next to the other store includes:

```cpp
#include "mqtt_publish_store.h"
```

(alphabetically, this goes between `#include "health_store.h"` and `#include "ota_token_store.h"`.)

In `setup()`, add the `begin()` call next to the other stores' (right after `ota_token_store::begin();`):

```cpp
  wifi_store::begin();
  ota_token_store::begin();
  mqtt_publish_store::begin();
```

And add its selfTest call to the existing `FAKE_SIGNALS` block:

```cpp
#ifdef FAKE_SIGNALS
  signal_store::selfTest();
  alias_store::selfTest();
  wifi_store::selfTest();
  ota_token_store::selfTest();
  mqtt_publish_store::selfTest();
#endif
```

- [ ] **Step 4: Attempt a firmware build**

Run: `cd receiver && pio run -e esp32s3-generic`
Expected: builds clean. If `pio run` cannot reach the network in this environment (dependency fetch failure unrelated to this change), note that in your task report rather than claiming a pass.

- [ ] **Step 5: Commit**

```bash
git add receiver/mqtt_publish_store.h receiver/mqtt_publish_store.cpp receiver/WebReceiver.ino
git commit -m "feat(receiver): add mqtt_publish_store for broker URL and token"
```

---

## Task 3: `.env.example` and provisioning-portal fields

**Files:**
- Modify: `receiver/.env.example`
- Modify: `receiver/provisioning.cpp`

**Model:** `haiku` — mechanical: two new lines in one file, and a form-field + parse addition in another, both following an existing pattern exactly, with complete code below.

**Interfaces:**
- Consumes: `mqtt_publish_store::set()`, `MQTT_PUBLISH_STORE_URL_MAX`, `MQTT_PUBLISH_STORE_TOKEN_MAX` (Task 2).

- [ ] **Step 1: Add the two `.env.example` lines**

In `receiver/.env.example`, append after `OTA_TOKEN`:

```
MQTT_BROKER_URL="mqtts://weather.rkroll.com:8883"
MQTT_TOKEN="generate-your-own-32-hex-chars"
```

- [ ] **Step 2: Add the include**

In `receiver/provisioning.cpp`, add next to the existing store include:

```cpp
#include "mqtt_publish_store.h"
```

(alphabetically after `#include "ota_token_store.h"`, before `#include "wifi_store.h"`.)

- [ ] **Step 3: Add the two form fields to `handleRoot()`**

In `receiver/provisioning.cpp`'s `handleRoot()`, insert two more labeled inputs right after the update-token field and before the submit button. Replace:

```cpp
      "\"><button type=\"button\" onclick=\"copyToken()\">Copy</button></label><br><br>"
      "<button type=\"submit\">Save and connect</button>"
```

with:

```cpp
      "\"><button type=\"button\" onclick=\"copyToken()\">Copy</button></label><br><br>"
      "<label>MQTT broker URL (optional)<br>"
      "<input type=\"text\" name=\"mqtt_url\" maxlength=\"127\" "
      "placeholder=\"mqtts://weather.rkroll.com:8883\"></label><br><br>"
      "<label>MQTT broker token (optional)<br>"
      "<input type=\"text\" name=\"mqtt_token\" maxlength=\"64\"></label><br><br>"
      "<button type=\"submit\">Save and connect</button>"
```

- [ ] **Step 4: Parse and store the fields in `handleSave()`**

In `receiver/provisioning.cpp`'s `handleSave()`, add after the existing `token.trim();` line:

```cpp
  String mqttUrl = _server.arg("mqtt_url");
  mqttUrl.trim();
  String mqttToken = _server.arg("mqtt_token");
  mqttToken.trim();
```

Add length checks alongside the existing OTA-token one. Replace:

```cpp
  if (token.length() >= OTA_TOKEN_STORE_MAX) {
    _server.send(400, "text/plain", "Update token is too long.");
    return;
  }
```

with:

```cpp
  if (token.length() >= OTA_TOKEN_STORE_MAX) {
    _server.send(400, "text/plain", "Update token is too long.");
    return;
  }
  if (mqttUrl.length() >= MQTT_PUBLISH_STORE_URL_MAX) {
    _server.send(400, "text/plain", "MQTT broker URL is too long.");
    return;
  }
  if (mqttToken.length() >= MQTT_PUBLISH_STORE_TOKEN_MAX) {
    _server.send(400, "text/plain", "MQTT broker token is too long.");
    return;
  }
```

Add the non-fatal save, mirroring the OTA-token one. Replace:

```cpp
  if (token.length() > 0 && !ota_token_store::set(token.c_str())) {
    // Non-fatal: WiFi is the essential part of this form. A failed token
    // save just leaves OTA on its prior token (stored, or .env), same as
    // leaving the field blank.
    Log.warning(F("provisioning: could not store update token" CR));
  }
```

with:

```cpp
  if (token.length() > 0 && !ota_token_store::set(token.c_str())) {
    // Non-fatal: WiFi is the essential part of this form. A failed token
    // save just leaves OTA on its prior token (stored, or .env), same as
    // leaving the field blank.
    Log.warning(F("provisioning: could not store update token" CR));
  }

  if (mqttUrl.length() > 0 &&
      !mqtt_publish_store::set(mqttUrl.c_str(), mqttToken.c_str())) {
    // Non-fatal for the same reason as the OTA token above.
    Log.warning(F("provisioning: could not store MQTT broker settings" CR));
  }
```

Leaving the broker URL field blank on a re-provisioning pass leaves whatever broker settings were already stored untouched, same as the OTA token field.

- [ ] **Step 5: Attempt a firmware build**

Run: `cd receiver && pio run -e esp32s3-generic`
Expected: builds clean (same network caveat as Task 2 Step 4).

- [ ] **Step 6: Commit**

```bash
git add receiver/.env.example receiver/provisioning.cpp
git commit -m "feat(receiver): add MQTT broker fields to .env and the provisioning portal"
```

---

## Task 4: `mqtt_publish` — the PubSubClient networking module

**Files:**
- Create: `receiver/mqtt_publish.h`
- Create: `receiver/mqtt_publish.cpp`
- Modify: `receiver/platformio.ini`

**Model:** `opus` — the module with the actual security-relevant surface (TLS cert pinning, token-as-password over CONNECT) and the most novel logic (URL parsing, backoff, replay). No unit-testable host path (needs `PubSubClient`/`WiFiClientSecure`), so correctness has to come from careful reading, not a green test run.

**Interfaces:**
- Consumes: `mqtt_publish_store::begin/hasBroker/brokerUrl/token` (Task 2), `signal_store::SIGNAL_DEVICE_SLOTS`, `signal_store::slotAt()`, `signal_store::latestPayload()`, `signal_store::DeviceSlot` (existing), `SIGNAL_PAYLOAD_MAX` (existing).
- Produces: `mqtt_publish::begin(const char* clientId)`, `mqtt_publish::loop()`, `mqtt_publish::onRecord(const char* key, JsonDocument& doc)` — the last one is registered as a `signal_store::RecordHook` in Task 5.

- [ ] **Step 1: Add the `PubSubClient` dependency and build flags**

In `receiver/platformio.ini`, add to `[libraries]` (alphabetical among the existing entries):

```ini
	pubsubclient = PubSubClient
```

Add it to `[env]`'s `lib_deps`:

```ini
lib_deps =
	${libraries.arduinolog}
	${libraries.arduinojson}
	${libraries.pubsubclient}
	${libraries.rtl_433_ESP}
	${libraries.adafruit_bmp280}
```

Add two build flags to `[env:esp32s3-generic]`'s `build_flags`, near `RECOVERY_BACKOFF_MS`:

```ini
  '-DMQTT_MAX_PACKET_SIZE=768'      ; PubSubClient's default 256B is too small for SIGNAL_PAYLOAD_MAX (600) + topic
  '-DMQTT_RECONNECT_BACKOFF_MS=30000' ; minimum gap between MQTT reconnect attempts
```

- [ ] **Step 2: Write the header**

Create `receiver/mqtt_publish.h`:

```cpp
#pragma once

#include <ArduinoJson.h>

namespace mqtt_publish {
// Reads mqtt_publish_store; call once, after WiFi has come up. clientId
// should be the receiver's mDNS hostname, matching the topic segment
// signal_store keys are built with.
void begin(const char* clientId);
// Services connect/reconnect (backed off by MQTT_RECONNECT_BACKOFF_MS) and
// PubSubClient::loop(). Call every main-loop iteration. A no-op when no
// broker is configured or WiFi is down.
void loop();
// Registered as a signal_store::RecordHook. Publishes doc, retained, to
// topic key. A no-op (fire-and-forget) if not currently connected.
void onRecord(const char* key, JsonDocument& doc);
} // namespace mqtt_publish
```

- [ ] **Step 3: Write the implementation**

Create `receiver/mqtt_publish.cpp`. The ISRG Root X1 certificate below is the real, current (2015-06-04 to 2035-06-04) Let's Encrypt root, extracted from this system's own `/etc/ssl/certs/ca-certificates.crt` — do not regenerate or paraphrase it.

```cpp
#include "mqtt_publish.h"

#include <ArduinoLog.h>
#include <PubSubClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <string.h>
#include <stdlib.h>

#include "mqtt_publish_store.h"
#include "signal_store.h"

#ifndef MQTT_RECONNECT_BACKOFF_MS
#define MQTT_RECONNECT_BACKOFF_MS 30000
#endif

namespace mqtt_publish {

// Let's Encrypt's ISRG Root X1, self-signed, valid 2015-06-04 to 2035-06-04.
static const char ISRG_ROOT_X1[] PROGMEM = R"EOF(
-----BEGIN CERTIFICATE-----
MIIFazCCA1OgAwIBAgIRAIIQz7DSQONZRGPgu2OCiwAwDQYJKoZIhvcNAQELBQAw
TzELMAkGA1UEBhMCVVMxKTAnBgNVBAoTIEludGVybmV0IFNlY3VyaXR5IFJlc2Vh
cmNoIEdyb3VwMRUwEwYDVQQDEwxJU1JHIFJvb3QgWDEwHhcNMTUwNjA0MTEwNDM4
WhcNMzUwNjA0MTEwNDM4WjBPMQswCQYDVQQGEwJVUzEpMCcGA1UEChMgSW50ZXJu
ZXQgU2VjdXJpdHkgUmVzZWFyY2ggR3JvdXAxFTATBgNVBAMTDElTUkcgUm9vdCBY
MTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBAK3oJHP0FDfzm54rVygc
h77ct984kIxuPOZXoHj3dcKi/vVqbvYATyjb3miGbESTtrFj/RQSa78f0uoxmyF+
0TM8ukj13Xnfs7j/EvEhmkvBioZxaUpmZmyPfjxwv60pIgbz5MDmgK7iS4+3mX6U
A5/TR5d8mUgjU+g4rk8Kb4Mu0UlXjIB0ttov0DiNewNwIRt18jA8+o+u3dpjq+sW
T8KOEUt+zwvo/7V3LvSye0rgTBIlDHCNAymg4VMk7BPZ7hm/ELNKjD+Jo2FR3qyH
B5T0Y3HsLuJvW5iB4YlcNHlsdu87kGJ55tukmi8mxdAQ4Q7e2RCOFvu396j3x+UC
B5iPNgiV5+I3lg02dZ77DnKxHZu8A/lJBdiB3QW0KtZB6awBdpUKD9jf1b0SHzUv
KBds0pjBqAlkd25HN7rOrFleaJ1/ctaJxQZBKT5ZPt0m9STJEadao0xAH0ahmbWn
OlFuhjuefXKnEgV4We0+UXgVCwOPjdAvBbI+e0ocS3MFEvzG6uBQE3xDk3SzynTn
jh8BCNAw1FtxNrQHusEwMFxIt4I7mKZ9YIqioymCzLq9gwQbooMDQaHWBfEbwrbw
qHyGO0aoSCqI3Haadr8faqU9GY/rOPNk3sgrDQoo//fb4hVC1CLQJ13hef4Y53CI
rU7m2Ys6xt0nUW7/vGT1M0NPAgMBAAGjQjBAMA4GA1UdDwEB/wQEAwIBBjAPBgNV
HRMBAf8EBTADAQH/MB0GA1UdDgQWBBR5tFnme7bl5AFzgAiIyBpY9umbbjANBgkq
hkiG9w0BAQsFAAOCAgEAVR9YqbyyqFDQDLHYGmkgJykIrGF1XIpu+ILlaS/V9lZL
ubhzEFnTIZd+50xx+7LSYK05qAvqFyFWhfFQDlnrzuBZ6brJFe+GnY+EgPbk6ZGQ
3BebYhtF8GaV0nxvwuo77x/Py9auJ/GpsMiu/X1+mvoiBOv/2X/qkSsisRcOj/KK
NFtY2PwByVS5uCbMiogziUwthDyC3+6WVwW6LLv3xLfHTjuCvjHIInNzktHCgKQ5
ORAzI4JMPJ+GslWYHb4phowim57iaztXOoJwTdwJx4nLCgdNbOhdjsnvzqvHu7Ur
TkXWStAmzOVyyghqpZXjFaH3pO3JLF+l+/+sKAIuvtd7u+Nxe5AW0wdeRlN8NwdC
jNPElpzVmbUq4JUagEiuTDkHzsxHpFKVK7q4+63SM1N95R1NbdWhscdCb+ZAJzVc
oyi3B43njTOQ5yOf+1CceWxG1bQVs5ZufpsMljq4Ui0/1lvh+wjChP4kqKOJ2qxq
4RgqsahDYVvTH9w7jXbyLeiNdd8XM2w9U/t7y0Ff/9yi0GE44Za4rF2LN9d11TPA
mRGunUHBcnWEvgJBQl9nJEiU0Zsnvgc/ubhPgXRR4Xq37Z0j4r7g1SgEEzwxA57d
emyPxgcYxn/eR44/KJ4EBs+lVDR3veyJm+kXQ99b21/+jh5Xos1AnX5iItreGCc=
-----END CERTIFICATE-----
)EOF";

struct ParsedBroker {
  bool     tls   = false;
  bool     valid = false;
  char     host[64] = "";
  uint16_t port  = 0;
};

// mqtt://host:port or mqtts://host:port. A port is required, matching every
// example in .env.example and the provisioning form's placeholder — this
// mirrors dashboard/src/sources.js's normalizeBase() in spirit (a small,
// deliberately strict parser for a URL shape this project controls both
// ends of), not URL parsing in general.
static ParsedBroker parseBrokerUrl(const char* url) {
  ParsedBroker p;
  if (url == nullptr) return p;
  const char* rest;
  if (strncmp(url, "mqtts://", 8) == 0) {
    p.tls = true;
    rest  = url + 8;
  } else if (strncmp(url, "mqtt://", 7) == 0) {
    p.tls = false;
    rest  = url + 7;
  } else {
    return p;
  }
  const char* colon = strchr(rest, ':');
  if (colon == nullptr) return p;
  size_t hostLen = (size_t)(colon - rest);
  if (hostLen == 0 || hostLen >= sizeof(p.host)) return p;
  strncpy(p.host, rest, hostLen);
  p.host[hostLen] = '\0';
  char* end   = nullptr;
  long  port  = strtol(colon + 1, &end, 10);
  if (end == colon + 1 || (*end != '\0') || port <= 0 || port > 65535) return p;
  p.port  = (uint16_t)port;
  p.valid = true;
  return p;
}

static WiFiClient       _plainClient;
static WiFiClientSecure _secureClient;
static PubSubClient     _mqtt;
static ParsedBroker     _broker;
static char             _token[MQTT_PUBLISH_STORE_TOKEN_MAX] = "";
static char             _clientId[64] = "";
static bool             _enabled = false;
static unsigned long    _lastAttempt = 0;

static void replayAll() {
  uint8_t sent = 0;
  for (uint8_t i = 0; i < SIGNAL_DEVICE_SLOTS; i++) {
    const DeviceSlot* slot = signal_store::slotAt(i);
    if (slot == nullptr) continue;
    const char* payload = signal_store::latestPayload(*slot);
    if (payload == nullptr) continue;
    if (_mqtt.publish(slot->key, payload, true)) sent++;
  }
  Log.notice(F("mqtt publish: replayed %d retained record(s) on connect" CR), sent);
}

static bool connectOnce() {
  if (millis() - _lastAttempt < MQTT_RECONNECT_BACKOFF_MS) return false;
  _lastAttempt = millis();
  bool ok = _token[0] != '\0'
                ? _mqtt.connect(_clientId, "", _token)
                : _mqtt.connect(_clientId);
  if (ok) {
    Log.notice(F("mqtt publish: connected to %s:%u" CR), _broker.host, _broker.port);
    replayAll();
  } else {
    Log.warning(F("mqtt publish: connect to %s:%u failed, state=%d" CR),
                _broker.host, _broker.port, _mqtt.state());
  }
  return ok;
}

void begin(const char* clientId) {
  strncpy(_clientId, clientId, sizeof(_clientId) - 1);
  _clientId[sizeof(_clientId) - 1] = '\0';

  mqtt_publish_store::begin();
  const char* url = mqtt_publish_store::brokerUrl();
  if (url[0] == '\0') {
    Log.notice(F("mqtt publish: no broker configured, disabled" CR));
    _enabled = false;
    return;
  }
  _broker = parseBrokerUrl(url);
  if (!_broker.valid) {
    Log.warning(F("mqtt publish: broker URL \"%s\" is not a valid mqtt(s)://host:port, disabled" CR), url);
    _enabled = false;
    return;
  }
  strncpy(_token, mqtt_publish_store::token(), sizeof(_token) - 1);
  _token[sizeof(_token) - 1] = '\0';

  if (_broker.tls) {
    _secureClient.setCACert(ISRG_ROOT_X1);
    _mqtt.setClient(_secureClient);
  } else {
    _mqtt.setClient(_plainClient);
  }
  _mqtt.setServer(_broker.host, _broker.port);
  _enabled = true;
  Log.notice(F("mqtt publish: enabled, broker %s:%u (%s)" CR),
             _broker.host, _broker.port, _broker.tls ? "TLS" : "plain");
}

void loop() {
  if (!_enabled) return;
  if (WiFi.status() != WL_CONNECTED) return;
  if (!_mqtt.connected()) {
    connectOnce();
    return;
  }
  _mqtt.loop();
}

void onRecord(const char* key, JsonDocument& doc) {
  if (!_enabled || !_mqtt.connected()) return;
  char payload[SIGNAL_PAYLOAD_MAX + 1];
  size_t n = serializeJson(doc, payload, sizeof(payload));
  if (n == 0 || n >= sizeof(payload)) return;
  _mqtt.publish(key, payload, true);
}

} // namespace mqtt_publish
```

- [ ] **Step 4: Attempt a firmware build**

Run: `cd receiver && pio run -e esp32s3-generic`
Expected: builds clean (same network caveat as prior tasks — `PubSubClient` is a new dependency, so this is also the first real test that it resolves from the PlatformIO registry). Read any compiler errors carefully: `WiFiClientSecure::setCACert` takes a `const char*`, and `PubSubClient::connect`'s 3-argument overload is `(clientId, user, pass)` — both used above.

- [ ] **Step 5: Commit**

```bash
git add receiver/mqtt_publish.h receiver/mqtt_publish.cpp receiver/platformio.ini
git commit -m "feat(receiver): add mqtt_publish networking module"
```

---

## Task 5: Wire `mqtt_publish` into `WebReceiver.ino`

**Files:**
- Modify: `receiver/WebReceiver.ino`

**Model:** `sonnet` — small edit, but placement relative to `mdnsHostname()`/WiFi-up ordering matters.

**Interfaces:**
- Consumes: `mqtt_publish::begin()`, `mqtt_publish::loop()`, `mqtt_publish::onRecord()` (Task 4), `signal_store::addRecordHook()` (Task 1).

- [ ] **Step 1: Add the include**

In `receiver/WebReceiver.ino`, add next to the other new include:

```cpp
#include "mqtt_publish.h"
```

(alphabetically, between `#include "health_store.h"` and `#include "mqtt_publish_store.h"` — this makes the include block read `alias_store, device_hooks, health_store, mqtt_publish, mqtt_publish_store, ota_token_store, provisioning, radio_health, signal_store, tz_store, web_ui, wifi_store`.)

- [ ] **Step 2: Register the hook and start the module in `setup()`**

`mqtt_publish::begin()` needs `mdnsHostname()`, which is only stable once WiFi is up or provisioning has completed — the same point `signal_store::setSource(mdnsHostname())` already runs. In `setup()`, replace:

```cpp
  signal_store::setSource(mdnsHostname());
  tz_store::begin();
  device_hooks::begin();
  signal_store::addRecordHook(device_hooks::dispatch);
```

with:

```cpp
  signal_store::setSource(mdnsHostname());
  tz_store::begin();
  device_hooks::begin();
  signal_store::addRecordHook(device_hooks::dispatch);
  mqtt_publish::begin(mdnsHostname());
  signal_store::addRecordHook(mqtt_publish::onRecord);
```

(This registers `device_hooks::dispatch` first, `mqtt_publish::onRecord` second — hooks fire in registration order, so MQTT publishes the record after `device_hooks` has already added `rain_today_mm` etc., matching what ends up in `signal_store`'s own stored payload.)

- [ ] **Step 3: Service the client in `loop()`**

In `loop()`, replace:

```cpp
void loop() {
  rf.loop();
  serviceWiFi();
  web_ui::loop();
  drainSignalQueue();
```

with:

```cpp
void loop() {
  rf.loop();
  serviceWiFi();
  web_ui::loop();
  mqtt_publish::loop();
  drainSignalQueue();
```

- [ ] **Step 4: Attempt a firmware build**

Run: `cd receiver && pio run -e esp32s3-generic`
Expected: builds clean.

- [ ] **Step 5: Commit**

```bash
git add receiver/WebReceiver.ino
git commit -m "feat(receiver): wire mqtt_publish into setup() and loop()"
```

---

## Task 6: Documentation

**Files:**
- Modify: `receiver/docs/architecture.md`
- Modify: `receiver/docs/install.md`
- Modify: `receiver/docs/user-manual.md`
- Modify: `receiver/docs/backlog.md`

**Model:** `haiku` — mechanical prose insertion at specified locations, all text given verbatim below.

- [ ] **Step 1: Document the module in `architecture.md`**

In `receiver/docs/architecture.md`, update the `signal_store` bullet's hook sentence. Replace:

```
`record()` stamps `time`, `rssi`, and `count` into the decoded JSON before
serialising it into the sub for that `message_type`.
```

with:

```
`record()` stamps `time`, `rssi`, and `count` into the decoded JSON before
serialising it into the sub for that `message_type`. Up to `SIGNAL_MAX_HOOKS`
(2) record hooks can be registered with `addRecordHook()`, run in
registration order right after the stamp and before the size check —
`device_hooks::dispatch` and `mqtt_publish::onRecord` are the two the
firmware wires up.
```

Add a new module bullet after the `provisioning.h` / `provisioning.cpp` bullet (before `## Boot order`):

```
**`mqtt_publish_store.h` / `mqtt_publish_store.cpp`** — persists the MQTT
broker URL and token to `Preferences` namespace `"mqtt"`, in fixed
`_url`/`_token` buffers. Mirrors `wifi_store`'s fixed-buffer/NVS shape;
`brokerUrl()`/`token()` follow `ota_token_store::token()`'s precedence
(stored value, else the `.env`-supplied `MQTT_BROKER_URL`/`MQTT_TOKEN` build
flags, else empty). `hasBroker()` is false, and the feature stays off, until
a broker URL is set by either path.

**`mqtt_publish.h` / `mqtt_publish.cpp`** — publishes every record to a
remote broker over `PubSubClient`, retained. `begin()` parses the stored
broker URL once (`mqtt://` picks a plain `WiFiClient`, `mqtts://` a
`WiFiClientSecure` with the ISRG Root X1 root CA compiled in — never
`setInsecure()`) and calls `PubSubClient::setServer()`; `loop()` runs
`PubSubClient::loop()` and retries a dropped connection no more than once
per `MQTT_RECONNECT_BACKOFF_MS`. `onRecord()`, registered as a second
`signal_store` record hook, publishes the hook's `JsonDocument` unmodified
to the topic `key` already is — `<mdnsHostname()>/<model>/<id>`, since
`signal_store::setSource(mdnsHostname())` is what built that key in the
first place. A publish while disconnected is simply skipped: there is no
retry queue, because every successful (re)connect calls `replayAll()`,
walking `signal_store::slotAt()`/`latestPayload()` to republish every
currently-held record, which backfills anything a fire-and-forget publish
missed.
```

- [ ] **Step 2: Update the "Data flow" section**

In `receiver/docs/architecture.md`, replace:

```
Before the size check, `record()` calls the registered record hook (if any).
`device_hooks::dispatch` reads the model from the payload, calls the matching
hook, and the rain hook computes `rain_today_mm` from the cumulative `rain_mm`
and a per-device baseline reset at local midnight. The hook writes back into
the `JsonDocument` before it is serialized into the sub.
```

with:

```
Before the size check, `record()` calls each registered record hook in turn.
`device_hooks::dispatch` reads the model from the payload, calls the matching
hook, and the rain hook computes `rain_today_mm` from the cumulative `rain_mm`
and a per-device baseline reset at local midnight, writing back into the
`JsonDocument` before it is serialized into the sub. `mqtt_publish::onRecord`
runs after it, so a configured remote broker gets `rain_today_mm` and every
other hook-added field too, not just what rtl_433 originally decoded.
```

- [ ] **Step 3: Document configuration in `install.md`**

In `receiver/docs/install.md`'s `## Configure` section, replace:

```
`.env` is an optional dev/CI shortcut: `cp .env.example .env`, fill in
`WIFI_SSID`, `WIFI_PASSWORD`, `MDNS_PREFIX`, and optionally `OTA_TOKEN`, and a
build with `.env` present connects with those credentials on first boot, then
stores them so later boots skip straight to connecting (no portal).
`MDNS_PREFIX` has no runtime equivalent yet, so a device provisioned entirely
through the portal uses the `rtl433` default. `OTA_TOKEN` seeds the bearer
token `/$update` checks (see `docs/user-manual.md`) if the portal has never
been used to set one; it's overridden the moment a token is saved through the
portal. Generate a random value yourself (e.g. `openssl rand -hex 16`) rather
than leaving the `.env.example` placeholder in place. `.env` is bash syntax,
gitignored, and read by `load_env.py`, which turns each entry into a `-D`
build flag.
```

with:

```
`.env` is an optional dev/CI shortcut: `cp .env.example .env`, fill in
`WIFI_SSID`, `WIFI_PASSWORD`, `MDNS_PREFIX`, and optionally `OTA_TOKEN`, and a
build with `.env` present connects with those credentials on first boot, then
stores them so later boots skip straight to connecting (no portal).
`MDNS_PREFIX` has no runtime equivalent yet, so a device provisioned entirely
through the portal uses the `rtl433` default. `OTA_TOKEN` seeds the bearer
token `/$update` checks (see `docs/user-manual.md`) if the portal has never
been used to set one; it's overridden the moment a token is saved through the
portal. Generate a random value yourself (e.g. `openssl rand -hex 16`) rather
than leaving the `.env.example` placeholder in place. `.env` is bash syntax,
gitignored, and read by `load_env.py`, which turns each entry into a `-D`
build flag.

`MQTT_BROKER_URL` and `MQTT_TOKEN` are optional and off by default: setting
neither leaves the device publishing nothing. Set `MQTT_BROKER_URL` to
publish every record, retained, to a remote broker — `mqtt://host:port` for
a plaintext LAN broker (Mosquitto, Home Assistant), `mqtts://host:port` for
a public one, like `weather.rkroll.com`'s embedded bridge broker (see
`../../bridge/docs/install.md`'s `AUTH_TOKEN`), which requires `MQTT_TOKEN`
to match. Both are overridden the moment they're saved through the
provisioning portal, same as `OTA_TOKEN`.
```

- [ ] **Step 4: Document the behavior in `user-manual.md`**

In `receiver/docs/user-manual.md`, after the "Once connected, WiFi is not required..." paragraph and before `## Routes`, add:

```
## Publishing to a remote broker

Set `MQTT_BROKER_URL` (`.env` or the provisioning portal) to also publish
every record, retained, to a remote MQTT broker — off by default. The topic
is the same key the receiver stores it under locally,
`<mdnsHostname()>/<model>/<id>`, and the payload is the identical JSON `GET
/<topic>` would return. `MQTT_TOKEN`, if set, is sent as the CONNECT
password; a broker on the LAN often needs none. Publishing is
fire-and-forget — a record that arrives while disconnected from the broker
is simply not published — but every successful connect or reconnect
republishes everything currently held, so a broker that was briefly
unreachable catches back up without waiting for each device's next natural
transmission.
```

- [ ] **Step 5: Fold the implemented backlog item into the note above and delete it**

In `receiver/docs/backlog.md`, the "No path in or out for sensors that are not 433 MHz decodes" item's third bullet is now implemented. Replace:

```
- Ingest from elsewhere: an authenticated `POST /api/signal` taking the same
  rtl_433 JSON is about twenty lines and no new dependency. An MQTT
  subscription needs a broker and roughly 10 KB of flash, against 144 KB free.
  ESP-NOW suits battery nodes but pins them to the station's WiFi channel.
- Egress to home automation: publishing each decode to
  `rtl_433/<host>/devices/<model>/<id>/<field>` matches what rtl_433's own
  `-F mqtt` emits, so existing Home Assistant setups would take it unchanged.
  A `GET` of a topic from an HA REST sensor works today with no firmware
  change at all, and is the cheapest first step.
```

with:

```
- Ingest from elsewhere: an authenticated `POST /api/signal` taking the same
  rtl_433 JSON is about twenty lines and no new dependency. An MQTT
  subscription needs a broker and roughly 10 KB of flash, against 144 KB free.
  ESP-NOW suits battery nodes but pins them to the station's WiFi channel.
```

(Egress — publishing each decode out over MQTT — is implemented; see
`mqtt_publish.h`/`mqtt_publish.cpp` in `architecture.md` and "Publishing to a
remote broker" in `user-manual.md`. Ingest remains the open gap this item
describes.)

- [ ] **Step 6: Commit**

```bash
git add receiver/docs/architecture.md receiver/docs/install.md receiver/docs/user-manual.md receiver/docs/backlog.md
git commit -m "docs(receiver): document MQTT publish to a remote broker"
```

---

## Self-Review Notes

- **Spec coverage:** Configuration (Task 2, 3) — `mqtt_publish_store` shape and `.env`/portal paths; Publishing (Task 4) — library, trigger via the widened hook (Task 1), topic (reuses `key`, verified equal to `<mdnsHostname()>/<model>/<id>` since `source` is always `mdnsHostname()`), retain flag; Replay on connect (Task 4's `replayAll()`); Reliability (Task 4's backoff + fire-and-forget); Out of scope — nothing here touches the bridge, dashboard, adds QoS, or adds LWT/health topics. Open question — resolved as option (a), documented in Global Constraints.
- **Placeholder scan:** every step has complete code; no "add error handling"-style steps.
- **Type consistency:** `mqtt_publish_store::brokerUrl()`/`token()`/`MQTT_PUBLISH_STORE_*_MAX` used identically across Tasks 2–4; `signal_store::addRecordHook`/`RecordHook`/`SIGNAL_MAX_HOOKS` used identically across Tasks 1 and 5; `mqtt_publish::begin/loop/onRecord` used identically across Tasks 4 and 5.
