# Multi-bridge MQTT push from the Settings tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the receiver's MQTT publish broker/token from a single provisioning-portal-set pair to a dashboard-managed, 3-slot table, so a receiver can push its own readings to more than one broker at once, editable from the Settings tab without re-provisioning.

**Architecture:** `mqtt_publish_store` becomes a fixed 3-slot url/token table (one JSON blob, one NVS key, mirroring `alias_store`). `mqtt_publish` becomes one `PubSubClient` connection per table slot plus the always-on `MQTT_BROKER_URL` build-flag default (4 total), each connecting/replaying independently. `web_ui.cpp` exposes them at a new bare `/$mqtt` route (not a topic, registered directly). The provisioning portal drops its MQTT fields entirely. The dashboard gets a new `bridges.js`/`bridges.jsx` pair, structurally `sources.js` reversed (push instead of pull, no `localStorage`), shown in `SettingsView` next to `SourcesView`.

**Tech Stack:** ESP32 Arduino/PlatformIO C++ (receiver), Preact + `@preact/signals` (dashboard), `node:test` for both host and dashboard unit tests.

## Global Constraints

- `MQTT_PUBLISH_SLOTS = 3`; the build-flag `MQTT_BROKER_URL`/`MQTT_TOKEN` connection is a 4th, separate, always-on connection outside the table.
- `MQTT_PUBLISH_STORE_URL_MAX = 128`, `MQTT_PUBLISH_STORE_TOKEN_MAX = 65` (unchanged from today).
- A stored value must start `mqtt://` or `mqtts://` and fit those length caps; `add()` rejects anything else and rejects a new url once all 3 slots are full.
- No editing a stored token without re-adding the bridge (`add()` with an existing url updates the token in place).
- The build-flag default connection can't be removed via the dashboard; `mqtt_publish_store::remove()` never touches it because it was never in the table.
- Dashboard: no `localStorage` for the bridge list; state is a signal holding the last `GET /$mqtt` fetch, refetched after every mutation. A missing `/$mqtt` (dashboard not served by a receiver) renders nothing, not an error.
- Every code change lands with the doc update that describes it, in the same task.

---

### Task 1: `mqtt_publish_store` — 3-slot table, migration, host-run selfTest

**Files:**
- Modify: `receiver/mqtt_publish_store.h`
- Modify: `receiver/mqtt_publish_store.cpp`
- Create: `receiver/test/host/mqtt_publish_store_test.cpp`
- Modify: `receiver/test/host/run.sh`
- Modify: `receiver/docs/architecture.md:162-168`

**Model:** `sonnet` — judgment-level rework of an existing store, following `alias_store`'s established blob-table pattern.

**Interfaces:**
- Produces (used by Task 2 and Task 3):
  ```cpp
  namespace mqtt_publish_store {
  bool        begin();
  uint8_t     count();
  const char* urlAt(uint8_t i);     // NULL if i is out of range or unused
  const char* tokenAt(uint8_t i);   // NULL if i is out of range or unused
  bool        add(const char* url, const char* token);  // updates in place if url exists
  bool        remove(const char* url);
  int         indexOf(const char* url);                 // -1 if absent
  #ifdef FAKE_SIGNALS
  bool selfTest();
  #endif
  }
  #define MQTT_PUBLISH_STORE_URL_MAX   128
  #define MQTT_PUBLISH_STORE_TOKEN_MAX 65
  #define MQTT_PUBLISH_SLOTS 3
  ```

- [ ] **Step 1: Rewrite `receiver/mqtt_publish_store.h`**

```cpp
#pragma once

#include <Arduino.h>

// mqtt://host:port or mqtts://host:port; "mqtts://weather.rkroll.com:8883" is
// 32 chars, so 128 leaves generous room.
#define MQTT_PUBLISH_STORE_URL_MAX   128
// The bridge's own AUTH_TOKEN is generated with `openssl rand -hex 24` (48
// hex chars); 65 matches WIFI_STORE_PASS_MAX's margin.
#define MQTT_PUBLISH_STORE_TOKEN_MAX 65
// A receiver pushes to at most this many dashboard-configured bridges at
// once, on top of the always-on MQTT_BROKER_URL build-flag default.
#define MQTT_PUBLISH_SLOTS 3
// NVS keys are capped at 15 characters, so the whole table is one blob under
// one key rather than an entry per slot, the same reason alias_store uses a
// blob for its 32-slot table. Three slots of a 128-byte url, a 65-byte
// token, and JSON overhead comfortably fit; 768 leaves headroom.
#define MQTT_PUBLISH_STORE_BLOB_MAX 768

namespace mqtt_publish_store {
bool        begin();          // opens the "mqtt" NVS namespace, migrates any old single-slot value
uint8_t     count();
const char* urlAt(uint8_t i);
const char* tokenAt(uint8_t i);
bool        add(const char* url, const char* token);    // updates in place if url exists
bool        remove(const char* url);
int         indexOf(const char* url);                   // -1 if absent
#ifdef FAKE_SIGNALS
bool selfTest();
#endif
} // namespace mqtt_publish_store
```

- [ ] **Step 2: Rewrite `receiver/mqtt_publish_store.cpp`**

