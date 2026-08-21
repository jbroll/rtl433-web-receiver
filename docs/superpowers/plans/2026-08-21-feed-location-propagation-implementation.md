# Feed location/timezone propagation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `$location` and `$tz` a full round trip (NVS → MQTT publish → GET → SSE broadcast → dashboard subscribe), the same pattern `$layout` already has, so feed cards (Weather/Sun/Moon/Clock) and the receiver's own timezone work when the dashboard is loaded from a different origin than the receiver (e.g. from the bridge).

**Architecture:** Receiver gets a new `location_store` module (mirrors `layout_store`: one opaque JSON blob in NVS) and `tz_store` gains the publish/broadcast triggering `layout_store::set()` already has. Both round-trip through the same topic-dispatch, MQTT-publish, and SSE-broadcast machinery `$layout` uses. The dashboard gains a `Map<sourceBase, value>` for each (mirroring `layouts`), consulted only as a fallback behind `localStorage` — never written into it.

**Tech Stack:** C++ (ESP32 firmware, ArduinoJson, Preferences/NVS), Preact + `@preact/signals` (dashboard), Node `node:test` (unit tests), Playwright (dashboard e2e, receiver binding spec).

## Global Constraints

- New NVS namespace: `"location"`. Blob cap: `LOCATION_STORE_MAX 512` (mirrors `layout_store.h`'s `LAYOUT_STORE_MAX`, sized for `{lat,lon,label,zone,zoom}` rather than a layout template).
- The receiver never inspects the shape of the `$location` JSON — same "opaque blob" contract `$layout` has. `location_store::set()` only checks it's non-NULL, non-empty, and under the cap.
- Same-origin/bare-topic gating for POST: accept bare `$location` (or `$tz`) *or* `<own-source>/$location` (`<own-source>/$tz`); anything else is `405`. This is `handleLayoutPost`'s existing `strcmp(path, "$layout") != 0 && !ownSource` check, copied verbatim for the new handler.
- `$tz`'s payload is always present after boot (`tz_store::offsetMinutes()` defaults to `-240`), so `GET /$tz` must never `404`. `$location` and `$layout` payloads are empty until first set, so their `GET` is `404` until then.
- Replay-cursor and broadcast index convention (`web_ui.cpp`): layout is index `SIGNAL_SUB_TABLE + ALIAS_SLOTS`. Location is `+ 1`, tz is `+ 2`. Do not renumber the existing layout index.
- Dashboard: the fallback resolution order is (1) `localStorage` if a value is already set there — unchanged, always wins; (2) the first source in `sources.value` order that has published one. The fallback is resolution-only: never write a network-derived value into `localStorage`.
- Dashboard write gating: `setLocation()`'s POSTs (`/$tz` and the new `/$location`) fire only when `sources.value.includes(location.origin)` — the same gate `app.jsx` already uses to show/hide the "Save as default layout" button — **and** `hasLocation()` is true (existing behavior for `/$tz`, preserved).
- No UI for viewing/editing which source "owns" the published location (out of scope, matches `$layout`). No per-feed enable/disable toggle (out of scope). No change to `$layout` itself.

---

### Task 1: `location_store` (receiver)

**Files:**
- Create: `receiver/location_store.h`
- Create: `receiver/location_store.cpp`
- Create: `receiver/test/host/location_store_test.cpp`
- Modify: `receiver/test/host/run.sh`

**Model:** `haiku` — transcription of `layout_store` with renamed constants; complete code given below.

**Interfaces:**
- Produces: `location_store::begin() -> bool`, `location_store::get() -> const char*` (never NULL, `""` when unset), `location_store::set(const char* json) -> bool`, `location_store::selfTest() -> bool` (under `FAKE_SIGNALS`).

- [ ] **Step 1: Write `location_store.h`**

```cpp
#pragma once

#include <Arduino.h>

// A location is one JSON object for the whole receiver (unlike alias_store's
// per-topic table), so it is one NVS entry holding the blob verbatim rather
// than a table serialized to/from JSON at persist time. Same storage shape as
// layout_store, sized for {lat,lon,label,zone,zoom} rather than a layout
// template.
#define LOCATION_STORE_MAX 512

namespace location_store {
bool        begin();
// Never NULL; "" when nothing is stored.
const char* get();
bool        set(const char* json);
#ifdef FAKE_SIGNALS
bool selfTest();
#endif
} // namespace location_store
```

- [ ] **Step 2: Write `location_store.cpp`**

```cpp
#include "location_store.h"

#include <ArduinoLog.h>
#include <Preferences.h>
#include <string.h>

namespace location_store {

static Preferences _prefs;
static bool        _open = false;
static char        _blob[LOCATION_STORE_MAX] = "";

bool begin() {
  _blob[0] = '\0';
  _open = _prefs.begin("location", false);
  if (!_open) {
    Log.warning(F("location store: NVS unavailable, location will not persist" CR));
    return false;
  }
  String stored = _prefs.getString("blob", "");
  strncpy(_blob, stored.c_str(), sizeof(_blob) - 1);
  _blob[sizeof(_blob) - 1] = '\0';
  Log.notice(F("location store: %s" CR), _blob[0] ? "location loaded" : "no stored location");
  return true;
}

const char* get() { return _blob; }

bool set(const char* json) {
  if (json == NULL || *json == '\0' || strlen(json) >= LOCATION_STORE_MAX) {
    return false;
  }
  char previous[LOCATION_STORE_MAX];
  strncpy(previous, _blob, sizeof(previous) - 1);
  previous[sizeof(previous) - 1] = '\0';
  strncpy(_blob, json, sizeof(_blob) - 1);
  _blob[sizeof(_blob) - 1] = '\0';
  if (!_open) {
    // A receiver whose NVS won't open should still let a viewer save a
    // location for the session rather than answer 503 to every save.
    return true;
  }
  if (_prefs.putString("blob", _blob) > 0) {
    return true;
  }
  strncpy(_blob, previous, sizeof(_blob) - 1);
  _blob[sizeof(_blob) - 1] = '\0';
  return false;
}

#ifdef FAKE_SIGNALS
static bool check(const char* what, bool ok) {
  Log.notice(F("location selfTest %s: %s" CR), what, ok ? "PASS" : "FAIL");
  return ok;
}

bool selfTest() {
  bool ok = true;

  // Suppress NVS traffic across the set() calls below; set() checks the
  // size cap before its _open check, so the cap tests still work.
  bool saved_open = _open;
  _open           = false;

  _blob[0] = '\0';
  ok &= check("nothing stored reads as empty", strcmp(get(), "") == 0);

  ok &= check("set stores a blob",
              set("{\"lat\":40.015,\"lon\":-105.2705,\"label\":\"Boulder\",\"zone\":\"America/Denver\",\"zoom\":12}"));
  ok &= check("get returns the stored blob",
              strcmp(get(), "{\"lat\":40.015,\"lon\":-105.2705,\"label\":\"Boulder\",\"zone\":\"America/Denver\",\"zoom\":12}") == 0);

  ok &= check("set of a new blob replaces in place",
              set("{\"lat\":0,\"lon\":0,\"label\":\"\",\"zone\":\"\",\"zoom\":11}") &&
                  strcmp(get(), "{\"lat\":0,\"lon\":0,\"label\":\"\",\"zone\":\"\",\"zoom\":11}") == 0);

  ok &= check("a NULL blob is rejected", !set(NULL));
  ok &= check("an empty blob is rejected", !set(""));
  ok &= check("a rejected set leaves the stored blob alone",
              strcmp(get(), "{\"lat\":0,\"lon\":0,\"label\":\"\",\"zone\":\"\",\"zoom\":11}") == 0);

  char big[LOCATION_STORE_MAX + 1];
  memset(big, '.', sizeof(big) - 1);
  big[sizeof(big) - 1] = '\0';
  ok &= check("a blob at or over the cap is rejected", !set(big));
  ok &= check("a rejected oversized set leaves the stored blob alone",
              strcmp(get(), "{\"lat\":0,\"lon\":0,\"label\":\"\",\"zone\":\"\",\"zoom\":11}") == 0);

  _blob[0] = '\0';
  _open    = saved_open;
  Log.notice(F("location selfTest overall: %s" CR), ok ? "PASS" : "FAIL");
  return ok;
}
#endif

} // namespace location_store
```

- [ ] **Step 3: Write `receiver/test/host/location_store_test.cpp`**

```cpp
#include <stdio.h>

#include "location_store.h"

int main() {
  bool ok = location_store::selfTest();
  printf("location_store selfTest: %s\n", ok ? "PASS" : "FAIL");
  return ok ? 0 : 1;
}
```

- [ ] **Step 4: Add the build+run line to `receiver/test/host/run.sh`**

Append this block at the end of the file (after the existing `layout_store_test` block):

```sh
g++ -std=c++17 -Wall -Wextra -Werror -DFAKE_SIGNALS -DARDUINOJSON_ENABLE_ARDUINO_STRING=1 \
    -I"$shim" -I"$root" \
    -o "$out/location_store_test" "$root/location_store.cpp" "$root/test/host/location_store_test.cpp"
"$out/location_store_test"
```

- [ ] **Step 5: Run the host suite**

Run: `bash receiver/test/host/run.sh`
Expected: every existing check still `PASS`, plus 9 new `location selfTest ...: PASS` lines and `location_store selfTest: PASS`.

- [ ] **Step 6: Commit**

```bash
git add receiver/location_store.h receiver/location_store.cpp \
        receiver/test/host/location_store_test.cpp receiver/test/host/run.sh
git commit -m "feat(receiver): add location_store, mirroring layout_store"
```

---

### Task 2: `topic::isLocation` (receiver)

**Files:**
- Modify: `receiver/topic.h`
- Modify: `receiver/topic.cpp`
- Modify: `receiver/test/host/topic_test.cpp`

**Model:** `haiku` — one function, mirrors `isLayout` exactly, complete code given.

**Interfaces:**
- Produces: `topic::isLocation(const char* topic) -> bool` — true iff the last `/`-segment is `$location`.

- [ ] **Step 1: Add the declaration to `topic.h`**

In `receiver/topic.h`, add `bool isLocation(const char* topic);` after `bool isLayout(const char* topic);`:

```cpp
bool isAlias(const char* topic);
bool isTz(const char* topic);
bool isLayout(const char* topic);
bool isLocation(const char* topic);
} // namespace topic
```

- [ ] **Step 2: Add the implementation to `topic.cpp`**

In `receiver/topic.cpp`, add after `isLayout`:

```cpp
bool isLocation(const char* t) {
  if (t == NULL) return false;
  const char* last = strrchr(t, '/');
  return strcmp(last != NULL ? last + 1 : t, "$location") == 0;
}
```

- [ ] **Step 3: Add test cases to `receiver/test/host/topic_test.cpp`**

After the existing `isLayout` block (the four `check(...)` calls ending `check("isLayout rejects NULL", ...)`), add:

```cpp
  check("isLocation identifies a $location topic", topic::isLocation("rtl433-a1b2c3/$location"));
  check("a bare $location is a location topic", topic::isLocation("$location"));
  check("isLocation rejects a non-$location topic", !topic::isLocation("rtl433-a1b2c3/Acurite-5n1/1234"));
  check("isLocation rejects NULL", !topic::isLocation(NULL));
```

- [ ] **Step 4: Run the host suite**

Run: `bash receiver/test/host/run.sh`
Expected: all prior checks still `PASS`, plus the four new `isLocation ...` lines `PASS`, and `topic: PASS`.

- [ ] **Step 5: Commit**

```bash
git add receiver/topic.h receiver/topic.cpp receiver/test/host/topic_test.cpp
git commit -m "feat(receiver): add topic::isLocation"
```

---

### Task 3: `mqtt_publish.cpp`/`.h` — publish `$location` and `$tz` (receiver)

**Files:**
- Modify: `receiver/mqtt_publish.h`
- Modify: `receiver/mqtt_publish.cpp`

**Model:** `sonnet` — mirrors `publishLayout` but touches two files and `replayAll()`'s reconnect logic; small but requires care not to break the existing device/layout replay.

**Interfaces:**
- Consumes: `location_store::get() -> const char*` (Task 1), `tz_store::offsetMinutes() -> int16_t` (existing).
- Produces: `mqtt_publish::publishLocation(const char* blob)`, `mqtt_publish::publishTz(int16_t minutes)` — called from Task 4's `handleLocationPost`/`handleTzPost`. This task must land before Task 4, which calls both.

- [ ] **Step 1: Add the declarations to `mqtt_publish.h`**

In `receiver/mqtt_publish.h`, add after the `publishLayout` declaration:

```cpp
// Publishes the stored $location, retained, to <clientId>/$location. A no-op
// (fire-and-forget) if not currently connected, the same as publishLayout.
void publishLocation(const char* blob);
// Publishes the current tz offset, retained, to <clientId>/$tz. A no-op
// (fire-and-forget) if not currently connected, the same as publishLayout.
void publishTz(int16_t minutes);
```

`mqtt_publish.h` needs `int16_t`; add `#include <stdint.h>` alongside the existing `#include <ArduinoJson.h>` if it isn't already pulled in transitively (it is not — add it explicitly).

- [ ] **Step 2: Add the includes and functions to `mqtt_publish.cpp`**

Add to the include block (alphabetical with the existing list):

```cpp
#include "location_store.h"
#include "tz_store.h"
```

Add after `publishLayout`:

```cpp
void publishLocation(const char* blob) {
  if (!_enabled || !_mqtt.connected()) return;
  if (blob == nullptr || blob[0] == '\0') return;
  char topic[80];
  int  n = snprintf(topic, sizeof(topic), "%s/$location", _clientId);
  if (n < 0 || (size_t)n >= sizeof(topic)) return;
  _mqtt.publish(topic, blob, true);
}

void publishTz(int16_t minutes) {
  if (!_enabled || !_mqtt.connected()) return;
  char payload[8];
  int  pn = snprintf(payload, sizeof(payload), "%d", minutes);
  if (pn < 0 || (size_t)pn >= sizeof(payload)) return;
  char topic[80];
  int  n = snprintf(topic, sizeof(topic), "%s/$tz", _clientId);
  if (n < 0 || (size_t)n >= sizeof(topic)) return;
  _mqtt.publish(topic, payload, true);
}
```

- [ ] **Step 3: Extend `replayAll()` to replay location and tz on reconnect**

In `receiver/mqtt_publish.cpp`, `replayAll()` currently ends:

```cpp
  const char* layout = layout_store::get();
  if (layout[0] != '\0') {
    char topic[80];
    int  n = snprintf(topic, sizeof(topic), "%s/$layout", _clientId);
    if (n > 0 && (size_t)n < sizeof(topic) && _mqtt.publish(topic, layout, true)) sent++;
  }
  Log.notice(F("mqtt publish: replayed %d retained record(s) on connect" CR), sent);
}
```

Insert the location and tz replays before the `Log.notice` line:

```cpp
  const char* layout = layout_store::get();
  if (layout[0] != '\0') {
    char topic[80];
    int  n = snprintf(topic, sizeof(topic), "%s/$layout", _clientId);
    if (n > 0 && (size_t)n < sizeof(topic) && _mqtt.publish(topic, layout, true)) sent++;
  }
  const char* location = location_store::get();
  if (location[0] != '\0') {
    char topic[80];
    int  n = snprintf(topic, sizeof(topic), "%s/$location", _clientId);
    if (n > 0 && (size_t)n < sizeof(topic) && _mqtt.publish(topic, location, true)) sent++;
  }
  {
    char payload[8];
    int  pn = snprintf(payload, sizeof(payload), "%d", tz_store::offsetMinutes());
    if (pn > 0 && (size_t)pn < sizeof(payload)) {
      char topic[80];
      int  n = snprintf(topic, sizeof(topic), "%s/$tz", _clientId);
      if (n > 0 && (size_t)n < sizeof(topic) && _mqtt.publish(topic, payload, true)) sent++;
    }
  }
  Log.notice(F("mqtt publish: replayed %d retained record(s) on connect" CR), sent);
}
```

- [ ] **Step 4: Compile-check via the full firmware build**

Not host-testable (PubSubClient/WiFi dependency). Run: `cd receiver && pio run 2>&1 | tail -40`
Expected: `SUCCESS`.

- [ ] **Step 5: Commit**

```bash
git add receiver/mqtt_publish.h receiver/mqtt_publish.cpp
git commit -m "feat(receiver): publish \$location and \$tz over MQTT, replayed on reconnect"
```

---

### Task 4: `web_ui.cpp`/`.h` — `$location` and `$tz` HTTP + SSE (receiver)

**Files:**
- Modify: `receiver/web_ui.h`
- Modify: `receiver/web_ui.cpp`

**Model:** `sonnet` — several coordinated edit points in one file (POST dispatch, GET dispatch, two new handlers, two new broadcast functions, the replay cursor), judgment about exact placement required.

**Interfaces:**
- Consumes: `location_store::get() -> const char*`, `location_store::set(const char*) -> bool` (Task 1); `topic::isLocation(const char*) -> bool` (Task 2); `tz_store::offsetMinutes() -> int16_t`, `tz_store::set(int16_t)` (existing); `mqtt_publish::publishLocation(const char*)`, `mqtt_publish::publishTz(int16_t)` (Task 3, already landed).
- Produces: `web_ui::broadcastLocation(const char* blob)`, `web_ui::broadcastTz(int16_t minutes)`, called from this task's own `handleLocationPost`/`handleTzPost` (both call the broadcast and publish functions from the same POST handler, exactly like `handleLayoutPost` does today).

- [ ] **Step 1: Add the include and header declarations**

In `receiver/web_ui.cpp`, add to the include block (alphabetical, matching the existing list):

```cpp
#include "location_store.h"
```

In `receiver/web_ui.h`, add after `void broadcastLayout(const char* blob);`:

```cpp
void broadcastLocation(const char* blob);
void broadcastTz(int16_t minutes);
```

`web_ui.h` needs `int16_t`; it already includes `<Arduino.h>` which provides it, so no further include is needed.

- [ ] **Step 2: Add `handleLocationPost`**

In `receiver/web_ui.cpp`, add immediately after `handleLayoutPost` (before `handleTzPost`):

```cpp
static void handleLocationPost(const char* path) {
  // Same same-origin-or-bare gating as $layout and $tz: the dashboard POSTs a
  // bare /$location to its own origin, the source-prefixed form is the
  // documented curl-able equivalent.
  const char* src = signal_store::source();
  size_t      srcLen = strlen(src);
  bool        ownSource = strncmp(path, src, srcLen) == 0 && path[srcLen] == '/';
  if (strcmp(path, "$location") != 0 && !ownSource) {
    sendStatus(405, "not allowed");
    return;
  }
  String body = _server.arg("plain");
  JsonDocument doc;
  if (deserializeJson(doc, body) != DeserializationError::Ok || !doc.is<JsonObject>()) {
    sendStatus(400, "body must be a JSON object");
    return;
  }
  if (!location_store::set(body.c_str())) {
    sendStatus(503, "location store full");
    return;
  }
  web_ui::broadcastLocation(location_store::get());
  mqtt_publish::publishLocation(location_store::get());
  sendCors();
  _server.sendHeader("Cache-Control", "no-store");
  _server.send(204, "text/plain", "");
}
```

- [ ] **Step 3: Extend `handleTzPost` to broadcast and publish**

In `receiver/web_ui.cpp`, in `handleTzPost`, change:

```cpp
  tz_store::set((int16_t)doc.as<long>());
  sendCors();
```

to:

```cpp
  tz_store::set((int16_t)doc.as<long>());
  web_ui::broadcastTz(tz_store::offsetMinutes());
  mqtt_publish::publishTz(tz_store::offsetMinutes());
  sendCors();
```

- [ ] **Step 4: Dispatch the new POST branch**

In `receiver/web_ui.cpp`, in `handleTopic()`, the `HTTP_POST` block currently reads:

```cpp
  if (_server.method() == HTTP_POST) {
    if (topic::isLayout(path)) {
      handleLayoutPost(path);
      return;
    }
    if (topic::isTz(path)) {
      handleTzPost(path);
      return;
    }
    handleAliasPost(path);
    return;
  }
```

Add an `isLocation` branch between the `isLayout` and `isTz` branches:

```cpp
  if (_server.method() == HTTP_POST) {
    if (topic::isLayout(path)) {
      handleLayoutPost(path);
      return;
    }
    if (topic::isLocation(path)) {
      handleLocationPost(path);
      return;
    }
    if (topic::isTz(path)) {
      handleTzPost(path);
      return;
    }
    handleAliasPost(path);
    return;
  }
```

- [ ] **Step 5: Add GET branches for `$location` and `$tz`**

In `receiver/web_ui.cpp`, in `handleTopic()`, the GET section currently starts with the `isLayout` block and then `isAlias`. Insert a `$location` block right after the `isLayout` block, and a `$tz` block right after that:

```cpp
  if (topic::isLayout(path)) {
    const char* blob = layout_store::get();
    if (blob[0] == '\0') {
      sendStatus(404, "no message");
      return;
    }
    sendCors();
    _server.sendHeader("Cache-Control", "no-store");
    _server.send(200, "application/json", blob);
    return;
  }
  if (topic::isLocation(path)) {
    const char* blob = location_store::get();
    if (blob[0] == '\0') {
      sendStatus(404, "no message");
      return;
    }
    sendCors();
    _server.sendHeader("Cache-Control", "no-store");
    _server.send(200, "application/json", blob);
    return;
  }
  if (topic::isTz(path)) {
    char payload[8];
    int  n = snprintf(payload, sizeof(payload), "%d", tz_store::offsetMinutes());
    if (n < 0 || (size_t)n >= sizeof(payload)) {
      sendStatus(500, "internal error");
      return;
    }
    sendCors();
    _server.sendHeader("Cache-Control", "no-store");
    _server.send(200, "application/json", payload);
    return;
  }
  if (topic::isAlias(path)) {
```

(The `if (topic::isAlias(path)) {` line already exists — this step only inserts the two new blocks above it, it does not duplicate the alias block.)

- [ ] **Step 6: Add `broadcastLocation` and `broadcastTz`**

In `receiver/web_ui.cpp`, add after `broadcastLayout` (before the closing `} // namespace web_ui`):

```cpp
void broadcastLocation(const char* blob) {
  char topic[SIGNAL_KEY_MAX];
  int  n = snprintf(topic, sizeof(topic), "%s/$location", signal_store::source());
  if (n < 0 || (size_t)n >= sizeof(topic)) {
    return;
  }
  FrameBuffer frame;
  buildFrame(frame, topic, blob); // raw-embed: blob is a JSON object, not a quoted string
  if (frame.overflowed()) {
    Log.warning(F("SSE location frame overflow, dropping frame" CR));
    return;
  }
  broadcastFrame(topic, SIGNAL_SUB_TABLE + ALIAS_SLOTS + 1, frame);
}

void broadcastTz(int16_t minutes) {
  char payload[8];
  int  pn = snprintf(payload, sizeof(payload), "%d", minutes);
  if (pn < 0 || (size_t)pn >= sizeof(payload)) {
    return;
  }
  char topic[SIGNAL_KEY_MAX];
  int  n = snprintf(topic, sizeof(topic), "%s/$tz", signal_store::source());
  if (n < 0 || (size_t)n >= sizeof(topic)) {
    return;
  }
  FrameBuffer frame;
  buildFrame(frame, topic, payload); // raw-embed: payload is a JSON number
  if (frame.overflowed()) {
    Log.warning(F("SSE tz frame overflow, dropping frame" CR));
    return;
  }
  broadcastFrame(topic, SIGNAL_SUB_TABLE + ALIAS_SLOTS + 2, frame);
}
```

- [ ] **Step 7: Extend the replay cursor**

In `receiver/web_ui.cpp`, in `drainReplay()`, the layout branch currently ends with:

```cpp
    } else if (at == SIGNAL_SUB_TABLE + ALIAS_SLOTS) {
      const char* blob = layout_store::get();
      if (blob[0] == '\0') {
        continue;
      }
      static char layoutTopic[SIGNAL_KEY_MAX];
      int n = snprintf(layoutTopic, sizeof(layoutTopic), "%s/$layout", signal_store::source());
      if (n < 0 || (size_t)n >= sizeof(layoutTopic)) {
        continue;
      }
      topic = layoutTopic;
      if (!slotWants(i, topic)) {
        continue;
      }
      buildFrame(frame, topic, blob);
    } else {
      _replay[i] = -1;
      return;
    }
```

Replace the `} else {` terminator with two new branches, keeping the final `else` as the new terminator:

```cpp
    } else if (at == SIGNAL_SUB_TABLE + ALIAS_SLOTS) {
      const char* blob = layout_store::get();
      if (blob[0] == '\0') {
        continue;
      }
      static char layoutTopic[SIGNAL_KEY_MAX];
      int n = snprintf(layoutTopic, sizeof(layoutTopic), "%s/$layout", signal_store::source());
      if (n < 0 || (size_t)n >= sizeof(layoutTopic)) {
        continue;
      }
      topic = layoutTopic;
      if (!slotWants(i, topic)) {
        continue;
      }
      buildFrame(frame, topic, blob);
    } else if (at == SIGNAL_SUB_TABLE + ALIAS_SLOTS + 1) {
      const char* blob = location_store::get();
      if (blob[0] == '\0') {
        continue;
      }
      static char locationTopic[SIGNAL_KEY_MAX];
      int n = snprintf(locationTopic, sizeof(locationTopic), "%s/$location", signal_store::source());
      if (n < 0 || (size_t)n >= sizeof(locationTopic)) {
        continue;
      }
      topic = locationTopic;
      if (!slotWants(i, topic)) {
        continue;
      }
      buildFrame(frame, topic, blob);
    } else if (at == SIGNAL_SUB_TABLE + ALIAS_SLOTS + 2) {
      char tzPayload[8];
      int  tn = snprintf(tzPayload, sizeof(tzPayload), "%d", tz_store::offsetMinutes());
      if (tn < 0 || (size_t)tn >= sizeof(tzPayload)) {
        continue;
      }
      static char tzTopic[SIGNAL_KEY_MAX];
      int n = snprintf(tzTopic, sizeof(tzTopic), "%s/$tz", signal_store::source());
      if (n < 0 || (size_t)n >= sizeof(tzTopic)) {
        continue;
      }
      topic = tzTopic;
      if (!slotWants(i, topic)) {
        continue;
      }
      buildFrame(frame, topic, tzPayload);
    } else {
      _replay[i] = -1;
      return;
    }
```

Note `$tz` has no "empty means skip" guard — `tz_store::offsetMinutes()` always has a value (default `-240`), so it always replays, matching the GET behavior added in Step 5.

- [ ] **Step 8: Compile-check via the full firmware build**

This file depends on `WebServer`/`WiFi`/Arduino headers not host-testable, so verification is the full firmware build. Run: `cd receiver && ~/.platformio/penv/bin/pio run 2>&1 | tail -40` (or `pio run` if `pio` is on `PATH`).
Expected: `SUCCESS` — no compile errors.

- [ ] **Step 9: Commit**

```bash
git add receiver/web_ui.h receiver/web_ui.cpp
git commit -m "feat(receiver): round-trip \$location and \$tz through HTTP GET/POST and SSE"
```

---

### Task 5: Wire `location_store::begin()` into boot (receiver)

**Files:**
- Modify: `receiver/WebReceiver.ino`

**Model:** `haiku` — two-line addition at a known location.

**Interfaces:**
- Consumes: `location_store::begin()`, `location_store::selfTest()` (Task 1).

- [ ] **Step 1: Add `begin()` alongside `layout_store::begin()`**

In `receiver/WebReceiver.ino`, change:

```cpp
  alias_store::begin();
  layout_store::begin();
  web_ui::begin();
```

to:

```cpp
  alias_store::begin();
  layout_store::begin();
  location_store::begin();
  web_ui::begin();
```

- [ ] **Step 2: Add the `FAKE_SIGNALS` selfTest call**

In `receiver/WebReceiver.ino`, change:

```cpp
  signal_store::selfTest();
  alias_store::selfTest();
  layout_store::selfTest();
  wifi_store::selfTest();
```

to:

```cpp
  signal_store::selfTest();
  alias_store::selfTest();
  layout_store::selfTest();
  location_store::selfTest();
  wifi_store::selfTest();
```

- [ ] **Step 3: Add the include**

`WebReceiver.ino` includes each store's header near the top of the file — find the existing `#include "layout_store.h"` line and add `#include "location_store.h"` immediately after it, matching the file's existing include ordering for the other stores.

- [ ] **Step 4: Compile-check via the full firmware build**

Run: `cd receiver && pio run 2>&1 | tail -40`
Expected: `SUCCESS`.

- [ ] **Step 5: Commit**

```bash
git add receiver/WebReceiver.ino
git commit -m "feat(receiver): load location_store at boot"
```

---

### Task 6: Receiver's JS binding model — `$location` support and `$tz` GET/SSE tests

**Files:**
- Modify: `receiver/test/binding-server.js`
- Modify: `receiver/test/binding.spec.js`

**Model:** `sonnet` — mirrors existing `$layout` handling exactly, but touches request-dispatch logic and adds several test cases; needs judgment about where GET/SSE coverage for `$tz` was previously absent.

**Interfaces:**
- Produces (test-only): `server.emitLocation(payload)` on the object `startServer()` returns, mirroring `emitLocation`/`emitLayout`.

- [ ] **Step 1: Add `$location` retained-topic support to `binding-server.js`**

In `receiver/test/binding-server.js`, add the suffix constant near `LAYOUT_SUFFIX`:

```js
const LAYOUT_SUFFIX = "/$layout";
const LOCATION_SUFFIX = "/$location";
```

Change the POST handler's layout branch — currently:

```js
    if (req.method === "POST") {
      const isLayout = topic.endsWith(LAYOUT_SUFFIX) || topic === "$layout";
      if (isLayout) {
        if (!topic.startsWith(source + "/") && topic !== "$layout") {
          res.writeHead(405).end("not allowed");
          return;
        }
        const body = await readBody(req);
        let value;
        try { value = JSON.parse(body); } catch (e) { value = undefined; }
        if (value === undefined || typeof value !== "object" || value === null || Array.isArray(value)) {
          res.writeHead(400).end("body must be a JSON object");
          return;
        }
        publish(source + LAYOUT_SUFFIX, JSON.stringify(value));
        res.writeHead(204).end();
        return;
      }
      const isTz = topic.endsWith("/$tz") || topic === "$tz";
```

to (insert an `isLocation` branch after the `isLayout` block, before `isTz`):

```js
    if (req.method === "POST") {
      const isLayout = topic.endsWith(LAYOUT_SUFFIX) || topic === "$layout";
      if (isLayout) {
        if (!topic.startsWith(source + "/") && topic !== "$layout") {
          res.writeHead(405).end("not allowed");
          return;
        }
        const body = await readBody(req);
        let value;
        try { value = JSON.parse(body); } catch (e) { value = undefined; }
        if (value === undefined || typeof value !== "object" || value === null || Array.isArray(value)) {
          res.writeHead(400).end("body must be a JSON object");
          return;
        }
        publish(source + LAYOUT_SUFFIX, JSON.stringify(value));
        res.writeHead(204).end();
        return;
      }
      const isLocation = topic.endsWith(LOCATION_SUFFIX) || topic === "$location";
      if (isLocation) {
        if (!topic.startsWith(source + "/") && topic !== "$location") {
          res.writeHead(405).end("not allowed");
          return;
        }
        const body = await readBody(req);
        let value;
        try { value = JSON.parse(body); } catch (e) { value = undefined; }
        if (value === undefined || typeof value !== "object" || value === null || Array.isArray(value)) {
          res.writeHead(400).end("body must be a JSON object");
          return;
        }
        publish(source + LOCATION_SUFFIX, JSON.stringify(value));
        res.writeHead(204).end();
        return;
      }
      const isTz = topic.endsWith("/$tz") || topic === "$tz";
```

- [ ] **Step 2: Make `$tz` retained so `GET`/SSE work, mirroring `$layout`**

Change the `isTz` branch — currently:

```js
      const isTz = topic.endsWith("/$tz") || topic === "$tz";
      if (isTz) {
        if (!topic.startsWith(source + "/") && topic !== "$tz") {
          res.writeHead(405).end("not allowed");
          return;
        }
        const body = await readBody(req);
        let value;
        try { value = JSON.parse(body); } catch (e) { value = undefined; }
        if (typeof value !== "number" || !Number.isFinite(value)) {
          res.writeHead(400).end("body must be a JSON number");
          return;
        }
        tzOffset = Math.round(value);
        res.writeHead(204).end();
        return;
      }
```

to:

```js
      const isTz = topic.endsWith("/$tz") || topic === "$tz";
      if (isTz) {
        if (!topic.startsWith(source + "/") && topic !== "$tz") {
          res.writeHead(405).end("not allowed");
          return;
        }
        const body = await readBody(req);
        let value;
        try { value = JSON.parse(body); } catch (e) { value = undefined; }
        if (typeof value !== "number" || !Number.isFinite(value)) {
          res.writeHead(400).end("body must be a JSON number");
          return;
        }
        tzOffset = Math.round(value);
        publish(source + "/$tz", JSON.stringify(tzOffset));
        res.writeHead(204).end();
        return;
      }
```

This makes `GET /<source>/$tz` and a `#` SSE subscription pick it up through the existing generic retained-topic paths (no other change needed — both already read from the same `retained` map `publish()` writes into).

- [ ] **Step 3: Seed the retained `$tz` value at server start**

`tzOffset` already defaults to `-240` (`let tzOffset = -240;` near the top of `startServer`). Immediately after that declaration, seed the retained map so a fresh connection replays it even with no prior `POST`, matching the real receiver's "`$tz` always has *some* value" behavior:

```js
  let tzOffset = -240;
```

becomes:

```js
  let tzOffset = -240;
```

(no other placement works before `publish` is defined) — instead, add the seed call right after `publish` is defined and before `function put(payload, meta = {})`:

```js
  publish(source + "/$tz", JSON.stringify(tzOffset));
```

- [ ] **Step 4: Add `emitLocation` to the returned test helper**

In the object returned by `startServer()`, add next to `emitLayout`:

```js
        emitLayout(template) { publish(source + LAYOUT_SUFFIX, JSON.stringify(template)); },
        emitLocation(loc) { publish(source + LOCATION_SUFFIX, JSON.stringify(loc)); },
```

- [ ] **Step 5: Add binding-spec test cases**

In `receiver/test/binding.spec.js`, add at the end of the file (after the last `POST /\$tz to another source is 405` test):

```js
test("a posted location comes back byte for byte", async () => {
  server = await startServer({ devices: [] });
  const topic = SOURCE + "/$location";
  expect((await server.get(topic)).status).toBe(404);

  const loc = { lat: 40.015, lon: -105.2705, label: "Boulder", zone: "America/Denver", zoom: 12 };
  expect((await server.post(topic, JSON.stringify(loc))).status).toBe(204);
  const got = await server.get(topic);
  expect(got.status).toBe(200);
  expect(JSON.parse(got.body)).toEqual(loc);
});

test("POST /\$location as a bare source-level topic is accepted", async () => {
  server = await startServer({ devices: [] });
  const r = await server.post("$location", JSON.stringify({ lat: 0, lon: 0 }));
  expect(r.status).toBe(204);
  expect((await server.get(SOURCE + "/$location")).status).toBe(200);
});

test("POST /\$location with a non-object body is 400", async () => {
  server = await startServer({ devices: [] });
  const r = await server.post(SOURCE + "/$location", JSON.stringify("nope"));
  expect(r.status).toBe(400);
});

test("POST /\$location to another source is 405", async () => {
  server = await startServer({ devices: [] });
  const r = await server.post("other/$location", JSON.stringify({ lat: 0, lon: 0 }));
  expect(r.status).toBe(405);
});

test("\$location round-trips through a # subscription", async () => {
  server = await startServer({ devices: [] });
  const s = await openStream(server.url, "?f=%23");
  await s.settle();
  const loc = { lat: 40.015, lon: -105.2705 };
  await server.post(SOURCE + "/$location", JSON.stringify(loc));
  const frames = await s.settle();
  expect(frames[frames.length - 1]).toEqual({ topic: SOURCE + "/$location", payload: loc });
  s.close();
});

test("GET /\$tz returns the current offset, retained from boot", async () => {
  server = await startServer({ devices: [] });
  const got = await server.get(SOURCE + "/$tz");
  expect(got.status).toBe(200);
  expect(JSON.parse(got.body)).toBe(-240);
});

test("\$tz round-trips through a # subscription after a POST", async () => {
  server = await startServer({ devices: [] });
  const s = await openStream(server.url, "?f=%23");
  await s.settle();
  await server.post(SOURCE + "/Receiver/0/$tz", JSON.stringify(-300));
  const frames = await s.settle();
  expect(frames[frames.length - 1]).toEqual({ topic: SOURCE + "/$tz", payload: -300 });
  s.close();
});
```

- [ ] **Step 6: Run the binding spec**

Run: `cd receiver && npx playwright test test/binding.spec.js`
Expected: all tests pass, including the new ones.

- [ ] **Step 7: Commit**

```bash
git add receiver/test/binding-server.js receiver/test/binding.spec.js
git commit -m "test(receiver): model \$location and \$tz GET/SSE in the binding spec"
```

---

### Task 7: `bridge/docs/binding.md` — document `$location`, complete `$tz`

**Files:**
- Modify: `bridge/docs/binding.md`

**Model:** `haiku` — doc-only edit, complete text given.

- [ ] **Step 1: Add a `## Location` section**

After the `## Layout` section (right before `## Errors`), add:

```markdown
## Location

`<source>/$location` holds one JSON object: the receiver's configured
location and timezone name, the same shape `settings.value.location` uses on
the dashboard. It round-trips through `GET`, `POST`, and a `#` subscription
like any other topic — there is nothing binding-specific about it, it is
simply a topic whose payload happens to be a location rather than a sensor
reading or a name.

    rtl433-a1b2c3/$location   {"lat":40.015,"lon":-105.2705,"label":"Boulder","zone":"America/Denver","zoom":12}

A missing `$location` is not an error; it means no location has been saved.
The shape of the object itself is a dashboard convention, not part of this
binding — a bridge or a receiver never inspects it, only stores and forwards
it.

`<source>/$tz` holds the receiver's UTC offset in whole minutes, as a JSON
number, used to set the receiver's own clock. It round-trips the same way;
unlike `$location` and `$layout`, it is never unset — a fresh receiver's
`$tz` defaults to `-240`.

    rtl433-a1b2c3/$tz   -420
```

- [ ] **Step 2: Update the three `$alias`/`$tz`/`$layout` lists to include `$location`**

Change (in the `## Errors` section):

```
of this binding has to gate writes behind a token, and a client should not assume
one that doesn't answers `401` to anything. The receiver's own source-only subset
keeps its existing `405` answer for a `POST` to anything other than `$alias`,
`$tz`, or `$layout` regardless.
```

to:

```
of this binding has to gate writes behind a token, and a client should not assume
one that doesn't answers `401` to anything. The receiver's own source-only subset
keeps its existing `405` answer for a `POST` to anything other than `$alias`,
`$tz`, `$layout`, or `$location` regardless.
```

Change (in the `## Implementations` section):

```
**The receiver's source-only subset** serves `GET` and `/events` for topics
under its own `source`, and accepts `POST` only to its own `$alias`, `$tz`,
and `$layout` topics, each persisted to NVS. Every other `POST` is `405`.
```

to:

```
**The receiver's source-only subset** serves `GET` and `/events` for topics
under its own `source`, and accepts `POST` only to its own `$alias`, `$tz`,
`$layout`, and `$location` topics, each persisted to NVS. Every other `POST`
is `405`.
```

Change (in the `## Testing` section):

```
- `$alias` round-trips through `GET`, `POST`, and a `#` subscription, and a
  device with no alias omits the topic rather than returning an empty string.
- The receiver returns `405` for a `POST` to a topic that is not `$alias`,
  `$tz`, or `$layout`, and a value written to any of the three survives a
  reboot.
```

to:

```
- `$alias` round-trips through `GET`, `POST`, and a `#` subscription, and a
  device with no alias omits the topic rather than returning an empty string.
- `$location` and `$tz` round-trip through `GET`, `POST`, and a `#`
  subscription the same way `$layout` does; `$tz`'s `GET` never `404`s, since
  a receiver always has some offset.
- The receiver returns `405` for a `POST` to a topic that is not `$alias`,
  `$tz`, `$layout`, or `$location`, and a value written to any of the four
  survives a reboot.
```

- [ ] **Step 3: Commit**

```bash
git add bridge/docs/binding.md
git commit -m "docs(bridge): document \$location and \$tz's now-complete round trip"
```

---

### Task 8: `stream.js` — dispatch `$location` and `$tz` frames (dashboard)

**Files:**
- Modify: `dashboard/src/stream.js`

**Model:** `haiku` — small, mechanical addition mirroring `LAYOUT_SUFFIX`; no dedicated unit test exists for this file today (its dispatch logic is exercised end-to-end by the playwright specs in Task 13, matching the existing untested state of the `$alias`/`$layout` dispatch it mirrors).

**Interfaces:**
- Consumes: `handlers.onLocation(base, topic, payload)`, `handlers.onTz(base, topic, payload)` — new handler callbacks `openSource()`'s caller must supply (Task 10 supplies them).
- Produces: dispatches any SSE frame whose topic ends `/$location` to `onLocation`, and `/$tz` to `onTz`.

- [ ] **Step 1: Add the suffix constants and dispatch branches**

In `dashboard/src/stream.js`, change:

```js
const ALIAS_SUFFIX = '/$alias'
const LAYOUT_SUFFIX = '/$layout'
```

to:

```js
const ALIAS_SUFFIX = '/$alias'
const LAYOUT_SUFFIX = '/$layout'
const LOCATION_SUFFIX = '/$location'
const TZ_SUFFIX = '/$tz'
```

Change:

```js
    es.onmessage = (ev) => {
      const msg = parse(ev.data)
      if (!msg || typeof msg.topic !== 'string') return
      if (msg.topic.endsWith(ALIAS_SUFFIX)) handlers.onAlias(base, msg.topic, msg.payload)
      else if (msg.topic.endsWith(LAYOUT_SUFFIX)) handlers.onLayout(base, msg.topic, msg.payload)
      else handlers.onMessage(base, msg.topic, msg.payload)
    }
```

to:

```js
    es.onmessage = (ev) => {
      const msg = parse(ev.data)
      if (!msg || typeof msg.topic !== 'string') return
      if (msg.topic.endsWith(ALIAS_SUFFIX)) handlers.onAlias(base, msg.topic, msg.payload)
      else if (msg.topic.endsWith(LAYOUT_SUFFIX)) handlers.onLayout(base, msg.topic, msg.payload)
      else if (msg.topic.endsWith(LOCATION_SUFFIX)) handlers.onLocation(base, msg.topic, msg.payload)
      else if (msg.topic.endsWith(TZ_SUFFIX)) handlers.onTz(base, msg.topic, msg.payload)
      else handlers.onMessage(base, msg.topic, msg.payload)
    }
```

- [ ] **Step 2: Commit**

```bash
git add dashboard/src/stream.js
git commit -m "feat(dashboard): dispatch \$location and \$tz SSE frames"
```

(No test run in this task by itself — `openSource()` is not yet called with `onLocation`/`onTz` handlers until Task 10, so wiring is verified together with Task 9-11's unit tests and Task 13's e2e coverage.)

---

### Task 9: `settings.js` — fallback resolution and write-path gating (dashboard)

**Files:**
- Modify: `dashboard/src/settings.js`
- Modify: `dashboard/test/settings.test.js`

**Model:** `sonnet` — new signals, a resolution function with real judgment calls (documented in Global Constraints), and edits to existing exported functions that other modules depend on.

**Interfaces:**
- Consumes: `sources` (signal, array of base URLs) from `./sources.js`.
- Produces:
  - `locations` (signal, `Map<string, {lat,lon,label,zone,zoom}>`), `tzOffsets` (signal, `Map<string, number>`)
  - `onLocationFrame(base, payload)`, `onTzFrame(base, payload)` — called by `main.jsx`'s `onLocation`/`onTz` (Task 10)
  - `locationForSources(locationsMap, srcs)` — pure fallback lookup, same shape as `layoutForSources`
  - `resolvedLocation()` — `settings.value.location` if it has coordinates, else the network fallback, else a blank location; consumed by `feed.js` (Task 11)
  - `hasLocation()` and `activeZone()` — behavior extended to use `resolvedLocation()` internally; same exported signatures as today
  - `setLocation(next)` — same signature; now also POSTs `/$location`, and both POSTs are gated on `sources.value.includes(location.origin)` in addition to the existing `hasLocation()` gate

- [ ] **Step 1: Write the failing tests**

In `dashboard/test/settings.test.js`, add `sources` to the imports and a fallback-state reset to `beforeEach`:

```js
import { settings, SETTINGS_KEY, loadSettings, saveSettings, setUnits, setDecimals, setCustomField,
         setLocation, clearLocation, hasLocation, activeZone, localZone,
         locations, tzOffsets, onLocationFrame, onTzFrame, locationForSources } from '../src/settings.js'
import { sources } from '../src/sources.js'
```

```js
beforeEach(() => {
  fakeStorage()
  loadSettings()
  sources.value = []
  locations.value = new Map()
  tzOffsets.value = new Map()
})
```

Add these test cases at the end of the file:

```js
test('setLocation does not POST when the serving origin is not a configured source', async () => {
  const posted = []
  globalThis.fetch = async (url) => { posted.push(url); return {} }
  sources.value = []
  setLocation({ lat: 40.015, lon: -105.2705 })
  assert.deepEqual(posted, [])
  globalThis.fetch = async () => ({})
})

test('setLocation POSTs both /$tz and /$location when the origin is a configured source', async () => {
  const posted = []
  globalThis.fetch = async (url, opts) => { posted.push([url, opts.body]); return {} }
  sources.value = ['http://receiver.test']
  setLocation({ lat: 40.015, lon: -105.2705, label: 'Boulder', zone: 'America/Denver', zoom: 12 })
  assert.equal(posted.length, 2)
  assert.deepEqual(posted.map(p => p[0]).sort(),
    ['http://receiver.test/$location', 'http://receiver.test/$tz'])
  globalThis.fetch = async () => ({})
})

test('onLocationFrame stores a valid object and clears on a non-object payload', () => {
  onLocationFrame('http://a', { lat: 10, lon: 20, label: '', zone: '', zoom: 5 })
  assert.equal(locations.value.get('http://a').lat, 10)
  onLocationFrame('http://a', null)
  assert.equal(locations.value.has('http://a'), false)
})

test('onTzFrame stores a finite number and clears on anything else', () => {
  onTzFrame('http://a', -300)
  assert.equal(tzOffsets.value.get('http://a'), -300)
  onTzFrame('http://a', 'nope')
  assert.equal(tzOffsets.value.has('http://a'), false)
})

test('locationForSources picks the first source in order that published one', () => {
  const map = new Map([['http://b', { lat: 1, lon: 1 }], ['http://a', { lat: 2, lon: 2 }]])
  assert.equal(locationForSources(map, ['http://a', 'http://b']).lat, 2)
  assert.equal(locationForSources(map, ['http://c', 'http://b']).lat, 1)
  assert.equal(locationForSources(map, ['http://c']), null)
})

test('hasLocation falls back to a configured source with no local location set', () => {
  assert.equal(hasLocation(), false)
  sources.value = ['http://a', 'http://b']
  onLocationFrame('http://b', { lat: 5, lon: 6, label: '', zone: '', zoom: 11 })
  assert.equal(hasLocation(), true)
  onLocationFrame('http://a', { lat: 7, lon: 8, label: '', zone: '', zoom: 11 })
  assert.equal(hasLocation(), true)
})

test('a local location always wins over the network fallback', () => {
  sources.value = ['http://a']
  onLocationFrame('http://a', { lat: 5, lon: 6, label: '', zone: '', zoom: 11 })
  setLocation({ lat: 40.015, lon: -105.2705 })
  assert.equal(settings.value.location.lat, 40.015)
  assert.equal(hasLocation(), true)
})

test('the network fallback never writes into localStorage', () => {
  sources.value = ['http://a']
  onLocationFrame('http://a', { lat: 5, lon: 6, label: '', zone: 'Europe/Berlin', zoom: 11 })
  assert.equal(hasLocation(), true)
  assert.deepEqual(settings.value.location, NO_PLACE)
  assert.equal(activeZone(), 'Europe/Berlin')
})

test('activeZone falls back to the network location zone, then the browser zone', () => {
  sources.value = ['http://a']
  assert.equal(activeZone(), localZone())
  onLocationFrame('http://a', { lat: 5, lon: 6, label: '', zone: '', zoom: 11 })
  assert.equal(activeZone(), localZone())
  onLocationFrame('http://a', { lat: 5, lon: 6, label: '', zone: 'Europe/Berlin', zoom: 11 })
  assert.equal(activeZone(), 'Europe/Berlin')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd dashboard && node --test test/settings.test.js`
Expected: `FAIL` — `locations`, `tzOffsets`, `onLocationFrame`, `onTzFrame`, `locationForSources` are not exported yet, and the two `setLocation` POST-gating tests fail against the current ungated behavior.

- [ ] **Step 3: Implement in `settings.js`**

Add the import and new signals near the top, after the existing `signal` import:

```js
import { signal } from '@preact/signals'
import { offsetMinutes } from './feeds/zone.js'
import { sources } from './sources.js'
```

Add after `export const settings = signal(fresh())`:

```js
// base -> location object, the network fallback layer. Same structure
// layout_template.js's `layouts` map uses for $layout.
export const locations = signal(new Map())
// base -> raw UTC-offset minutes, the network fallback layer for $tz.
export const tzOffsets = signal(new Map())

export function onLocationFrame(base, payload) {
  const next = new Map(locations.value)
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) next.set(base, cleanLocation(payload))
  else next.delete(base)
  locations.value = next
}

export function onTzFrame(base, payload) {
  const next = new Map(tzOffsets.value)
  if (typeof payload === 'number' && Number.isFinite(payload)) next.set(base, payload)
  else next.delete(base)
  tzOffsets.value = next
}

// Load has no write, so it carries none of Save's same-origin trust boundary --
// any connected source's published location is fair game. Picks the first
// configured source (in sources.value order) that has one, same convention
// layoutForSources() established for $layout.
export function locationForSources(locationsMap, srcs) {
  for (const base of srcs) {
    const l = locationsMap.get(base)
    if (l) return l
  }
  return null
}

// The zone published alongside a network location is an IANA name, usable
// directly by Intl -- $tz's own network value is a raw UTC-offset in
// minutes, which Intl's timeZone option cannot consume, so it does not
// feed this resolution; tzOffsets exists for the receiver's own round trip.
function resolvedLocation() {
  const l = settings.value.location
  if (l.lat !== null && l.lon !== null) return l
  return locationForSources(locations.value, sources.value) || blankLocation()
}
```

Change `hasLocation`:

```js
export function hasLocation() {
  const l = settings.value.location
  return l.lat !== null && l.lon !== null
}
```

to:

```js
export function hasLocation() {
  const l = resolvedLocation()
  return l.lat !== null && l.lon !== null
}
```

Change `activeZone`:

```js
export function activeZone() {
  return settings.value.location.zone || localZone()
}
```

to:

```js
export function activeZone() {
  return resolvedLocation().zone || localZone()
}
```

Change `setLocation`:

```js
export function setLocation(next) {
  const clean = cleanLocation({ ...settings.value.location, ...next })
  settings.value = { ...settings.value, location: clean }
  saveSettings()
  if (hasLocation()) {
    const offset = offsetMinutes(new Date(), activeZone())
    fetch(`${location.origin}/$tz`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(offset),
    }).catch(err => console.error(`POST $tz failed: ${err.message || err}`))
  }
  return clean
}
```

to:

```js
export function setLocation(next) {
  const clean = cleanLocation({ ...settings.value.location, ...next })
  settings.value = { ...settings.value, location: clean }
  saveSettings()
  // Gated the same way the $layout Save button is: publishing to a source is
  // only meaningful when this page is served by that source.
  if (hasLocation() && sources.value.includes(location.origin)) {
    const offset = offsetMinutes(new Date(), activeZone())
    fetch(`${location.origin}/$tz`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(offset),
    }).catch(err => console.error(`POST $tz failed: ${err.message || err}`))
    fetch(`${location.origin}/$location`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(clean),
    }).catch(err => console.error(`POST $location failed: ${err.message || err}`))
  }
  return clean
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd dashboard && node --test test/settings.test.js`
Expected: `PASS`, all tests including the pre-existing ones.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/settings.js dashboard/test/settings.test.js
git commit -m "feat(dashboard): resolve location/zone from a network fallback, POST \$location"
```