```cpp
#include "mqtt_publish_store.h"

#include <ArduinoJson.h>
#include <ArduinoLog.h>
#include <Preferences.h>

namespace mqtt_publish_store {

static char        _url[MQTT_PUBLISH_SLOTS][MQTT_PUBLISH_STORE_URL_MAX];
static char        _token[MQTT_PUBLISH_SLOTS][MQTT_PUBLISH_STORE_TOKEN_MAX];
static bool        _used[MQTT_PUBLISH_SLOTS] = {false};
static Preferences _prefs;
static bool        _open = false;

static void copyTruncated(char* dest, size_t destSize, const char* src) {
  strncpy(dest, src, destSize - 1);
  dest[destSize - 1] = '\0';
}

static int find(const char* url) {
  for (uint8_t i = 0; i < MQTT_PUBLISH_SLOTS; i++) {
    if (_used[i] && strcmp(_url[i], url) == 0) {
      return i;
    }
  }
  return -1;
}

static int findFree() {
  for (uint8_t i = 0; i < MQTT_PUBLISH_SLOTS; i++) {
    if (!_used[i]) {
      return i;
    }
  }
  return -1;
}

static bool validUrl(const char* url) {
  if (url == NULL || url[0] == '\0' || strlen(url) >= MQTT_PUBLISH_STORE_URL_MAX) {
    return false;
  }
  return strncmp(url, "mqtt://", 7) == 0 || strncmp(url, "mqtts://", 8) == 0;
}

static bool validToken(const char* token) {
  return token != NULL && strlen(token) < MQTT_PUBLISH_STORE_TOKEN_MAX;
}

static size_t serializeTable(char* out, size_t size) {
  JsonDocument doc;
  JsonArray    arr = doc.to<JsonArray>();
  for (uint8_t i = 0; i < MQTT_PUBLISH_SLOTS; i++) {
    if (_used[i]) {
      JsonObject o = arr.add<JsonObject>();
      o["url"] = (const char*)_url[i];
      o["token"] = (const char*)_token[i];
    }
  }
  if (measureJson(doc) >= size) {
    return 0;
  }
  return serializeJson(doc, out, size);
}

static void loadTable(const char* json) {
  memset(_used, 0, sizeof(_used));
  JsonDocument doc;
  if (json == NULL || *json == '\0') {
    return;
  }
  if (deserializeJson(doc, json) != DeserializationError::Ok) {
    return;
  }
  JsonArray arr = doc.as<JsonArray>();
  if (arr.isNull()) {
    return;
  }
  uint8_t i = 0;
  for (JsonObject o : arr) {
    if (i >= MQTT_PUBLISH_SLOTS || !o["url"].is<const char*>() || !o["token"].is<const char*>()) {
      continue;
    }
    copyTruncated(_url[i], MQTT_PUBLISH_STORE_URL_MAX, o["url"].as<const char*>());
    copyTruncated(_token[i], MQTT_PUBLISH_STORE_TOKEN_MAX, o["token"].as<const char*>());
    _used[i] = true;
    i++;
  }
}

static bool persist() {
  char   blob[MQTT_PUBLISH_STORE_BLOB_MAX];
  size_t n = serializeTable(blob, sizeof(blob));
  if (n == 0) {
    return false;
  }
  if (!_open) {
    // A receiver whose NVS won't open should still let a session-only add
    // work rather than answer 503 to every POST /$mqtt.
    return true;
  }
  return _prefs.putString("table", blob) > 0;
}

uint8_t count() {
  uint8_t n = 0;
  for (uint8_t i = 0; i < MQTT_PUBLISH_SLOTS; i++) {
    if (_used[i]) {
      n++;
    }
  }
  return n;
}

const char* urlAt(uint8_t i) {
  return i < MQTT_PUBLISH_SLOTS && _used[i] ? _url[i] : NULL;
}

const char* tokenAt(uint8_t i) {
  return i < MQTT_PUBLISH_SLOTS && _used[i] ? _token[i] : NULL;
}

bool add(const char* url, const char* token) {
  if (!validUrl(url) || !validToken(token)) {
    return false;
  }
  int  i = find(url);
  bool inserting = (i < 0);
  if (inserting) {
    i = findFree();
    if (i < 0) {
      return false;
    }
  }
  char prevUrl[MQTT_PUBLISH_STORE_URL_MAX];
  char prevToken[MQTT_PUBLISH_STORE_TOKEN_MAX];
  if (!inserting) {
    copyTruncated(prevUrl, sizeof(prevUrl), _url[i]);
    copyTruncated(prevToken, sizeof(prevToken), _token[i]);
  }
  copyTruncated(_url[i], MQTT_PUBLISH_STORE_URL_MAX, url);
  copyTruncated(_token[i], MQTT_PUBLISH_STORE_TOKEN_MAX, token);
  _used[i] = true;
  if (persist()) {
    return true;
  }
  if (inserting) {
    _used[i] = false;
  } else {
    copyTruncated(_url[i], sizeof(_url[i]), prevUrl);
    copyTruncated(_token[i], sizeof(_token[i]), prevToken);
  }
  return false;
}

bool remove(const char* url) {
  int i = find(url);
  if (i < 0) {
    return false;
  }
  _used[i] = false;
  if (persist()) {
    return true;
  }
  _used[i] = true;
  return false;
}

int indexOf(const char* url) {
  return find(url);
}

// Reuses add()'s validation on the theory that a value the old set() already
// accepted still passes it; if it somehow doesn't, migration silently no-ops
// and the old keys are left in place rather than losing the setting.
static bool migrateLegacy(const char* legacyUrl, const char* legacyToken) {
  if (count() != 0 || legacyUrl == NULL || legacyUrl[0] == '\0') {
    return false;
  }
  return add(legacyUrl, legacyToken == NULL ? "" : legacyToken);
}

bool begin() {
  if (_open) {
    return true;
  }
  memset(_used, 0, sizeof(_used));
  _open = _prefs.begin("mqtt", false);
  if (!_open) {
    Log.warning(F("mqtt publish store: NVS unavailable, settings will not persist" CR));
    return false;
  }
  String stored = _prefs.getString("table", "");
  loadTable(stored.c_str());
  String oldUrl = _prefs.getString("url", "");
  if (migrateLegacy(oldUrl.c_str(), _prefs.getString("token", "").c_str())) {
    _prefs.remove("url");
    _prefs.remove("token");
    Log.notice(F("mqtt publish store: migrated legacy single-broker setting" CR));
  }
  Log.notice(F("mqtt publish store: %d bridge(s) configured" CR), (int)count());
  return true;
}

#ifdef FAKE_SIGNALS
static bool check(const char* what, bool ok) {
  Log.notice(F("mqtt_publish_store selfTest %s: %s" CR), what, ok ? "PASS" : "FAIL");
  return ok;
}

bool selfTest() {
  bool ok = true;

  // Suppress NVS traffic across the checks below, same as alias_store::selfTest();
  // add()/remove() still exercise their in-memory logic and persist()'s "NVS
  // closed still returns true" branch.
  bool saved_open = _open;
  _open           = false;
  memset(_used, 0, sizeof(_used));

  ok &= check("an empty table has no entries", count() == 0);
  ok &= check("indexOf on an empty table is -1", indexOf("mqtt://broker.local:1883") < 0);
  ok &= check("validUrl rejects an empty url", !validUrl(""));
  ok &= check("validUrl rejects a scheme it does not recognize", !validUrl("http://broker.local"));
  ok &= check("validUrl accepts mqtt://", validUrl("mqtt://broker.local:1883"));
  ok &= check("validUrl accepts mqtts://", validUrl("mqtts://weather.rkroll.com:8883"));
  ok &= check("validToken accepts an empty token", validToken(""));

  char longUrl[MQTT_PUBLISH_STORE_URL_MAX + 1];
  memset(longUrl, 'a', sizeof(longUrl) - 1);
  longUrl[sizeof(longUrl) - 1] = '\0';
  ok &= check("validUrl rejects an over-length url", !validUrl(longUrl));

  char longToken[MQTT_PUBLISH_STORE_TOKEN_MAX + 1];
  memset(longToken, 'b', sizeof(longToken) - 1);
  longToken[sizeof(longToken) - 1] = '\0';
  ok &= check("validToken rejects an over-length token", !validToken(longToken));

  ok &= check("add stores a url/token pair", add("mqtt://broker.local:1883", "tok"));
  ok &= check("count reflects one entry", count() == 1);
  int i0 = indexOf("mqtt://broker.local:1883");
  ok &= check("indexOf finds it", i0 >= 0);
  ok &= check("urlAt/tokenAt round-trip",
              strcmp(urlAt((uint8_t)i0), "mqtt://broker.local:1883") == 0 &&
                  strcmp(tokenAt((uint8_t)i0), "tok") == 0);

  ok &= check("re-adding the same url updates the token in place",
              add("mqtt://broker.local:1883", "tok2") && count() == 1 &&
                  strcmp(tokenAt((uint8_t)i0), "tok2") == 0);

  ok &= check("add rejects an invalid url", !add("http://broker.local", "tok"));
  ok &= check("a rejected add leaves the table alone", count() == 1);

  ok &= check("add fills the remaining slots",
              add("mqtt://b2:1883", "") && add("mqtts://b3:8883", "t3") && count() == MQTT_PUBLISH_SLOTS);
  ok &= check("add past the cap fails, no matching url", !add("mqtt://b4:1883", ""));
  ok &= check("a failed add leaves the count unchanged", count() == MQTT_PUBLISH_SLOTS);

  ok &= check("remove drops the matching entry", remove("mqtt://b2:1883"));
  ok &= check("count drops with it", count() == MQTT_PUBLISH_SLOTS - 1);
  ok &= check("removing an absent url reports false", !remove("mqtt://b2:1883"));
  ok &= check("a freed slot is reusable", add("mqtt://b4:1883", "") && count() == MQTT_PUBLISH_SLOTS);

  memset(_used, 0, sizeof(_used));
  ok &= check("migrateLegacy copies a legacy value into slot 0",
              migrateLegacy("mqtts://weather.rkroll.com:8883", "legacy") && count() == 1 &&
                  strcmp(urlAt(0), "mqtts://weather.rkroll.com:8883") == 0 &&
                  strcmp(tokenAt(0), "legacy") == 0);
  ok &= check("migrateLegacy is a no-op once the table is non-empty",
              !migrateLegacy("mqtt://other:1883", "") && count() == 1);

  memset(_used, 0, sizeof(_used));
  ok &= check("migrateLegacy is a no-op with no legacy url", !migrateLegacy("", ""));
  ok &= check("migrateLegacy is a no-op with a null legacy url", !migrateLegacy(NULL, NULL));

  memset(_used, 0, sizeof(_used));
  add("mqtt://b1:1883", "t1");
  add("mqtts://b2:8883", "");
  char blob[MQTT_PUBLISH_STORE_BLOB_MAX];
  size_t n = serializeTable(blob, sizeof(blob));
  ok &= check("the table serialises", n > 0);
  memset(_used, 0, sizeof(_used));
  loadTable(blob);
  ok &= check("a serialised blob reloads", count() == 2);
  int ib2 = indexOf("mqtts://b2:8883");
  ok &= check("an empty stored token round-trips",
              ib2 >= 0 && strcmp(tokenAt((uint8_t)ib2), "") == 0);

  memset(_used, 0, sizeof(_used));
  loadTable("not json at all");
  ok &= check("an unparseable blob loads as empty", count() == 0);

  memset(_used, 0, sizeof(_used));
  _open = saved_open;
  Log.notice(F("mqtt_publish_store selfTest overall: %s" CR), ok ? "PASS" : "FAIL");
  return ok;
}
#endif

} // namespace mqtt_publish_store
```

- [ ] **Step 3: Create the host test runner `receiver/test/host/mqtt_publish_store_test.cpp`**

```cpp
#include <stdio.h>

#include "mqtt_publish_store.h"

int main() {
  bool ok = mqtt_publish_store::selfTest();
  printf("mqtt_publish_store selfTest: %s\n", ok ? "PASS" : "FAIL");
  return ok ? 0 : 1;
}
```

- [ ] **Step 4: Wire it into `receiver/test/host/run.sh`**

Append after the `location_store_test` block (after the line `"$out/location_store_test"`):

```sh
g++ -std=c++17 -Wall -Wextra -Werror -DFAKE_SIGNALS -DARDUINOJSON_ENABLE_ARDUINO_STRING=1 \
    -I"$shim" -I"$root" -I"$aj" \
    -o "$out/mqtt_publish_store_test" "$root/mqtt_publish_store.cpp" "$root/test/host/mqtt_publish_store_test.cpp"
"$out/mqtt_publish_store_test"
```

- [ ] **Step 5: Run the host suite and verify it passes**

Run: `cd receiver && ./test/host/run.sh`
Expected: every existing test still prints PASS, and the new line ends with
`mqtt_publish_store selfTest overall: PASS` and exit code 0. If `pio run`
has never been run in `receiver/`, run it once first so `ArduinoJson`'s
headers exist at `.pio/libdeps/esp32s3-generic/ArduinoJson/src` (`run.sh`
checks for this and tells you if it's missing).

- [ ] **Step 6: Update `receiver/docs/architecture.md`'s `mqtt_publish_store` paragraph**

Replace lines 162-168 (the `mqtt_publish_store.h` / `mqtt_publish_store.cpp` paragraph) with:

```
**`mqtt_publish_store.h` / `mqtt_publish_store.cpp`** — persists up to
`MQTT_PUBLISH_SLOTS` (3) dashboard-configured broker url/token pairs to
`Preferences` namespace `"mqtt"`, as one JSON blob under key `"table"` — the
same shape `alias_store`'s 32-slot table uses, for the same reason: NVS keys
are capped at 15 characters, so one key per slot doesn't scale. `add()`
validates the same `mqtt://`/`mqtts://` scheme and length caps the old
single-value `set()` did, updates a slot in place when its url is already
present, and fails with the table full and no matching url. A pre-existing
single `url`/`token` NVS value (from before this table existed) is copied
into slot 0 the first time `begin()` runs against an otherwise-empty table,
then the old keys are removed — a one-time, silent migration. The
`MQTT_BROKER_URL`/`MQTT_TOKEN` build flags are read directly by
`mqtt_publish.cpp`, not through this store; they're a separate, always-on
connection outside the table.
```

- [ ] **Step 7: Commit**

```bash
git add receiver/mqtt_publish_store.h receiver/mqtt_publish_store.cpp \
        receiver/test/host/mqtt_publish_store_test.cpp receiver/test/host/run.sh \
        receiver/docs/architecture.md
git commit -m "feat(receiver): rework mqtt_publish_store into a 3-slot bridge table"
```

---

### Task 2: `mqtt_publish` — one connection per table slot, fan-out publish

**Files:**
- Modify: `receiver/mqtt_publish.h`
- Modify: `receiver/mqtt_publish.cpp`
- Modify: `receiver/docs/architecture.md:170-191`
- Modify: `receiver/docs/backlog.md` (the "Build-time secrets are readable in the firmware image" entry)

**Model:** `sonnet` — translating an existing single-connection pattern into a fixed-size array of connections; judgment-heavy but follows the existing file's shape closely.

**Interfaces:**
- Consumes (from Task 1): `mqtt_publish_store::count()`, `urlAt(i)`, `tokenAt(i)`, `MQTT_PUBLISH_SLOTS`, `MQTT_PUBLISH_STORE_URL_MAX`, `MQTT_PUBLISH_STORE_TOKEN_MAX`.
- Produces (used by Task 3):
  ```cpp
  namespace mqtt_publish {
  void begin(const char* clientId);
  void loop();
  void onRecord(const char* key, JsonDocument& doc);
  void publishLayout(const char* blob);
  void publishLocation(const char* blob);
  void publishTz(int16_t minutes);
  uint8_t     count();               // active connections: table slots + build-flag default
  const char* urlAt(uint8_t i);
  bool        connectedAt(uint8_t i);
  }
  ```

- [ ] **Step 1: Rewrite `receiver/mqtt_publish.h`**

```cpp
#pragma once

#include <ArduinoJson.h>
#include <stdint.h>

namespace mqtt_publish {
// Reads mqtt_publish_store and the MQTT_BROKER_URL/MQTT_TOKEN build flags;
// call once, after WiFi has come up, and again any time the store's table
// changes (see web_ui.cpp's /$mqtt handlers). clientId should be the
// receiver's mDNS hostname, matching the topic segment signal_store keys are
// built with.
void begin(const char* clientId);
// Services every connection's connect/reconnect (backed off by
// MQTT_RECONNECT_BACKOFF_MS) and PubSubClient::loop(). Call every main-loop
// iteration. A no-op when no broker is configured or WiFi is down.
void loop();
// Registered as a signal_store::RecordHook. Publishes doc, retained, to
// topic key, on every connected connection. A no-op (fire-and-forget) when
// no broker is configured; a connection that isn't currently connected is
// simply skipped.
void onRecord(const char* key, JsonDocument& doc);
// Publishes the stored $layout, retained, to <clientId>/$layout, on every
// connected connection. Same fire-and-forget behavior as onRecord.
void publishLayout(const char* blob);
// Publishes the stored $location, retained, to <clientId>/$location, on
// every connected connection. Same fire-and-forget behavior as onRecord.
void publishLocation(const char* blob);
// Publishes the current tz offset, retained, to <clientId>/$tz, on every
// connected connection. Same fire-and-forget behavior as onRecord.
void publishTz(int16_t minutes);
// Active connections: table slots with a valid broker url, plus the
// build-flag default if MQTT_BROKER_URL is set and valid. Used by the
// /$mqtt HTTP endpoint to report status; token is never exposed here.
uint8_t     count();
const char* urlAt(uint8_t i);
bool        connectedAt(uint8_t i);
} // namespace mqtt_publish
```

- [ ] **Step 2: Rewrite `receiver/mqtt_publish.cpp`**

```cpp
#include "mqtt_publish.h"

#include <ArduinoLog.h>
#include <PubSubClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <string.h>
#include <stdlib.h>

#include "layout_store.h"
#include "location_store.h"
#include "mqtt_publish_store.h"
#include "signal_store.h"
#include "tz_store.h"

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

// One entry per active connection: up to MQTT_PUBLISH_SLOTS dashboard-added
// bridges plus the build-flag default. A fixed array, not a dynamic list, so
// PubSubClient::setClient()'s stored reference to plainClient/secureClient
// never dangles across a begin() rebuild.
#define MQTT_PUBLISH_MAX_CONNECTIONS (MQTT_PUBLISH_SLOTS + 1)

struct Connection {
  WiFiClient       plainClient;
  WiFiClientSecure secureClient;
  PubSubClient     mqtt;
  ParsedBroker     broker;
  char             url[MQTT_PUBLISH_STORE_URL_MAX] = "";
  char             token[MQTT_PUBLISH_STORE_TOKEN_MAX] = "";
  bool             enabled = false;
  unsigned long    lastAttempt = 0;
};

static Connection _conn[MQTT_PUBLISH_MAX_CONNECTIONS];
static uint8_t    _connCount = 0;
static char       _clientId[64] = "";

static void setupConnection(Connection& c, const char* url, const char* token) {
  strncpy(c.url, url, sizeof(c.url) - 1);
  c.url[sizeof(c.url) - 1] = '\0';
  c.broker = parseBrokerUrl(url);
  if (!c.broker.valid) {
    Log.warning(F("mqtt publish: broker URL \"%s\" is not a valid mqtt(s)://host:port, skipped" CR), url);
    c.enabled = false;
    return;
  }
  strncpy(c.token, token ? token : "", sizeof(c.token) - 1);
  c.token[sizeof(c.token) - 1] = '\0';

  if (c.broker.tls) {
    c.secureClient.setCACert(ISRG_ROOT_X1);
    c.secureClient.setTimeout(5);
    c.secureClient.setHandshakeTimeout(5);
    c.mqtt.setClient(c.secureClient);
  } else {
    c.mqtt.setClient(c.plainClient);
  }
  c.mqtt.setServer(c.broker.host, c.broker.port);
  // A dead broker must not stall loop(), and with it rf.loop(), for the 15 s
  // PubSubClient default.
  c.mqtt.setSocketTimeout(5);
  c.enabled = true;
  c.lastAttempt = millis() - MQTT_RECONNECT_BACKOFF_MS;
  Log.notice(F("mqtt publish: enabled, broker %s:%u (%s)" CR),
             c.broker.host, c.broker.port, c.broker.tls ? "TLS" : "plain");
}

static void replayAll(Connection& c) {
  uint8_t sent = 0;
  for (uint8_t i = 0; i < SIGNAL_DEVICE_SLOTS; i++) {
    const DeviceSlot* slot = signal_store::slotAt(i);
    if (slot == nullptr) continue;
    const char* payload = signal_store::latestPayload(*slot);
    if (payload == nullptr) continue;
    if (c.mqtt.publish(slot->key, payload, true)) sent++;
  }
  const char* layout = layout_store::get();
  if (layout[0] != '\0') {
    char topic[80];
    int  n = snprintf(topic, sizeof(topic), "%s/$layout", _clientId);
    if (n > 0 && (size_t)n < sizeof(topic) && c.mqtt.publish(topic, layout, true)) sent++;
  }
  const char* location = location_store::get();
  if (location[0] != '\0') {
    char topic[80];
    int  n = snprintf(topic, sizeof(topic), "%s/$location", _clientId);
    if (n > 0 && (size_t)n < sizeof(topic) && c.mqtt.publish(topic, location, true)) sent++;
  }
  {
    char payload[8];
    int  pn = snprintf(payload, sizeof(payload), "%d", tz_store::offsetMinutes());
    if (pn > 0 && (size_t)pn < sizeof(payload)) {
      char topic[80];
      int  n = snprintf(topic, sizeof(topic), "%s/$tz", _clientId);
      if (n > 0 && (size_t)n < sizeof(topic) && c.mqtt.publish(topic, payload, true)) sent++;
    }
  }
  Log.notice(F("mqtt publish: replayed %d retained record(s) to %s on connect" CR), sent, c.broker.host);
}

static bool connectOnce(Connection& c) {
  if (millis() - c.lastAttempt < MQTT_RECONNECT_BACKOFF_MS) return false;
  c.lastAttempt = millis();
  bool ok = c.token[0] != '\0'
                ? c.mqtt.connect(_clientId, "", c.token)
                : c.mqtt.connect(_clientId);
  if (ok) {
    Log.notice(F("mqtt publish: connected to %s:%u" CR), c.broker.host, c.broker.port);
    replayAll(c);
  } else {
    Log.warning(F("mqtt publish: connect to %s:%u failed, state=%d" CR),
                c.broker.host, c.broker.port, c.mqtt.state());
  }
  return ok;
}

void begin(const char* clientId) {
  strncpy(_clientId, clientId, sizeof(_clientId) - 1);
  _clientId[sizeof(_clientId) - 1] = '\0';

  _connCount = 0;
  for (uint8_t i = 0; i < MQTT_PUBLISH_SLOTS; i++) {
    const char* url = mqtt_publish_store::urlAt(i);
    if (url == nullptr) continue;
    setupConnection(_conn[_connCount], url, mqtt_publish_store::tokenAt(i));
    _connCount++;
  }
#ifdef MQTT_BROKER_URL
  setupConnection(_conn[_connCount], MQTT_BROKER_URL,
#ifdef MQTT_TOKEN
                   MQTT_TOKEN
#else
                   ""
#endif
  );
  _connCount++;
#endif
  if (_connCount == 0) {
    Log.notice(F("mqtt publish: no broker configured, disabled" CR));
  }
}

void loop() {
  if (_connCount == 0) return;
  if (WiFi.status() != WL_CONNECTED) return;
  for (uint8_t i = 0; i < _connCount; i++) {
    Connection& c = _conn[i];
    if (!c.enabled) continue;
    if (!c.mqtt.connected()) {
      connectOnce(c);
      continue;
    }
    c.mqtt.loop();
  }
}

void onRecord(const char* key, JsonDocument& doc) {
  if (_connCount == 0) return;
  char   payload[SIGNAL_PAYLOAD_MAX + 1];
  size_t n = serializeJson(doc, payload, sizeof(payload));
  if (n == 0 || n >= sizeof(payload)) return;
  for (uint8_t i = 0; i < _connCount; i++) {
    Connection& c = _conn[i];
    if (c.enabled && c.mqtt.connected()) c.mqtt.publish(key, payload, true);
  }
}

void publishLayout(const char* blob) {
  if (_connCount == 0) return;
  if (blob == nullptr || blob[0] == '\0') return;
  char topic[80];
  int  n = snprintf(topic, sizeof(topic), "%s/$layout", _clientId);
  if (n < 0 || (size_t)n >= sizeof(topic)) return;
  for (uint8_t i = 0; i < _connCount; i++) {
    Connection& c = _conn[i];
    if (c.enabled && c.mqtt.connected()) c.mqtt.publish(topic, blob, true);
  }
}

void publishLocation(const char* blob) {
  if (_connCount == 0) return;
  if (blob == nullptr || blob[0] == '\0') return;
  char topic[80];
  int  n = snprintf(topic, sizeof(topic), "%s/$location", _clientId);
  if (n < 0 || (size_t)n >= sizeof(topic)) return;
  for (uint8_t i = 0; i < _connCount; i++) {
    Connection& c = _conn[i];
    if (c.enabled && c.mqtt.connected()) c.mqtt.publish(topic, blob, true);
  }
}

void publishTz(int16_t minutes) {
  if (_connCount == 0) return;
  char payload[8];
  int  pn = snprintf(payload, sizeof(payload), "%d", minutes);
  if (pn < 0 || (size_t)pn >= sizeof(payload)) return;
  char topic[80];
  int  n = snprintf(topic, sizeof(topic), "%s/$tz", _clientId);
  if (n < 0 || (size_t)n >= sizeof(topic)) return;
  for (uint8_t i = 0; i < _connCount; i++) {
    Connection& c = _conn[i];
    if (c.enabled && c.mqtt.connected()) c.mqtt.publish(topic, payload, true);
  }
}

uint8_t count() { return _connCount; }

const char* urlAt(uint8_t i) { return i < _connCount ? _conn[i].url : nullptr; }

bool connectedAt(uint8_t i) { return i < _connCount && _conn[i].mqtt.connected(); }

} // namespace mqtt_publish
```

- [ ] **Step 3: Build the firmware to confirm it compiles**

Run: `cd receiver && pio run -e esp32s3-generic`
Expected: build succeeds with no new warnings from `mqtt_publish.cpp`.

- [ ] **Step 4: Update `receiver/docs/architecture.md`'s `mqtt_publish` paragraph**

Replace lines 170-191 (the `mqtt_publish.h` / `mqtt_publish.cpp` paragraph, ending "...missed.") with:

```
**`mqtt_publish.h` / `mqtt_publish.cpp`** — publishes every record to up to
four brokers over `PubSubClient`, retained: one connection per
`mqtt_publish_store` table slot, plus the always-on `MQTT_BROKER_URL`
build-flag default as a fourth. Each is a fixed `Connection` (a
`WiFiClient`/`WiFiClientSecure` pair, a `PubSubClient`, and its own backoff
timer) in a compile-time-sized array, never a dynamic list — `PubSubClient`
holds a reference to its client, so a slot's address has to stay stable
across a `begin()` rebuild. `begin()` re-reads the store and rebuilds every
connection from scratch; it's called once at boot and again whenever
`web_ui.cpp`'s `/$mqtt` handlers change the table. Each connection
connects/reconnects and backs off independently, so one broker being
unreachable doesn't stall another. `mqtt://` picks a plain `WiFiClient`,
`mqtts://` a `WiFiClientSecure` with the ISRG Root X1 root CA compiled in —
never `setInsecure()`. `loop()` runs each connected client's
`PubSubClient::loop()` and retries a dropped one no more than once per
`MQTT_RECONNECT_BACKOFF_MS`. Each phase of a connect attempt — TCP connect,
TLS handshake, CONNACK wait — is bounded to 5 s, so an unreachable broker
cannot stall `loop()` — and with it `rf.loop()` draining the decode queue —
indefinitely, though the phases are sequential and a worst case on the TLS
path adds up to roughly 15 s per connection. `MQTT_MAX_PACKET_SIZE` (2200, up
from PubSubClient's 768 default, to fit a full `$layout` blob) is a
permanently allocated buffer per connection, not just a per-message cap, so
it costs roughly 1.4 KB of RAM per active connection for the process
lifetime. `onRecord()`, registered as a second `signal_store` record hook,
publishes the hook's `JsonDocument` unmodified to the topic `key` already
is — `<mdnsHostname()>/<model>/<id>`, since
`signal_store::setSource(mdnsHostname())` is what built that key in the
first place — fanned out to every connected connection. A publish while a
given connection is disconnected is simply skipped on that connection: there
is no retry queue, because every successful (re)connect calls
`replayAll()`, walking `signal_store::slotAt()`/`latestPayload()` to
republish every currently-held record to that connection, which backfills
anything a fire-and-forget publish missed.
```

- [ ] **Step 5: Update `receiver/docs/backlog.md`'s "Build-time secrets are readable in the firmware image" entry**

Find the line referencing `mqtt_publish_store.cpp:42,53` and replace the
`mqtt_publish_store.cpp:42,53` reference with `mqtt_publish.cpp`'s
`setupConnection()` (the build-flag fallback now lives there, read directly
by `mqtt_publish.cpp`'s `begin()` rather than through the store):

```
`load_env.py` passes `WIFI_PASSWORD`, `OTA_TOKEN` and `MQTT_TOKEN` from `.env` to
`platformio.ini` as `-D` string macros, and `ota_token_store.cpp:35` and
`mqtt_publish.cpp`'s `begin()` (the `MQTT_BROKER_URL`/`MQTT_TOKEN` build-flag
default) return them as fallbacks, so the literals link into
`.rodata`. `.env` is gitignored and untracked, so nothing is in git history, but a `.bin`
shared for flashing or an `esptool.py read_flash` on a recovered board yields all three as
plain strings. Provisioning through the portal avoids it; the build-time path does not.
```

- [ ] **Step 6: Commit**

```bash
git add receiver/mqtt_publish.h receiver/mqtt_publish.cpp \
        receiver/docs/architecture.md receiver/docs/backlog.md