---

### Task 10: `main.jsx` — wire `onLocation`/`onTz` handlers (dashboard)

**Files:**
- Modify: `dashboard/src/main.jsx`

**Model:** `sonnet` — touches three `openSource()` call sites and must keep them consistent; a missed site silently breaks propagation for that connection path (probe vs. steady-state sources).

**Interfaces:**
- Consumes: `onLocationFrame`, `onTzFrame` from `./settings.js` (Task 9); `stream.js`'s `openSource()` now requires `onLocation`/`onTz` in its `handlers` argument (Task 8).

- [ ] **Step 1: Import the new settings functions**

Change:

```js
import { loadSettings, settings, setLocation, clearLocation } from './settings.js'
```

to:

```js
import { loadSettings, settings, setLocation, clearLocation, onLocationFrame, onTzFrame } from './settings.js'
```

- [ ] **Step 2: Add the handler functions**

Add after `onLayout` (before `function onState`):

```js
function onLocation(base, topic, payload) {
  onLocationFrame(base, payload)
}

function onTz(base, topic, payload) {
  onTzFrame(base, payload)
}
```

- [ ] **Step 3: Wire the handlers into all three `openSource()` calls**

Change:

```js
  const stream = openSource(base, { onMessage, onAlias, onLayout, onState: onProbeState })
```