git commit -m "feat(receiver): fan mqtt_publish out over one connection per bridge"
```

---

### Task 3: `web_ui.cpp` — `/$mqtt` HTTP endpoint

**Files:**
- Modify: `receiver/web_ui.cpp`
- Modify: `receiver/docs/architecture.md:118-128`
- Modify: `receiver/docs/user-manual.md`

**Model:** `sonnet` — new endpoint following the file's existing handler conventions closely, plus a small deliberate departure (a real `Origin` check) that needs judgment to place correctly.

**Interfaces:**
- Consumes (from Task 1 and Task 2): `mqtt_publish_store::add()`, `remove()`; `mqtt_publish::count()`, `urlAt()`, `connectedAt()`, `begin()`.

- [ ] **Step 1: Add the include**

In `receiver/web_ui.cpp`, after `#include "mqtt_publish.h"` (line 15), add:

```cpp
#include "mqtt_publish_store.h"
```

- [ ] **Step 2: Add the handlers**

In `receiver/web_ui.cpp`, insert the following immediately after `handleTzPost()` ends (after line 427, before the `_otaAuthorized`/`_otaStarted` block):

```cpp
// $mqtt is receiver-local device configuration (which brokers to push to),
// not a topic — unlike $tz/$layout/$location it has no source-prefixed
// form, so a real Origin check stands in for the ownSource convention those
// use: a request with no Origin header (curl, or same-origin) is trusted;
// one with an Origin that doesn't match this receiver's own Host is not.
static bool sameOriginOrBare() {
  String origin = _server.header("Origin");
  if (origin.length() == 0) {
    return true;
  }
  int    schemeEnd  = origin.indexOf("://");
  String originHost = schemeEnd >= 0 ? origin.substring(schemeEnd + 3) : origin;
  return originHost == _server.header("Host");
}

static void handleMqttOptions() {
  sendCors();
  _server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  _server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
  _server.sendHeader("Access-Control-Max-Age", "600");
  _server.send(204, "text/plain", "");
}

static void handleMqttGet() {
  JsonDocument doc;
  JsonArray    arr = doc.to<JsonArray>();
  for (uint8_t i = 0; i < mqtt_publish::count(); i++) {
    JsonObject o = arr.add<JsonObject>();
    o["url"] = mqtt_publish::urlAt(i);
    o["connected"] = mqtt_publish::connectedAt(i);
  }
  String body;
  serializeJson(doc, body);
  sendCors();
  _server.sendHeader("Cache-Control", "no-store");
  _server.send(200, "application/json", body);
}

static void handleMqttPost() {
  if (!sameOriginOrBare()) {
    sendStatus(403, "off-origin");
    return;
  }
  String       body = _server.arg("plain");
  JsonDocument doc;
  if (deserializeJson(doc, body) != DeserializationError::Ok || !doc.is<JsonObject>() ||
      !doc["url"].is<const char*>()) {
    sendStatus(400, "body must be a JSON object with a url");
    return;
  }
  const char* url   = doc["url"];
  const char* token = doc["token"].is<const char*>() ? doc["token"].as<const char*>() : "";
  if (!mqtt_publish_store::add(url, token)) {
    sendStatus(400, "invalid url/token, or the bridge table is full");
    return;
  }
  mqtt_publish::begin(signal_store::source());
  sendCors();
  _server.sendHeader("Cache-Control", "no-store");
  _server.send(204, "text/plain", "");
}

static void handleMqttRemovePost() {
  if (!sameOriginOrBare()) {
    sendStatus(403, "off-origin");
    return;
  }
  String       body = _server.arg("plain");
  JsonDocument doc;
  if (deserializeJson(doc, body) != DeserializationError::Ok || !doc.is<JsonObject>() ||
      !doc["url"].is<const char*>()) {
    sendStatus(400, "body must be a JSON object with a url");
    return;
  }
  const char* url = doc["url"];
  mqtt_publish_store::remove(url); // a url that was never present is not an error
  mqtt_publish::begin(signal_store::source());
  sendCors();
  _server.sendHeader("Cache-Control", "no-store");
  _server.send(204, "text/plain", "");
}
```

- [ ] **Step 3: Register the routes**

In `receiver/web_ui.cpp`'s `begin()` (around line 750), change:

```cpp
void begin() {
  _server.on("/", HTTP_GET, handleRoot);
  _server.on("/events", HTTP_GET, handleEvents);
  _server.on("/$update", HTTP_POST, handleUpdateComplete, handleUpdateUpload);
  // Topics are arbitrary paths, so every other request is dispatched here.
  _server.onNotFound(handleTopic);
```

to:

```cpp
void begin() {
  _server.on("/", HTTP_GET, handleRoot);
  _server.on("/events", HTTP_GET, handleEvents);
  _server.on("/$update", HTTP_POST, handleUpdateComplete, handleUpdateUpload);
  _server.on("/$mqtt", HTTP_GET, handleMqttGet);
  _server.on("/$mqtt", HTTP_POST, handleMqttPost);
  _server.on("/$mqtt", HTTP_OPTIONS, handleMqttOptions);
  _server.on("/$mqtt/remove", HTTP_POST, handleMqttRemovePost);
  _server.on("/$mqtt/remove", HTTP_OPTIONS, handleMqttOptions);
  // Topics are arbitrary paths, so every other request is dispatched here.
  _server.onNotFound(handleTopic);
```

- [ ] **Step 4: Build to confirm it compiles**