to:

```js
  const stream = openSource(base, { onMessage, onAlias, onLayout, onLocation, onTz, onState: onProbeState })
```

Change:

```js
    open.set(base, openSource(base, { onMessage, onAlias, onLayout, onState }))
```

to:

```js
    open.set(base, openSource(base, { onMessage, onAlias, onLayout, onLocation, onTz, onState }))
```

(These are the only two `openSource(...)` call sites in the file — `probeOrigin()`'s and `syncSources()`'s.)

- [ ] **Step 4: Clear a dropped source's network location/tz**

In `dropSource(base, stream)`, add cleanup alongside the existing `layouts` cleanup so a removed source's network fallback data doesn't linger:

Change:

```js
function dropSource(base, stream) {
  stream.close()
  open.delete(base)
  const nextState = new Map(sourceState.value)
  nextState.delete(base)
  sourceState.value = nextState
  clearSource(base)
  const nextAliases = new Map(aliases.value)
  for (const key of nextAliases.keys()) if (key.startsWith(`${base} `)) nextAliases.delete(key)
  aliases.value = nextAliases
  const nextLayouts = new Map(layouts.value)
  nextLayouts.delete(base)
  layouts.value = nextLayouts
}
```

to:

```js
function dropSource(base, stream) {
  stream.close()
  open.delete(base)
  const nextState = new Map(sourceState.value)
  nextState.delete(base)
  sourceState.value = nextState
  clearSource(base)
  const nextAliases = new Map(aliases.value)
  for (const key of nextAliases.keys()) if (key.startsWith(`${base} `)) nextAliases.delete(key)
  aliases.value = nextAliases
  const nextLayouts = new Map(layouts.value)
  nextLayouts.delete(base)
  layouts.value = nextLayouts
  onLocationFrame(base, null)
  onTzFrame(base, null)
}
```