Run: `cd receiver && pio run -e esp32s3-generic`
Expected: build succeeds.

- [ ] **Step 5: Update `receiver/docs/architecture.md`'s `web_ui.cpp` paragraph**

In the `web_ui.h` / `web_ui.cpp` paragraph (lines 118-128), change:

```
**`web_ui.h` / `web_ui.cpp`** — the HTTP and SSE surface. `/`, `/events`, and
`/$update` are the only registered routes; every topic is an arbitrary path,
so `GET` and `POST` of a topic are both dispatched from
`WebServer::onNotFound`, which does its own topic validation rather than
relying on route matching. `/$update` is registered directly rather than
routed through the topic parser, since `$update` isn't a topic, and uses
`WebServer::on()`'s two-callback form so the ~1.2 MB firmware image streams
through `Update::write()` in chunks instead of buffering whole. Four SSE
client slots (`WEB_UI_SSE_CLIENTS`), each a `WiFiClient` plus up to four
filters and one replay cursor, are fixed arrays sized at compile time — there
is no dynamic connection list.
```

to:

```
**`web_ui.h` / `web_ui.cpp`** — the HTTP and SSE surface. `/`, `/events`,
`/$update`, and `/$mqtt` (plus `/$mqtt/remove`) are the only registered
routes; every topic is an arbitrary path, so `GET` and `POST` of a topic are
both dispatched from `WebServer::onNotFound`, which does its own topic
validation rather than relying on route matching. `/$update` and `/$mqtt`
are registered directly rather than routed through the topic parser, since
neither is a topic. `/$update` uses `WebServer::on()`'s two-callback form so
the ~1.2 MB firmware image streams through `Update::write()` in chunks
instead of buffering whole. `/$mqtt` reports `mqtt_publish`'s active
connections (url and connect state, never the token) and lets a `POST` add
or update a bridge and a `POST /$mqtt/remove` drop one; both mutating routes
check the request's `Origin` header against the receiver's own `Host` rather
than using the bare-path-or-own-source convention `$tz`/`$layout`/`$location`
use, since `$mqtt` has no source-prefixed form to compare against. Four SSE
client slots (`WEB_UI_SSE_CLIENTS`), each a `WiFiClient` plus up to four
filters and one replay cursor, are fixed arrays sized at compile time — there
is no dynamic connection list.
```

- [ ] **Step 6: Update `receiver/docs/user-manual.md`**

In the routes table (around line 41-48), add a row after the `/$tz` row:

```
| `POST /$mqtt` | Add or update a bridge to push to. Body `{"url":"...","token":"..."}`. `204` on success, `400` on an invalid url/token or a full table, `403` off-origin |
| `GET /$mqtt` | This receiver's active push connections. `200`, `application/json`: `[{"url":"...","connected":true}, ...]` — never the token |
| `POST /$mqtt/remove` | Stop pushing to a bridge. Body `{"url":"..."}`. `204` on success, including if the url wasn't present; `403` off-origin |
```

Then replace the "## Publishing to a remote broker" section (lines 25-37) with:

```
## Publishing to a remote broker

The receiver can push every record, retained, to up to four MQTT brokers at
once: three configured from the dashboard's Settings tab (see below) plus
one always-on default from the `MQTT_BROKER_URL`/`MQTT_TOKEN` build flags
(`.env`) — off by default. The topic is the same key the receiver stores it
under locally, `<mdnsHostname()>/<model>/<id>`, and the payload is the
identical JSON `GET /<topic>` would return. A broker's token, if set, is
sent as the CONNECT password; a broker on the LAN often needs none.
Publishing is fire-and-forget per connection — a record that arrives while
a given broker is disconnected is simply not published to it — but every
successful connect or reconnect republishes everything currently held to
that broker, so one that was briefly unreachable catches back up without
waiting for each device's next natural transmission. One broker being
unreachable doesn't affect any other.

Add, update, or remove a bridge from the dashboard's Settings tab (see
`../../dashboard/docs/user-manual.md`'s "Bridges" section), or directly via
`POST /$mqtt` / `POST /$mqtt/remove` above. There's no way to edit a stored
token without re-adding the bridge; posting an already-known url updates its
token in place.
```

- [ ] **Step 7: Commit**

```bash
git add receiver/web_ui.cpp receiver/docs/architecture.md receiver/docs/user-manual.md
git commit -m "feat(receiver): serve /\$mqtt so the dashboard can manage push bridges"
```

---

### Task 4: `provisioning.cpp` — drop the MQTT fields

**Files:**
- Modify: `receiver/provisioning.cpp`
- Modify: `receiver/docs/install.md:71-78`
- Modify: `receiver/docs/user-manual.md` (the boot-flow paragraph mentioning the portal)

**Model:** `haiku` — mechanical removal of fields and validation exactly spelled out below; no new logic.

**Interfaces:**
- Consumes (from Task 1): none directly — this task removes the only remaining caller of the old `mqtt_publish_store::set()`-shaped API, and no longer includes `mqtt_publish_store.h` at all.

- [ ] **Step 1: Remove the include**

In `receiver/provisioning.cpp`, delete this line (line 9):

```cpp
#include "mqtt_publish_store.h"
```

- [ ] **Step 2: Remove the MQTT fields from the portal page**

In `handleRoot()`, change:

```cpp
      "\"><button type=\"button\" onclick=\"copyToken()\">Copy</button></label><br><br>"
      "<label>MQTT broker URL (optional)<br>"
      "<input type=\"text\" name=\"mqtt_url\" maxlength=\"127\" "
      "placeholder=\"mqtts://weather.rkroll.com:8883\"></label><br><br>"
      "<label>MQTT broker token (optional)<br>"
      "<input type=\"text\" name=\"mqtt_token\" maxlength=\"64\"></label><br><br>"
      "<button type=\"submit\">Save and connect</button>"
```

to:

```cpp
      "\"><button type=\"button\" onclick=\"copyToken()\">Copy</button></label><br><br>"
      "<button type=\"submit\">Save and connect</button>"
```

- [ ] **Step 3: Remove the MQTT handling from `handleSave()`**

In `handleSave()`, change:

```cpp
  String token = _server.arg("token");
  token.trim();
  String mqttUrl = _server.arg("mqtt_url");
  mqttUrl.trim();
  String mqttToken = _server.arg("mqtt_token");
  mqttToken.trim();
```

to:

```cpp
  String token = _server.arg("token");
  token.trim();
```

Then change:

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

to:

```cpp
  if (token.length() >= OTA_TOKEN_STORE_MAX) {
    _server.send(400, "text/plain", "Update token is too long.");
    return;
  }
```

Then change:

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

  _server.send(200, "text/html",
```

to:

```cpp
  if (token.length() > 0 && !ota_token_store::set(token.c_str())) {
    // Non-fatal: WiFi is the essential part of this form. A failed token
    // save just leaves OTA on its prior token (stored, or .env), same as
    // leaving the field blank.
    Log.warning(F("provisioning: could not store update token" CR));
  }

  _server.send(200, "text/html",
```

- [ ] **Step 4: Build to confirm it compiles**

Run: `cd receiver && pio run -e esp32s3-generic`
Expected: build succeeds; no leftover references to `mqtt_publish_store` in `provisioning.cpp`.

Run: `grep -n mqtt_publish_store receiver/provisioning.cpp`
Expected: no output.

- [ ] **Step 5: Update `receiver/docs/install.md`**

Replace lines 71-78:

```
`MQTT_BROKER_URL` and `MQTT_TOKEN` are optional and off by default: setting
neither leaves the device publishing nothing. Set `MQTT_BROKER_URL` to
publish every record, retained, to a remote broker — `mqtt://host:port` for
a plaintext LAN broker (Mosquitto, Home Assistant), `mqtts://host:port` for
a public one, like `weather.rkroll.com`'s embedded bridge broker (see
`../../bridge/docs/install.md`'s `AUTH_TOKEN`), which requires `MQTT_TOKEN`
to match. Both are overridden the moment they're saved through the
provisioning portal, same as `OTA_TOKEN`.
```

with:

```
`MQTT_BROKER_URL` and `MQTT_TOKEN` are optional and off by default: setting
neither leaves the device publishing nothing through this build-flag path.
Set `MQTT_BROKER_URL` to publish every record, retained, to a remote broker
— `mqtt://host:port` for a plaintext LAN broker (Mosquitto, Home Assistant),
`mqtts://host:port` for a public one, like `weather.rkroll.com`'s embedded
bridge broker (see `../../bridge/docs/install.md`'s `AUTH_TOKEN`), which
requires `MQTT_TOKEN` to match. Unlike `OTA_TOKEN`, these aren't settable
through the provisioning portal — the portal is WiFi credentials and the OTA
token only. Add, change, or remove up to three more bridges from the
dashboard's Settings tab once the device is on the network (see
`docs/user-manual.md`'s "Publishing to a remote broker"); the build-flag
broker keeps running alongside them and can't be removed from the
dashboard.
```

- [ ] **Step 6: Update `receiver/docs/user-manual.md`'s boot-flow section**

No change needed if the boot-flow paragraph (lines 9-19) doesn't mention
MQTT fields — confirm with:

Run: `grep -n mqtt receiver/docs/user-manual.md`
Expected: only the "Publishing to a remote broker" section and the routes
table (already updated in Task 3) mention it; if the boot-flow paragraph
also references the portal collecting MQTT fields, remove that mention the
same way.

- [ ] **Step 7: Commit**

```bash
git add receiver/provisioning.cpp receiver/docs/install.md
git commit -m "feat(receiver): drop MQTT fields from the provisioning portal"
```

---

### Task 5: `dashboard/src/bridges.js` — bridge list state and HTTP calls

**Files:**
- Create: `dashboard/src/bridges.js`
- Create: `dashboard/test/bridges.test.js`

**Model:** `sonnet` — new module mirroring `sources.js`'s shape but reversed (network state, not `localStorage`), requiring judgment about async/error handling, not verbatim transcription.

**Interfaces:**
- Produces (used by Task 6):
  ```js
  export const bridges = signal(null) // null = unknown/unavailable, [] = loaded and empty, array of {url, connected}
  export async function loadBridges()
  export async function addBridge(url, token)   // token may be '' or omitted
  export async function removeBridge(url)
  ```

- [ ] **Step 1: Write the failing test `dashboard/test/bridges.test.js`**

```js
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import * as br from '../src/bridges.js'

function fakeFetch(responses) {
  const calls = []
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts })
    const key = `${(opts && opts.method) || 'GET'} ${url}`
    const r = responses[key]
    if (!r) throw new Error(`unexpected fetch ${key}`)
    if (r.throws) throw new Error('network error')
    return { ok: r.ok, status: r.status || (r.ok ? 200 : 500), json: async () => r.body }
  }
  return calls
}

beforeEach(() => {
  globalThis.location = { origin: 'http://receiver.local' }
  br.bridges.value = null
})

test('loadBridges populates the list from a 200', async () => {
  fakeFetch({
    'GET http://receiver.local/$mqtt': { ok: true, body: [{ url: 'mqtts://a:8883', connected: true }] },
  })
  await br.loadBridges()
  assert.deepEqual(br.bridges.value, [{ url: 'mqtts://a:8883', connected: true }])
})

test('loadBridges leaves the list null on a 404', async () => {
  fakeFetch({ 'GET http://receiver.local/$mqtt': { ok: false, status: 404 } })
  await br.loadBridges()
  assert.equal(br.bridges.value, null)
})

test('loadBridges leaves the list null on a network error', async () => {
  fakeFetch({ 'GET http://receiver.local/$mqtt': { throws: true } })
  await br.loadBridges()
  assert.equal(br.bridges.value, null)
})

test('loadBridges treats a non-array body as unavailable', async () => {
  fakeFetch({ 'GET http://receiver.local/$mqtt': { ok: true, body: { not: 'an array' } } })
  await br.loadBridges()
  assert.equal(br.bridges.value, null)
})

test('addBridge posts the url and token, then reloads', async () => {
  const calls = fakeFetch({
    'POST http://receiver.local/$mqtt': { ok: true },
    'GET http://receiver.local/$mqtt': { ok: true, body: [{ url: 'mqtt://b:1883', connected: false }] },
  })
  const ok = await br.addBridge('mqtt://b:1883', 'tok')
  assert.equal(ok, true)
  assert.deepEqual(br.bridges.value, [{ url: 'mqtt://b:1883', connected: false }])
  const post = calls.find(c => c.opts && c.opts.method === 'POST' && c.url.endsWith('/$mqtt'))
  assert.deepEqual(JSON.parse(post.opts.body), { url: 'mqtt://b:1883', token: 'tok' })
})

test('addBridge defaults a missing token to an empty string', async () => {
  const calls = fakeFetch({
    'POST http://receiver.local/$mqtt': { ok: true },
    'GET http://receiver.local/$mqtt': { ok: true, body: [] },
  })
  await br.addBridge('mqtt://b:1883')
  const post = calls.find(c => c.opts && c.opts.method === 'POST' && c.url.endsWith('/$mqtt'))
  assert.deepEqual(JSON.parse(post.opts.body), { url: 'mqtt://b:1883', token: '' })
})

test('addBridge reports failure on a non-ok response and does not reload', async () => {
  const calls = fakeFetch({ 'POST http://receiver.local/$mqtt': { ok: false, status: 400 } })
  const ok = await br.addBridge('not a url', '')
  assert.equal(ok, false)
  assert.equal(calls.length, 1)
})

test('addBridge reports failure on a network error', async () => {
  fakeFetch({ 'POST http://receiver.local/$mqtt': { throws: true } })
  const ok = await br.addBridge('mqtt://b:1883', '')
  assert.equal(ok, false)
})

test('removeBridge posts the url to /$mqtt/remove, then reloads', async () => {
  const calls = fakeFetch({
    'POST http://receiver.local/$mqtt/remove': { ok: true },
    'GET http://receiver.local/$mqtt': { ok: true, body: [] },
  })
  const ok = await br.removeBridge('mqtt://b:1883')
  assert.equal(ok, true)
  assert.deepEqual(br.bridges.value, [])
  const post = calls.find(c => c.url.endsWith('/$mqtt/remove'))
  assert.deepEqual(JSON.parse(post.opts.body), { url: 'mqtt://b:1883' })
})

test('removeBridge reports failure on a non-ok response', async () => {
  const calls = fakeFetch({ 'POST http://receiver.local/$mqtt/remove': { ok: false, status: 500 } })
  const ok = await br.removeBridge('mqtt://b:1883')
  assert.equal(ok, false)
  assert.equal(calls.length, 1)
})