- [ ] **Step 5: Run the dashboard unit suite**

Run: `cd dashboard && node --test test/*.test.js`
Expected: all tests still pass (no unit test targets `main.jsx` directly — this step guards against a syntax error or import cycle).

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/main.jsx
git commit -m "feat(dashboard): wire \$location/\$tz SSE frames into settings.js's fallback maps"
```

---

### Task 11: `feed.js` — consume the resolved location (dashboard)

**Files:**
- Modify: `dashboard/src/feeds/feed.js`

**Model:** `sonnet` — reads a signal directly in two places; must not change behavior when a local location is set (existing `feeds.test.js` coverage must stay green).

**Interfaces:**
- Consumes: `resolvedLocation()` — new export needed from `./settings.js`. **Note:** Task 9 defined `resolvedLocation()` as a private (non-exported) function. Before starting this task, add `export` to its definition in `dashboard/src/settings.js` (change `function resolvedLocation()` to `export function resolvedLocation()`); this is a one-word change to a file Task 9 already touched, not a new file.

- [ ] **Step 1: Export `resolvedLocation` from `settings.js`**

In `dashboard/src/settings.js`, change:

```js
function resolvedLocation() {
```

to:

```js
export function resolvedLocation() {
```

- [ ] **Step 2: Use it in `feed.js`**

Change the import:

```js
import { settings, hasLocation, activeZone } from '../settings.js'
```

to:

```js
import { hasLocation, activeZone, resolvedLocation } from '../settings.js'
```

Change `placeOf`:

```js
function placeOf() {
  const l = settings.value.location
  return hasLocation() ? `${l.lat},${l.lon}` : ''
}
```

to:

```js
function placeOf() {
  const l = resolvedLocation()
  return hasLocation() ? `${l.lat},${l.lon}` : ''
}
```

Change `pump`'s body:

```js
  const l = settings.value.location
  const ctx = { lat: l.lat, lon: l.lon, zone: activeZone(), place }
```

to:

```js
  const l = resolvedLocation()
  const ctx = { lat: l.lat, lon: l.lon, zone: activeZone(), place }
```

`settings` is no longer referenced in this file after these two changes — confirm with `grep -n "settings\." dashboard/src/feeds/feed.js` before removing the import (it was removed above; if the grep finds another use, keep the import and only drop the unused names).

- [ ] **Step 3: Run the feeds unit suite**

Run: `cd dashboard && node --test test/feeds.test.js`
Expected: `PASS` — unchanged, since every existing test sets a local location via `setLocation()`, which `resolvedLocation()` returns unchanged from `settings.value.location`.

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/settings.js dashboard/src/feeds/feed.js
git commit -m "feat(dashboard): feeds use the resolved (local-or-network) location"
```

---

### Task 12: `harness.js` — proxy `$location`, retain `$tz` (dashboard e2e harness)

**Files:**
- Modify: `dashboard/test/harness.js`

**Model:** `sonnet` — mirrors the existing `$layout` special-casing exactly, but the reasoning for *why* each topic needs it (documented in the file's own comment) must be preserved and extended correctly.

**Interfaces:**
- Produces (test-only): `server.emitLocation(payload)` on `startServer()`'s returned object, mirroring `emitLayout`.

- [ ] **Step 1: Add the suffix constant**

Change:

```js
const ALIAS_SUFFIX = "/$alias";
const LAYOUT_SUFFIX = "/$layout";
```

to:

```js
const ALIAS_SUFFIX = "/$alias";
const LAYOUT_SUFFIX = "/$layout";
const LOCATION_SUFFIX = "/$location";
```

- [ ] **Step 2: Add `emitLocation`**

Change:

```js
  async function emitLayout(template) {
    await fixture.publish(source + LAYOUT_SUFFIX, JSON.stringify(template));
  }
```

to:

```js
  async function emitLayout(template) {
    await fixture.publish(source + LAYOUT_SUFFIX, JSON.stringify(template));
  }

  async function emitLocation(loc) {
    await fixture.publish(source + LOCATION_SUFFIX, JSON.stringify(loc));
  }
```

- [ ] **Step 3: Route `$location` POSTs through the same canonicalization as `$layout`, and make `$tz` retained on the bridge**

Change the request handler's dispatch condition:

```js
      const last = topic.split("/").pop();
      if (last === "$tz" || last === "$alias" || last === "$layout") {
```

to:

```js
      const last = topic.split("/").pop();
      if (last === "$tz" || last === "$alias" || last === "$layout" || last === "$location") {
```

Update the comment above `postToReceiver` to mention the fourth topic — change:

```js
  // Three POST paths the firmware's own binding owns, which the bridge does
  // not implement: MQTT reserves a leading '$', so a bare "$tz" or "$layout"
  // publish never comes back on the bridge's '#' subscription and its POST
  // answers 503 — the real receiver sidesteps this by always canonicalizing
  // to <source>/$tz or <source>/$layout before broadcasting, regardless of
  // what path was POSTed, so this does the same before handing off to the
  // bridge; and an empty alias means delete the retained message, which the
  // bridge stores as the string it is. All three are kept here rather than
  // in the bridge because all three are what receiver/test/binding-server.js
  // did.
```

to:

```js
  // Four POST paths the firmware's own binding owns, which the bridge does
  // not implement: MQTT reserves a leading '$', so a bare "$tz", "$layout",
  // or "$location" publish never comes back on the bridge's '#' subscription
  // and its POST answers 503 — the real receiver sidesteps this by always
  // canonicalizing to <source>/$tz, <source>/$layout, or <source>/$location
  // before broadcasting, regardless of what path was POSTed, so this does
  // the same before handing off to the bridge; and an empty alias means
  // delete the retained message, which the bridge stores as the string it
  // is. All four are kept here rather than in the bridge because all four
  // are what receiver/test/binding-server.js does.
```

Change `postToReceiver` — currently:

```js
    if (last === "$tz") {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        res.writeHead(400).end("body must be a JSON number");
        return;
      }
      tzOffsetValue = Math.round(value);
      res.writeHead(204).end();
      return;
    }
    if (last === "$layout") {
      if (value === undefined || typeof value !== "object" || value === null || Array.isArray(value)) {
        res.writeHead(400).end("body must be a JSON object");
        return;
      }
      await fixture.publish(source + LAYOUT_SUFFIX, JSON.stringify(value));
      res.writeHead(204).end();
      return;
    }
```

to:

```js
    if (last === "$tz") {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        res.writeHead(400).end("body must be a JSON number");
        return;
      }
      tzOffsetValue = Math.round(value);
      await fixture.publish(source + "/$tz", JSON.stringify(tzOffsetValue));
      res.writeHead(204).end();
      return;
    }
    if (last === "$layout") {
      if (value === undefined || typeof value !== "object" || value === null || Array.isArray(value)) {
        res.writeHead(400).end("body must be a JSON object");
        return;
      }
      await fixture.publish(source + LAYOUT_SUFFIX, JSON.stringify(value));
      res.writeHead(204).end();
      return;
    }
    if (last === "$location") {
      if (value === undefined || typeof value !== "object" || value === null || Array.isArray(value)) {
        res.writeHead(400).end("body must be a JSON object");
        return;
      }
      await fixture.publish(source + LOCATION_SUFFIX, JSON.stringify(value));
      res.writeHead(204).end();
      return;
    }
```

- [ ] **Step 4: Expose `emitLocation` on the returned object**

Change:

```js
    emitLayout(template) { return emitLayout(template); },
```

to:

```js
    emitLayout(template) { return emitLayout(template); },
    emitLocation(loc) { return emitLocation(loc); },
```

- [ ] **Step 5: Verify against an existing spec**

Run: `cd dashboard && npx playwright test test/layout.spec.js test/multi.spec.js`
Expected: all pass — this task only adds branches, it does not change any existing `$tz`/`$layout`/`$alias` path's outcome. (`$tz` now additionally publishes to the fixture, which no current spec reads back, so no existing assertion should change.)

- [ ] **Step 6: Commit**

```bash
git add dashboard/test/harness.js
git commit -m "test(dashboard): teach the e2e harness to proxy \$location and retain \$tz"
```

---

### Task 13: Dashboard e2e — cross-origin `$location`/`$tz` propagation

**Files:**
- Create: `dashboard/test/location-propagation.spec.js`

**Model:** `sonnet` — end-to-end scenario construction (bridge-hosted dashboard + remote source), mirrors `multi.spec.js`'s and `layout.spec.js`'s existing patterns closely but is new test content.

**Interfaces:**
- Consumes: `startServer`, `startPage` from `./harness.js` (Task 12), `ACURITE`/`topicOf` from `./fixtures.js`.

- [ ] **Step 1: Write the spec**

```js
import { test, expect } from "@playwright/test";
import { startServer, startPage } from "./harness.js";
import { ACURITE } from "./fixtures.js";

let servers = [];

test.afterEach(async () => {
  for (const s of servers) await s.close();
  servers = [];
});

function base(server) { return server.url.replace(/\/$/, ""); }

async function withSources(page, host, bases) {
  await page.addInitScript((list) => {
    localStorage.setItem("rtl433.sources.v1", JSON.stringify(list));
  }, bases);
  await page.goto(host.url);
}

const BOULDER = { lat: 40.015, lon: -105.2705, label: "Boulder", zone: "America/Denver", zoom: 12 };

test("a $location retained before connect makes feed cards appear with no local location", async ({ page }) => {
  const host = await startPage();
  const src = await startServer({ devices: [ACURITE], source: "srcA" });
  servers.push(host, src);
  await src.emitLocation(BOULDER);
  await withSources(page, host, [base(src)]);
  await page.click("#tab-cards");
  await expect(page.locator('.card[data-key$="feed/Clock"]')).toBeVisible();
  await expect(page.locator('.card[data-key$="feed/Sun"]')).toBeVisible();
});

test("a local location always wins over a source's network location", async ({ page }) => {
  const host = await startPage();
  const src = await startServer({ devices: [ACURITE], source: "srcA" });
  servers.push(host, src);
  await src.emitLocation(BOULDER);
  await page.addInitScript((list) => {
    localStorage.setItem("rtl433.sources.v1", JSON.stringify(list));
    localStorage.setItem("rtl433.settings.v1", JSON.stringify({
      units: "metric", decimals: 1, custom: {},
      location: { lat: 0, lon: 0, label: "Null Island", zone: "UTC", zoom: 11 },
    }));
  }, [base(src)]);
  await page.goto(host.url);
  await page.click("#tab-devices");
  await page.locator("#settings summary").click();
  await expect(page.locator("#settings-lat")).toHaveValue("0");
});

test("Save posts both $tz and $location when the serving origin is a configured source", async ({ page }) => {
  const server = await startServer({ devices: [ACURITE] });
  servers.push(server);
  await page.goto(server.url);
  await expect(page.locator("#status")).toHaveText(/^live/);
  await page.click("#tab-devices");
  await page.locator("#settings summary").click();
  await page.locator("#settings-lat").fill("40.015");
  await page.locator("#settings-lon").fill("-105.2705");
  await page.locator("#settings-lon").blur();

  await expect.poll(async () => (await server.get(server.source + "/$location")).status).toBe(200);
  const loc = JSON.parse((await server.get(server.source + "/$location")).body);
  expect(loc.lat).toBe(40.015);
  expect(loc.lon).toBe(-105.2705);
});
```

- [ ] **Step 2: Run it**

Run: `cd dashboard && npx playwright test test/location-propagation.spec.js`
Expected: all three tests pass. If the first test's `Clock`/`Sun` card locators don't match the app's actual `data-key` convention, check `dashboard/test/feed-cards.spec.js` for the exact selector pattern used there and align.

- [ ] **Step 3: Run the full dashboard suite**

Run: `cd dashboard && npm test`
Expected: all unit tests and all playwright specs pass.

- [ ] **Step 4: Commit**

```bash
git add dashboard/test/location-propagation.spec.js
git commit -m "test(dashboard): cover cross-origin \$location/\$tz propagation end to end"
```