test('removeBridge reports failure on a network error', async () => {
  fakeFetch({ 'POST http://receiver.local/$mqtt/remove': { throws: true } })
  const ok = await br.removeBridge('mqtt://b:1883')
  assert.equal(ok, false)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd dashboard && node --test test/bridges.test.js`
Expected: FAIL — `Cannot find module '../src/bridges.js'`.

- [ ] **Step 3: Write `dashboard/src/bridges.js`**

```js
import { signal } from '@preact/signals'

// null = not yet loaded, or /$mqtt isn't served here (e.g. the standalone
// bridge). [] = loaded and there are none configured. Never mixed with
// localStorage: this mirrors the receiver's own table, there's nothing to
// cache client-side.
export const bridges = signal(null)

export async function loadBridges() {
  try {
    const res = await fetch(`${location.origin}/$mqtt`)
    if (!res.ok) { bridges.value = null; return }
    const list = await res.json()
    bridges.value = Array.isArray(list) ? list : null
  } catch (e) {
    bridges.value = null
  }
}

export async function addBridge(url, token) {
  try {
    const res = await fetch(`${location.origin}/$mqtt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, token: token || '' }),
    })
    if (!res.ok) return false
  } catch (e) {
    return false
  }
  await loadBridges()
  return true
}

export async function removeBridge(url) {
  try {
    const res = await fetch(`${location.origin}/$mqtt/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    })
    if (!res.ok) return false
  } catch (e) {
    return false
  }
  await loadBridges()
  return true
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd dashboard && node --test test/bridges.test.js`
Expected: PASS, all cases green.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/bridges.js dashboard/test/bridges.test.js
git commit -m "feat(dashboard): add bridges.js, the reverse of sources.js"
```

---

### Task 6: `dashboard/src/bridges.jsx` — Bridges panel, wired into Settings

**Files:**
- Create: `dashboard/src/bridges.jsx`
- Modify: `dashboard/src/settings.jsx`
- Modify: `dashboard/src/main.jsx`
- Modify: `dashboard/docs/architecture.md`
- Modify: `dashboard/docs/user-manual.md`

**Model:** `sonnet` — new Preact component following `sources.jsx`'s established list/form pattern.

**Interfaces:**
- Consumes (from Task 5): `bridges` signal, `addBridge(url, token)`, `removeBridge(url)`, `loadBridges()`.

- [ ] **Step 1: Write `dashboard/src/bridges.jsx`**

```jsx
import { bridges, addBridge, removeBridge } from './bridges.js'

export function BridgesView() {
  if (bridges.value === null) return null
  return (
    <>
      <ul id="bridge-list">
        {bridges.value.map(b => (
          <li key={b.url}>
            <span class="dot" data-state={b.connected ? 'connected' : 'connecting'} />
            <span class="url">{b.url}</span>
            <button class="rm" title={`Remove ${b.url}`} onClick={() => removeBridge(b.url)}>✕</button>
          </li>
        ))}
      </ul>
      <BridgeForm />
    </>
  )
}

function BridgeForm() {
  let urlInput, tokenInput
  return (
    <form id="bridge-form" onSubmit={async (ev) => {
      ev.preventDefault()
      const ok = await addBridge(urlInput.value, tokenInput.value)
      if (!ok) {
        urlInput.setAttribute('aria-invalid', 'true')
        return
      }
      urlInput.removeAttribute('aria-invalid')
      urlInput.value = ''
      tokenInput.value = ''
    }}>
      <input
        id="bridge-url"
        type="text"
        placeholder="mqtts://weather.rkroll.com:8883"
        aria-label="Bridge broker URL"
        ref={(el) => { urlInput = el }}
        onInput={() => urlInput.removeAttribute('aria-invalid')}
      />
      <input
        id="bridge-token"
        type="text"
        placeholder="token (optional)"
        aria-label="Bridge broker token"
        ref={(el) => { tokenInput = el }}
      />
      <button id="bridge-add" type="submit">Add</button>
    </form>
  )
}
```

- [ ] **Step 2: Wire it into `dashboard/src/settings.jsx`**

Change the imports:

```js
import { settings, setUnits, setDecimals, setCustomField } from './settings.js'
import { LocationView } from './location.jsx'
import { SourcesView } from './sources.jsx'
```

to:

```js
import { settings, setUnits, setDecimals, setCustomField } from './settings.js'
import { LocationView } from './location.jsx'
import { SourcesView } from './sources.jsx'
import { BridgesView } from './bridges.jsx'
```

Change:

```jsx
      <LocationView />
      <div id="settings-sources">
        <SourcesView />
      </div>
    </div>
  )
}
```

to:

```jsx
      <LocationView />
      <div id="settings-sources">
        <SourcesView />
      </div>
      <div id="settings-bridges">
        <BridgesView />
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Load the bridge list at boot, in `dashboard/src/main.jsx`**

Change the `sources.js` import:

```js
import { sources, sourceState, loadSources, setSourcesChanged, storageState, addSource,
         setSourceState } from './sources.js'
```

to also import `loadBridges`:

```js
import { sources, sourceState, loadSources, setSourcesChanged, storageState, addSource,
         setSourceState } from './sources.js'
import { loadBridges } from './bridges.js'
```

Change:

```js
loadSort()
loadSources()
loadSettings()
```

to:

```js
loadSort()
loadSources()
loadBridges()
loadSettings()
```

- [ ] **Step 4: Build the dashboard and run its test suite**

Run: `cd dashboard && node build.js && node --test test/*.test.js`
Expected: build succeeds; all `node:test` files pass, including
`bridges.test.js`.

- [ ] **Step 5: Update `dashboard/docs/architecture.md`**

In the module table (around line 16), after the `sources.js` row:

```
| `sources.js` | the source list and its storage |
```

add:

```
| `bridges.js` | the receiver's MQTT push-bridge list, fetched from `/$mqtt`, and its mutations |
```

After the "## Sources" section (ending "...the suite exercises the real HTTP binding rather than a model of it." — i.e. before "## Tests" if `bridges.js` is documented as its own section, or right after "## Sources" ends, around line 276), add:

```
## Bridges

The reverse of Sources: `bridges.js` fetches `GET /$mqtt` against
`location.origin` and shows what this receiver currently pushes to, never
`localStorage` — there's nothing to cache, the receiver's own table is the
only copy. Adding or removing a bridge `POST`s to `/$mqtt` or
`/$mqtt/remove` and refetches. If `/$mqtt` isn't served here (the standalone
bridge, or a dashboard opened before the receiver's boot finished), the
panel renders nothing, the same as `LocationView`'s `$tz`/`$location` POSTs
being silently origin-gated today.
```

- [ ] **Step 6: Update `dashboard/docs/user-manual.md`**

After the "## Sources" section (ending "...which the scan won't find."), add:

```
## Bridges

The Settings tab also shows the receiver's own MQTT push targets — where
*this* receiver sends its readings, the reverse of Sources' list of places
it reads from. Add a broker URL (`mqtt://host:port` or
`mqtts://host:port`) and an optional token, up to three at a time; a dot
shows whether each is currently connected. Removing one stops that push
immediately. This panel only appears when the dashboard is served by a
receiver — a standalone bridge or a dashboard build with no `/$mqtt` shows
nothing here. There's no way to see or edit a stored token; re-adding the
same url with a new token replaces it.
```

- [ ] **Step 7: Commit**

```bash
git add dashboard/src/bridges.jsx dashboard/src/settings.jsx dashboard/src/main.jsx \
        dashboard/docs/architecture.md dashboard/docs/user-manual.md
git commit -m "feat(dashboard): add a Bridges panel to Settings"
```

---

### Task 7: Full verification, docs cleanup, remove the spec and this plan

**Files:**
- Delete: `docs/superpowers/specs/2026-08-22-mqtt-push-bridges-design.md`
- Delete: `docs/superpowers/plans/2026-08-22-mqtt-push-bridges.md` (this file)

**Model:** `sonnet` — final whole-feature verification and a bit of judgment on whether anything else references the removed portal fields.

**Interfaces:** none — this task only verifies and cleans up.

- [ ] **Step 1: Run the full receiver host suite**

Run: `cd receiver && ./test/host/run.sh`
Expected: every test prints PASS, exit code 0.

- [ ] **Step 2: Build the firmware**

Run: `cd receiver && pio run -e esp32s3-generic`
Expected: build succeeds.

- [ ] **Step 3: Run the full dashboard unit suite**

Run: `cd dashboard && node --test test/*.test.js`
Expected: all tests pass, including `bridges.test.js` and the unaffected
`sources.test.js`.

- [ ] **Step 4: Grep for any leftover references to the removed single-value API**

Run: `grep -rn "mqtt_publish_store::set\|mqtt_publish_store::hasBroker\|mqtt_publish_store::brokerUrl\|mqtt_publish_store::token(" receiver/ --include=*.cpp --include=*.h`
Expected: no output — every caller now uses the new table API or is gone
(`provisioning.cpp` no longer calls into `mqtt_publish_store` at all).

- [ ] **Step 5: Delete the spec and this plan**

Their content is folded into `receiver/docs/architecture.md`,
`receiver/docs/user-manual.md`, `receiver/docs/install.md`,
`dashboard/docs/architecture.md`, and `dashboard/docs/user-manual.md` by the
tasks above.

```bash
git rm docs/superpowers/specs/2026-08-22-mqtt-push-bridges-design.md \
       docs/superpowers/plans/2026-08-22-mqtt-push-bridges.md
```

- [ ] **Step 6: Commit**

```bash
git commit -m "chore: fold the multi-bridge MQTT push spec and plan into the permanent docs"
```
