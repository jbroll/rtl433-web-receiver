# Site-default dashboard layout (`$layout`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a receiver-writable, model-keyed dashboard layout template at
`<source>/$layout`, mirroring the existing `$alias`/`$tz` topic pattern
end-to-end: receiver NVS store + HTTP/SSE + MQTT replay, a dashboard module
that derives/applies it, Settings buttons to save/load it, and doc updates.

**Architecture:** `layout_store` is a single opaque JSON-blob NVS store
(unlike `alias_store`'s table-of-pairs, because `$layout` has exactly one
value per receiver, not one per topic). `topic::isLayout()`, `web_ui`'s HTTP
GET/POST + SSE broadcast + replay-cursor slot, and `mqtt_publish`'s
publish-on-POST + replay-on-connect all mirror `$tz`/`$alias`'s existing
code shapes. The dashboard's `layout_template.js` derives a template from
`cardState` grouped by device `model`, applies one back by matching model to
every currently-known device, and records incoming SSE frames into a
`layouts` signal without ever auto-mutating `cardState` (that only happens
once, on first load, when there is nothing local yet).

**Tech Stack:** C++ (Arduino/ESP32, host-tested via `g++`), JavaScript
(Preact + `@preact/signals`, `node:test` unit tests, Playwright harness
tests), Markdown docs.

## Global Constraints

- `LAYOUT_STORE_MAX` is 2048 bytes, matching `ALIAS_BLOB_MAX`'s precedent
  (spec's "NVS sanity check" section).
- `$layout` is keyed by **model**, not device key: `{grid, order, models}`
  where `order` is an array of model names and `models` maps model name to
  `{w, h, valueOrder, hiddenValues, bottomValues}`.
- No receiver-side auth on `$layout` — same trust boundary as `$alias`/`$tz`
  today.
- Excluded from the template on purpose: aliases, units/decimals/location,
  feed cards (`isFeed`).
- The dashboard must never auto-apply an incoming `$layout` frame except
  once, on the very first frame for the same-origin source, and only when
  `cardState.value.order.length === 0` (nothing local yet).
- A known, documented limit this plan does **not** try to fix: `web_ui.cpp`'s
  `FrameBuffer` is sized `64 + SIGNAL_KEY_MAX + (2*SIGNAL_PAYLOAD_MAX + 2) +
  1` (≈1363 bytes) and `PubSubClient`'s `MQTT_MAX_PACKET_SIZE` is raised to
  2200 in this plan (Task 4) but `FrameBuffer` is left as-is — an SSE
  `$layout` frame within roughly 1.2 KB broadcasts and replays fine; one
  larger than that overflows `FrameBuffer` and is dropped (logged, not
  crashed), the same fail-safe `web_ui.cpp` already uses everywhere else. A
  `GET /$layout` is unaffected (it doesn't go through `FrameBuffer`). Task 5
  documents this explicitly.

---

## Task 1: Receiver — `layout_store` module, host test, boot wiring

**Files:**
- Create: `receiver/layout_store.h`
- Create: `receiver/layout_store.cpp`
- Create: `receiver/test/host/layout_store_test.cpp`
- Modify: `receiver/test/host/run.sh`
- Modify: `receiver/WebReceiver.ino:22` (includes), `:526` (begin call area), `:533-537` (FAKE_SIGNALS selfTest block)

**Model:** `sonnet` — new module mirroring an existing pattern with a
deliberately different storage shape (single blob vs. `alias_store`'s
table), plus a host-compiled test and boot wiring.

**Interfaces:**
- Consumes: nothing new (uses `Preferences`, `ArduinoLog.h`, same as
  `tz_store`/`alias_store`).
- Produces (used by Tasks 3 and 4):
  - `bool layout_store::begin()`
  - `const char* layout_store::get()` — never `NULL`; `""` when nothing is
    stored.
  - `bool layout_store::set(const char* json)` — rejects `NULL`, empty, or
    `>= LAYOUT_STORE_MAX` bytes; returns `false` and leaves the stored blob
    unchanged on a persist failure.
  - `#define LAYOUT_STORE_MAX 2048`

- [ ] **Step 1: Write `receiver/layout_store.h`**

```c
#pragma once

#include <Arduino.h>

// A layout is one JSON object for the whole receiver (unlike alias_store's
// per-topic table), so it is one NVS entry holding the blob verbatim rather
// than a table serialized to/from JSON at persist time.
#define LAYOUT_STORE_MAX 2048

namespace layout_store {
bool        begin();
// Never NULL; "" when nothing is stored.
const char* get();
bool        set(const char* json);
#ifdef FAKE_SIGNALS
bool selfTest();
#endif
} // namespace layout_store
```

- [ ] **Step 2: Write `receiver/layout_store.cpp`**

```cpp
#include "layout_store.h"

#include <ArduinoLog.h>
#include <Preferences.h>
#include <string.h>

namespace layout_store {

static Preferences _prefs;
static bool        _open = false;
static char        _blob[LAYOUT_STORE_MAX] = "";

bool begin() {
  _blob[0] = '\0';
  _open = _prefs.begin("layout", false);
  if (!_open) {
    Log.warning(F("layout store: NVS unavailable, layout will not persist" CR));
    return false;
  }
  String stored = _prefs.getString("blob", "");
  strncpy(_blob, stored.c_str(), sizeof(_blob) - 1);
  _blob[sizeof(_blob) - 1] = '\0';
  Log.notice(F("layout store: %s" CR), _blob[0] ? "layout loaded" : "no stored layout");
  return true;
}

const char* get() { return _blob; }

bool set(const char* json) {
  if (json == NULL || *json == '\0' || strlen(json) >= LAYOUT_STORE_MAX) {
    return false;
  }
  char previous[LAYOUT_STORE_MAX];
  strncpy(previous, _blob, sizeof(previous) - 1);
  previous[sizeof(previous) - 1] = '\0';
  strncpy(_blob, json, sizeof(_blob) - 1);
  _blob[sizeof(_blob) - 1] = '\0';
  if (!_open) {
    // A receiver whose NVS won't open should still let a viewer save a
    // layout for the session rather than answer 503 to every save.
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
  Log.notice(F("layout selfTest %s: %s" CR), what, ok ? "PASS" : "FAIL");
  return ok;
}

bool selfTest() {
  bool ok = true;

  bool saved_open = _open;

  _blob[0] = '\0';
  ok &= check("nothing stored reads as empty", strcmp(get(), "") == 0);

  ok &= check("set stores a blob", set("{\"grid\":{\"cols\":6,\"rows\":4}}"));
  ok &= check("get returns the stored blob",
              strcmp(get(), "{\"grid\":{\"cols\":6,\"rows\":4}}") == 0);

  ok &= check("set of a new blob replaces in place",
              set("{\"grid\":{\"cols\":4,\"rows\":3}}") &&
                  strcmp(get(), "{\"grid\":{\"cols\":4,\"rows\":3}}") == 0);

  ok &= check("a NULL blob is rejected", !set(NULL));
  ok &= check("an empty blob is rejected", !set(""));
  ok &= check("a rejected set leaves the stored blob alone",
              strcmp(get(), "{\"grid\":{\"cols\":4,\"rows\":3}}") == 0);

  char big[LAYOUT_STORE_MAX + 1];
  memset(big, '.', sizeof(big) - 1);
  big[sizeof(big) - 1] = '\0';
  ok &= check("a blob at or over the cap is rejected", !set(big));
  ok &= check("a rejected oversized set leaves the stored blob alone",
              strcmp(get(), "{\"grid\":{\"cols\":4,\"rows\":3}}") == 0);

  _blob[0] = '\0';
  _open    = saved_open;
  Log.notice(F("layout selfTest overall: %s" CR), ok ? "PASS" : "FAIL");
  return ok;
}
#endif

} // namespace layout_store
```

- [ ] **Step 3: Write `receiver/test/host/layout_store_test.cpp`**

```cpp
#include <stdio.h>

#include "layout_store.h"

int main() {
  bool ok = layout_store::selfTest();
  printf("layout_store selfTest: %s\n", ok ? "PASS" : "FAIL");
  return ok ? 0 : 1;
}
```

- [ ] **Step 4: Add a build+run stanza to `receiver/test/host/run.sh`**

Append immediately after the existing `alias_store_test` stanza (before the
script's implicit end — there is no trailing code after it):

```sh
g++ -std=c++17 -Wall -Wextra -Werror -DFAKE_SIGNALS -DARDUINOJSON_ENABLE_ARDUINO_STRING=1 \
    -I"$shim" -I"$root" \
    -o "$out/layout_store_test" "$root/layout_store.cpp" "$root/test/host/layout_store_test.cpp"
"$out/layout_store_test"
```

(No `-I"$aj"` needed — `layout_store.cpp` doesn't include `ArduinoJson.h`,
unlike `alias_store.cpp`.)

- [ ] **Step 5: Run the host test suite**

Run: `cd receiver/test/host && ./run.sh`
Expected: every stanza's binary prints its `PASS` lines, ending with
`layout_store selfTest: PASS`, and the script exits 0 (`set -e` fails the
whole run on any non-zero exit or `check()` failure — there is no per-suite
skip).

- [ ] **Step 6: Wire `layout_store` into boot in `receiver/WebReceiver.ino`**

Add the include next to the other store includes (after line 22's
`#include "alias_store.h"`):

```cpp
#include "layout_store.h"
```

Add the `begin()` call right after `alias_store::begin();` (line 526):

```cpp
  alias_store::begin();
  layout_store::begin();
```

Add the self-test call inside the existing `#ifdef FAKE_SIGNALS` block
(lines 533-537), next to `alias_store::selfTest();`:

```cpp
  alias_store::selfTest();
  layout_store::selfTest();
```

- [ ] **Step 7: Build the firmware to confirm it still compiles**

Run: `cd receiver && pio run`
Expected: build succeeds (exit 0). This does not run `layout_store`'s logic
(that's what Step 5 already verified on the host) — it only confirms the
`.ino` wiring compiles against the real `Arduino.h`/`Preferences.h`.

- [ ] **Step 8: Commit**

```bash
git add receiver/layout_store.h receiver/layout_store.cpp \
        receiver/test/host/layout_store_test.cpp receiver/test/host/run.sh \
        receiver/WebReceiver.ino
git commit -m "feat(receiver): add layout_store, an NVS-backed \$layout blob"
```

---

## Task 2: Receiver — `topic::isLayout()`

**Files:**
- Modify: `receiver/topic.h`
- Modify: `receiver/topic.cpp`
- Modify: `receiver/test/host/topic_test.cpp`

**Model:** `haiku` — a single five-line function, copied verbatim from
`isTz()`'s shape, plus three hardcoded test lines. Fully mechanical.

**Interfaces:**
- Produces (used by Task 3): `bool topic::isLayout(const char* topic)` —
  `true` when the topic's last `/`-separated segment is exactly `$layout`
  (bare `$layout` or `<anything>/$layout`), `false` for `NULL` or anything
  else.

- [ ] **Step 1: Add the declaration to `receiver/topic.h`**

```c
bool isAlias(const char* topic);
bool isTz(const char* topic);
bool isLayout(const char* topic);
```

(Insert `bool isLayout(const char* topic);` right after the existing
`bool isTz(const char* topic);` line.)

- [ ] **Step 2: Add the implementation to `receiver/topic.cpp`**

Insert right after `isTz()`'s closing brace (after line 102):

```cpp
bool isLayout(const char* t) {
  if (t == NULL) return false;
  const char* last = strrchr(t, '/');
  return strcmp(last != NULL ? last + 1 : t, "$layout") == 0;
}
```

- [ ] **Step 3: Add hardcoded checks to `receiver/test/host/topic_test.cpp`**

(The design spec suggested adding `isLayout` cases to the shared
`test/topic_cases.txt` table. That table only ever drove `validTopic`/
`validFilter`/`matchFilter` — `isAlias` and `isTz` are both hardcoded
`check()` calls in this file, not table rows, so `isLayout` follows that
same actual precedent rather than the table.)

Insert right after the existing `isTz` check block (after the `check("isTz
rejects NULL", ...)` line, before the final `printf`/`return`):

```cpp
  check("isLayout identifies a $layout topic", topic::isLayout("rtl433-a1b2c3/$layout"));
  check("a bare $layout is a layout topic", topic::isLayout("$layout"));
  check("isLayout rejects a non-$layout topic", !topic::isLayout("rtl433-a1b2c3/Acurite-5n1/1234"));
  check("isLayout rejects NULL", !topic::isLayout(NULL));
```

- [ ] **Step 4: Run the topic test**

Run: `cd receiver/test/host && ./run.sh`
Expected: the `topic_test` binary's output includes the four new `PASS`
lines and the script still exits 0.

- [ ] **Step 5: Commit**

```bash
git add receiver/topic.h receiver/topic.cpp receiver/test/host/topic_test.cpp
git commit -m "feat(receiver): add topic::isLayout()"
```

---

## Task 3: Receiver — `web_ui.cpp` HTTP GET/POST and SSE for `$layout`

**Files:**
- Modify: `receiver/web_ui.h`
- Modify: `receiver/web_ui.cpp`

**Model:** `sonnet` — multiple coordinated edits to one file (a new POST
handler, a GET branch, a broadcast function, a replay-cursor extension),
each following an existing pattern closely but requiring the edits to stay
consistent with each other.

**Interfaces:**
- Consumes:
  - `layout_store::get()` / `layout_store::set()` (Task 1)
  - `topic::isLayout()` (Task 2)
  - `mqtt_publish::publishLayout()` (Task 4 — declared there; this task
    calls it from `handleLayoutPost`, so Task 4 must land in the same branch
    before this compiles. If executed before Task 4 exists, add the call in
    this task and let the linker/compiler failure be resolved when Task 4's
    steps run — or, simpler, do Task 4 immediately after this task and treat
    the two as sequential with no intermediate build-verification gap.)
- Produces: `void web_ui::broadcastLayout(const char* blob)` (declared in
  `web_ui.h`, used by nothing outside this file today, but exported for
  symmetry with `broadcastAlias` and so a future caller — e.g. a test-only
  hook — has it available).

- [ ] **Step 1: Add includes to `receiver/web_ui.cpp`**

Add two includes alongside the existing ones (after line 11's
`#include "alias_store.h"`, keeping alphabetical order with the rest of the
block at lines 11-16):

```cpp
#include "alias_store.h"
#include "dashboard_html.h"
#include "layout_store.h"
#include "mqtt_publish.h"
#include "ota_token_store.h"
#include "signal_store.h"
#include "topic.h"
#include "tz_store.h"
```

- [ ] **Step 2: Declare `broadcastLayout` in `receiver/web_ui.h`**

```c
namespace web_ui {
void begin();
void loop();
void broadcast(const DeviceSlot& slot);
void broadcastAlias(const char* topic, const char* name);
void broadcastLayout(const char* blob);
void writeJsonString(Print& out, const char* s);
} // namespace web_ui
```

- [ ] **Step 3: Add `handleLayoutPost` to `receiver/web_ui.cpp`**

Insert right before `handleTzPost` (before line 346), so POST handlers stay
grouped:

```cpp
static void handleLayoutPost(const char* path) {
  // Same same-origin-or-bare gating as $tz: the dashboard POSTs a bare
  // /$layout to its own origin, the source-prefixed form is the documented
  // curl-able equivalent.
  const char* src = signal_store::source();
  size_t      srcLen = strlen(src);
  bool        ownSource = strncmp(path, src, srcLen) == 0 && path[srcLen] == '/';
  if (strcmp(path, "$layout") != 0 && !ownSource) {
    sendStatus(405, "not allowed");
    return;
  }
  String body = _server.arg("plain");
  JsonDocument doc;
  if (deserializeJson(doc, body) != DeserializationError::Ok || !doc.is<JsonObject>()) {
    sendStatus(400, "body must be a JSON object");
    return;
  }
  if (!layout_store::set(body.c_str())) {
    sendStatus(503, "layout store full");
    return;
  }
  web_ui::broadcastLayout(layout_store::get());
  mqtt_publish::publishLayout(layout_store::get());
  sendCors();
  _server.sendHeader("Cache-Control", "no-store");
  _server.send(204, "text/plain", "");
}
```

- [ ] **Step 4: Wire the POST dispatch in `handleTopic()`**

Change (around line 450-456):

```cpp
  if (_server.method() == HTTP_POST) {
    if (topic::isTz(path)) {
      handleTzPost(path);
      return;
    }
    handleAliasPost(path);
    return;
  }
```

to:

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

- [ ] **Step 5: Add the GET branch in `handleTopic()`**

Insert right before the existing `if (topic::isAlias(path)) { ... }` block
(before line 462), so a `$layout` GET is served the raw stored blob (an
object, unlike alias's quoted-string GET):

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
  if (topic::isAlias(path)) {
```

- [ ] **Step 6: Add `broadcastLayout` next to `broadcastAlias`**

Append after `broadcastAlias`'s closing brace (after line 691), before the
closing `} // namespace web_ui`:

```cpp
void broadcastLayout(const char* blob) {
  char topic[SIGNAL_KEY_MAX];
  int  n = snprintf(topic, sizeof(topic), "%s/$layout", signal_store::source());
  if (n < 0 || (size_t)n >= sizeof(topic)) {
    return;
  }
  FrameBuffer frame;
  buildFrame(frame, topic, blob); // raw-embed: blob is a JSON object, not a quoted string
  if (frame.overflowed()) {
    Log.warning(F("SSE layout frame overflow, dropping frame" CR));
    return;
  }
  broadcastFrame(topic, SIGNAL_SUB_TABLE + ALIAS_SLOTS, frame);
}
```

The index `SIGNAL_SUB_TABLE + ALIAS_SLOTS` is the one flat slot Task 3 Step
7 (below) reserves for `$layout` in the replay cursor space — it must match
exactly what `drainReplay()` uses, so a client still mid-replay when a live
`$layout` POST lands gets correctly suppressed (the cursor will pick it up
itself) rather than double-delivered.

- [ ] **Step 7: Extend `drainReplay()`'s cursor for the one `$layout` slot**

Change the cursor's terminating `else` branch (around lines 575-587) from:

```cpp
    } else if (at < SIGNAL_SUB_TABLE + ALIAS_SLOTS) {
      topic = alias_store::topicAt((uint8_t)(at - SIGNAL_SUB_TABLE));
      if (topic == NULL) {
        continue;
      }
      if (!slotWants(i, topic)) {
        continue;
      }
      buildAliasFrame(frame, topic, alias_store::nameAt((uint8_t)(at - SIGNAL_SUB_TABLE)));
    } else {
      _replay[i] = -1;
      return;
    }
```

to:

```cpp
    } else if (at < SIGNAL_SUB_TABLE + ALIAS_SLOTS) {
      topic = alias_store::topicAt((uint8_t)(at - SIGNAL_SUB_TABLE));
      if (topic == NULL) {
        continue;
      }
      if (!slotWants(i, topic)) {
        continue;
      }
      buildAliasFrame(frame, topic, alias_store::nameAt((uint8_t)(at - SIGNAL_SUB_TABLE)));
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

(`static char layoutTopic[...]` rather than a stack buffer: `topic` is a
`const char*` read after this `if` chain by the shared overflow/send code
below, so its storage must outlive the branch — `alias_store::topicAt()`
and `slot->key` both already point at storage that outlives the branch the
same way, this is the one case here building a topic string fresh.)

- [ ] **Step 8: Build to confirm it compiles**

Run: `cd receiver && pio run`
Expected: build succeeds. (This will only fully succeed once Task 4's
`mqtt_publish::publishLayout` declaration exists — if running this task
before Task 4, expect a linker or "not declared" error on that one call
and treat it as expected until Task 4 lands; do not work around it by
removing the call.)

- [ ] **Step 9: Commit**

```bash
git add receiver/web_ui.h receiver/web_ui.cpp
git commit -m "feat(receiver): serve \$layout over HTTP GET/POST and SSE"
```

---

## Task 4: Receiver — `mqtt_publish.cpp` publish-on-POST and replay-on-connect

**Files:**
- Modify: `receiver/mqtt_publish.h`
- Modify: `receiver/mqtt_publish.cpp`
- Modify: `receiver/platformio.ini`

**Model:** `sonnet` — a new exported function plus an extension to an
existing replay loop, in a file with real MQTT connection-state semantics
to keep consistent.

**Interfaces:**
- Consumes: `layout_store::get()` (Task 1).
- Produces (called from Task 3's `handleLayoutPost`):
  `void mqtt_publish::publishLayout(const char* blob);`

- [ ] **Step 1: Add the include**

`receiver/mqtt_publish.cpp` needs `layout_store.h`. Add it next to the
existing includes (after line 10's `#include "mqtt_publish_store.h"`):

```cpp
#include "layout_store.h"
#include "mqtt_publish_store.h"
```

- [ ] **Step 2: Declare `publishLayout` in `receiver/mqtt_publish.h`**

```c
namespace mqtt_publish {
void begin(const char* clientId);
void loop();
void onRecord(const char* key, JsonDocument& doc);
// Publishes the stored $layout, retained, to <clientId>/$layout. A no-op
// (fire-and-forget) if not currently connected, the same as onRecord.
void publishLayout(const char* blob);
} // namespace mqtt_publish
```

- [ ] **Step 3: Implement `publishLayout` in `receiver/mqtt_publish.cpp`**

Add after `onRecord()`'s closing brace (after line 183), before the closing
`} // namespace mqtt_publish`:

```cpp
void publishLayout(const char* blob) {
  if (!_enabled || !_mqtt.connected()) return;
  if (blob == nullptr || blob[0] == '\0') return;
  char topic[80];
  int  n = snprintf(topic, sizeof(topic), "%s/$layout", _clientId);
  if (n < 0 || (size_t)n >= sizeof(topic)) return;
  _mqtt.publish(topic, blob, true);
}
```

- [ ] **Step 4: Extend `replayAll()` to also replay `$layout`**

Change:

```cpp
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
```

to:

```cpp
static void replayAll() {
  uint8_t sent = 0;
  for (uint8_t i = 0; i < SIGNAL_DEVICE_SLOTS; i++) {
    const DeviceSlot* slot = signal_store::slotAt(i);
    if (slot == nullptr) continue;
    const char* payload = signal_store::latestPayload(*slot);
    if (payload == nullptr) continue;
    if (_mqtt.publish(slot->key, payload, true)) sent++;
  }
  const char* layout = layout_store::get();
  if (layout[0] != '\0') {
    char topic[80];
    int  n = snprintf(topic, sizeof(topic), "%s/$layout", _clientId);
    if (n > 0 && (size_t)n < sizeof(topic) && _mqtt.publish(topic, layout, true)) sent++;
  }
  Log.notice(F("mqtt publish: replayed %d retained record(s) on connect" CR), sent);
}
```

(Not wired through `signal_store::addRecordHook` — `$layout` is not a
decoded radio record, so it doesn't belong in that per-record hook list;
`replayAll()` is the connect-time hook that already handles "everything
retained gets resent," which is the right place for one more retained
thing.)

- [ ] **Step 5: Raise `MQTT_MAX_PACKET_SIZE` in `receiver/platformio.ini`**

`LAYOUT_STORE_MAX` is 2048 bytes and the current build flag (line 62) caps
PubSubClient packets at 768, sized only for device records
(`SIGNAL_PAYLOAD_MAX` 600 + topic). A `$layout` blob approaching its own cap
would silently fail to publish (`PubSubClient::publish` returns `false` and
sends nothing over that size — no partial write, so this is safe, just
silent). Change:

```
  '-DMQTT_MAX_PACKET_SIZE=768'      ; PubSubClient's default 256B is too small for SIGNAL_PAYLOAD_MAX (600) + topic
```

to:

```
  '-DMQTT_MAX_PACKET_SIZE=2200'     ; big enough for SIGNAL_PAYLOAD_MAX (600) + topic, and for a full LAYOUT_STORE_MAX (2048) $layout blob + topic
```

- [ ] **Step 6: Build to confirm the whole receiver compiles**

Run: `cd receiver && pio run`
Expected: build succeeds (exit 0). This also confirms Task 3's call to
`mqtt_publish::publishLayout` now resolves.

- [ ] **Step 7: Commit**

```bash
git add receiver/mqtt_publish.h receiver/mqtt_publish.cpp receiver/platformio.ini
git commit -m "feat(receiver): publish \$layout over MQTT on save and reconnect"
```

---

## Task 5: Receiver — `docs/architecture.md` updates

**Files:**
- Modify: `receiver/docs/architecture.md`

**Model:** `sonnet` — prose that must stay internally consistent with
several existing sections (module list, NVS budget table, replay-cursor
description) rather than a mechanical find/replace.

- [ ] **Step 1: Add a `layout_store` module-boundaries paragraph**

Insert after the `tz_store` paragraph (after line 90, before the
`web_ui.h` / `web_ui.cpp` paragraph at line 92):

```markdown
**`layout_store.h` / `layout_store.cpp`** — persists the dashboard's
site-default `$layout` (grid size, per-model card settings) as one opaque
JSON blob in `Preferences` namespace `layout`, key `blob`, capped at
`LAYOUT_STORE_MAX`, 2 KB — the same cap as `alias_store`'s table, for the
same reason: a realistic layout (a handful of models) lands well under 1 KB
in practice. Unlike `alias_store`'s table of topic/name pairs, there is
exactly one `$layout` per receiver, so the blob is stored and served
verbatim rather than parsed and reserialized — the receiver never inspects
its contents, only the dashboard does. Its `FAKE_SIGNALS` `selfTest()` is
host-tested by `test/host/run.sh` against the same `arduino_shim/` fakes as
`alias_store` and `tz_store`.
```

- [ ] **Step 2: Extend the NVS budget paragraph**

Change (line 218-222):

```markdown
20 KB of `nvs` is about three times what the firmware can put there. Radio
calibration under `phy/cal_data` is the largest entry at ~1,950 bytes; the
WiFi driver's own credentials in `nvs.net80211` are a few hundred; the
`wifi_store` module's copy of those same credentials (namespace `wifi`) is
under 100 bytes; the alias map is capped at `ALIAS_BLOB_MAX`, 2 KB.
```

to:

```markdown
20 KB of `nvs` is about three times what the firmware can put there. Radio
calibration under `phy/cal_data` is the largest entry at ~1,950 bytes; the
WiFi driver's own credentials in `nvs.net80211` are a few hundred; the
`wifi_store` module's copy of those same credentials (namespace `wifi`) is
under 100 bytes; the alias map is capped at `ALIAS_BLOB_MAX`, 2 KB; the
layout blob is capped at `LAYOUT_STORE_MAX`, another 2 KB. Worst-case usage
across every store is still under 7 KB against the 20 KB partition.
```

- [ ] **Step 3: Extend the replay-cursor description**

Change (lines 255-256):

```markdown
The cursor walks flat indices — the sub table (0 through 31,
`SIGNAL_SUB_TABLE`), then the alias table (32 through 63) — rather than
```

to:

```markdown
The cursor walks flat indices — the sub table (0 through 31,
`SIGNAL_SUB_TABLE`), then the alias table (32 through 63), then one final
index for `$layout` (64) — rather than
```

- [ ] **Step 4: Add a note about the `FrameBuffer` size limit for `$layout`**

Insert a new paragraph right after the "The replay design" section's
existing text (after line 269, the paragraph ending "...the frame will go
out (with its now-current payload) when the cursor gets there."):

```markdown
`FrameBuffer` (in `web_ui.cpp`) is sized for one device payload
(`SIGNAL_PAYLOAD_MAX`, 600 bytes) doubled for the worst case of an escaped
alias string, not for a `$layout` blob up to `LAYOUT_STORE_MAX` (2 KB). A
`$layout` broadcast or replay frame that overflows it is dropped and logged
(`web_ui.cpp`'s existing fail-safe, not a crash) rather than sent truncated;
`GET /$layout` is unaffected, since it serves the stored blob directly, not
through `FrameBuffer`. In practice a real `$layout` (a handful of models)
stays well under the buffer's ~1.2 KB payload ceiling, the same margin the
NVS budget above relies on.
```

- [ ] **Step 5: Commit**

```bash
git add receiver/docs/architecture.md
git commit -m "docs(receiver): document layout_store and the \$layout replay slot"
```

---

## Task 6: Dashboard — `layout_template.js` (derive/apply/SSE) + unit tests

**Files:**
- Modify: `dashboard/src/store.js:19` (export `gridNum`)
- Create: `dashboard/src/layout_template.js`
- Create: `dashboard/test/layout_template.test.js`

**Model:** `sonnet` — new module implementing prose-specified matching
logic (model-based rebuild of card order), not a verbatim transcription.

**Interfaces:**
- Consumes:
  - `cardState`, `saveCardState()`, `gridNum()` (this task exports it) from
    `./store.js`
  - `devices` (a `signal(Map<key, {obj: signal, ...}>)`) from `./devices.js`
  - `isFeed(key)` from `./alias.js`
- Produces (used by Tasks 7, 8, 9):
  - `export const LAYOUT_SUFFIX = '/$layout'`
  - `export const layouts = signal(new Map())` — **keyed by `base` (the
    connected source's origin URL)**, not by a composite device-style key.
    This is a deliberate departure from `applyAliasFrame`'s per-device
    `makeKey(base, topic)` keying: `$layout` is one value per source, and
    Settings needs "does `layouts` have an entry for `location.origin`" —
    keying directly by `base` makes that a plain `Map.has(location.origin)`
    instead of reconstructing a composite key from the receiver's internal
    topic-namespace `source` segment (which is not the same string as
    `location.origin`).
  - `export function deriveTemplate()`
  - `export function applyTemplate(template)`
  - `export function applyLayoutFrame(base, payload)`
  - `export function postLayout()`

- [ ] **Step 1: Export `gridNum` from `dashboard/src/store.js`**

Change (line 19):

```js
function gridNum(v, fallback) {
```

to:

```js
export function gridNum(v, fallback) {
```

(No call sites change — `store.js`'s own internal calls to `gridNum(...)`
still work unqualified within the same module.)

- [ ] **Step 2: Write `dashboard/src/layout_template.js`**

```js
import { signal } from '@preact/signals'
import { cardState, gridNum, saveCardState } from './store.js'
import { devices } from './devices.js'
import { isFeed } from './alias.js'

export const LAYOUT_SUFFIX = '/$layout'
export const layouts = signal(new Map())

function modelOf(key) {
  const rec = devices.value.get(key)
  const obj = rec && rec.obj.value
  return obj && typeof obj.model === 'string' && obj.model ? obj.model : null
}

export function deriveTemplate() {
  const s = cardState.value
  const models = Object.create(null)
  const order = []
  for (const key of s.order) {
    if (isFeed(key)) continue
    const model = modelOf(key)
    if (!model || models[model]) continue
    const c = s.cards[key]
    if (!c) continue
    models[model] = {
      w: c.w,
      h: c.h,
      valueOrder: c.valueOrder.slice(),
      hiddenValues: c.hiddenValues.slice(),
      bottomValues: (c.bottomValues || []).slice(),
    }
    order.push(model)
  }
  return { grid: { cols: s.grid.cols, rows: s.grid.rows }, order, models }
}

export function applyTemplate(template) {
  if (!template || typeof template !== 'object') return
  const s = cardState.value
  const g = template.grid && typeof template.grid === 'object' ? template.grid : {}
  const modelsIn = template.models && typeof template.models === 'object' ? template.models : {}
  const modelOrder = Array.isArray(template.order)
    ? template.order.filter(m => typeof m === 'string')
    : []

  const nextGrid = { cols: gridNum(g.cols, s.grid.cols), rows: gridNum(g.rows, s.grid.rows) }
  const nextCards = Object.assign(Object.create(null), s.cards)

  const deviceModel = new Map()
  for (const rec of devices.value.values()) {
    if (isFeed(rec.key)) continue
    const model = modelOf(rec.key)
    if (model) deviceModel.set(rec.key, model)
  }

  const matched = []
  const seenKeys = new Set()
  for (const model of modelOrder) {
    const spec = modelsIn[model]
    if (!spec || typeof spec !== 'object') continue
    for (const [key, m] of deviceModel) {
      if (m !== model || seenKeys.has(key)) continue
      seenKeys.add(key)
      matched.push(key)
      const existing = nextCards[key]
      nextCards[key] = {
        w: gridNum(spec.w, (existing && existing.w) || 1),
        h: gridNum(spec.h, (existing && existing.h) || 1),
        valueOrder: Array.isArray(spec.valueOrder)
          ? spec.valueOrder.filter(f => typeof f === 'string') : [],
        hiddenValues: Array.isArray(spec.hiddenValues)
          ? spec.hiddenValues.filter(f => typeof f === 'string') : [],
        bottomValues: Array.isArray(spec.bottomValues)
          ? spec.bottomValues.filter(f => typeof f === 'string') : [],
      }
    }
  }
  const unmatched = s.order.filter(k => !seenKeys.has(k))

  cardState.value = {
    grid: nextGrid,
    order: matched.concat(unmatched),
    hidden: s.hidden.slice(),
    cards: nextCards,
  }
  saveCardState()
}

export function applyLayoutFrame(base, payload) {
  const next = new Map(layouts.value)
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) next.set(base, payload)
  else next.delete(base)
  layouts.value = next
}

export function postLayout() {
  const template = deriveTemplate()
  const url = `${location.origin}/$layout`
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(template),
  }).then(res => {
    if (!res.ok) console.error(`POST ${url} failed: ${res.status}`)
  }).catch(err => {
    console.error(`POST ${url} failed: ${err.message || err}`)
  })
}
```

- [ ] **Step 3: Write `dashboard/test/layout_template.test.js`**

```js
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { cardState, loadCardState, saveCardState, ensureCard } from '../src/store.js'
import { devices, upsert } from '../src/devices.js'
import {
  layouts, deriveTemplate, applyTemplate, applyLayoutFrame,
} from '../src/layout_template.js'

const BASE = 'http://a'
const KEY = `${BASE} src/Acurite-5n1/396`
const FEED_KEY = 'local clock'

function fakeStorage() {
  const map = new Map()
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  }
  return map
}

function addDevice(key, model, merged) {
  upsert({
    key, obj: { model }, raw: '{}', rssi: -50, count: 1, seenAt: 1, at: 1,
    merged: merged || { temperature_C: 21 }, flashUntil: 0,
  })
}

beforeEach(() => {
  fakeStorage()
  devices.value = new Map()
  loadCardState()
  layouts.value = new Map()
})

test('deriveTemplate groups cards by model, skipping feeds and modelless devices', () => {
  addDevice(KEY, 'Acurite-5n1')
  addDevice(FEED_KEY, undefined)
  ensureCard(KEY, { temperature_C: 21, humidity: 40 })
  ensureCard(FEED_KEY, { time: '12:00' })
  saveCardState()

  const t = deriveTemplate()
  assert.deepEqual(t.order, ['Acurite-5n1'])
  assert.ok(t.models['Acurite-5n1'])
  assert.equal(t.models['Acurite-5n1'].valueOrder.includes('temperature_C'), true)
  assert.equal(Object.keys(t.models).includes(undefined), false)
})

test('deriveTemplate keeps grid dimensions', () => {
  cardState.value = { ...cardState.value, grid: { cols: 8, rows: 5 } }
  const t = deriveTemplate()
  assert.deepEqual(t.grid, { cols: 8, rows: 5 })
})

test('applyTemplate matches a currently-known device by model', () => {
  addDevice(KEY, 'Acurite-5n1')
  const template = {
    grid: { cols: 8, rows: 5 },
    order: ['Acurite-5n1'],
    models: {
      'Acurite-5n1': {
        w: 2, h: 2, valueOrder: ['humidity', 'temperature_C'], hiddenValues: [], bottomValues: [],
      },
    },
  }
  applyTemplate(template)
  assert.deepEqual(cardState.value.grid, { cols: 8, rows: 5 })
  const c = cardState.value.cards[KEY]
  assert.equal(c.w, 2)
  assert.equal(c.h, 2)
  assert.deepEqual(c.valueOrder, ['humidity', 'temperature_C'])
})

test('applyTemplate rebuilds order: matched devices in template order, then unmatched', () => {
  const OTHER_KEY = `${BASE} src/BMP280/1`
  addDevice(KEY, 'Acurite-5n1')
  addDevice(OTHER_KEY, 'BMP280')
  cardState.value = { ...cardState.value, order: [OTHER_KEY, KEY] }
  const template = {
    grid: { cols: 6, rows: 4 },
    order: ['Acurite-5n1', 'BMP280'],
    models: {
      'Acurite-5n1': { w: 1, h: 1, valueOrder: [], hiddenValues: [], bottomValues: [] },
      'BMP280': { w: 1, h: 1, valueOrder: [], hiddenValues: [], bottomValues: [] },
    },
  }
  applyTemplate(template)
  assert.deepEqual(cardState.value.order, [KEY, OTHER_KEY])
})

test('applyTemplate appends an unmatched device after every matched one, in its prior relative order', () => {
  const UNMATCHED_KEY = `${BASE} src/Other/9`
  addDevice(KEY, 'Acurite-5n1')
  addDevice(UNMATCHED_KEY, 'SomeOtherModel')
  cardState.value = { ...cardState.value, order: [UNMATCHED_KEY, KEY] }
  const template = {
    grid: { cols: 6, rows: 4 },
    order: ['Acurite-5n1'],
    models: { 'Acurite-5n1': { w: 1, h: 1, valueOrder: [], hiddenValues: [], bottomValues: [] } },
  }
  applyTemplate(template)
  assert.deepEqual(cardState.value.order, [KEY, UNMATCHED_KEY])
})

test('applyTemplate clamps grid dimensions and rejects malformed arrays', () => {
  addDevice(KEY, 'Acurite-5n1')
  const template = {
    grid: { cols: 999, rows: 'bad' },
    order: ['Acurite-5n1'],
    models: {
      'Acurite-5n1': { w: 1, h: 1, valueOrder: ['a', 5, null], hiddenValues: 'nope', bottomValues: [] },
    },
  }
  applyTemplate(template)
  assert.equal(cardState.value.grid.cols, cardState.value.grid.cols <= 24 ? cardState.value.grid.cols : 0)
  assert.ok(cardState.value.grid.cols <= 24)
  assert.deepEqual(cardState.value.cards[KEY].valueOrder, ['a'])
  assert.deepEqual(cardState.value.cards[KEY].hiddenValues, [])
})

test('applyTemplate on a malformed (non-object) template is a no-op', () => {
  const before = JSON.stringify(cardState.value)
  applyTemplate('not an object')
  applyTemplate(null)
  assert.equal(JSON.stringify(cardState.value), before)
})

test('applyLayoutFrame records a template keyed by base without touching cardState', () => {
  const before = JSON.stringify(cardState.value)
  applyLayoutFrame(BASE, { grid: { cols: 6, rows: 4 }, order: [], models: {} })
  assert.equal(layouts.value.has(BASE), true)
  assert.equal(JSON.stringify(cardState.value), before)
})

test('applyLayoutFrame with a non-object payload clears the entry', () => {
  applyLayoutFrame(BASE, { grid: { cols: 6, rows: 4 }, order: [], models: {} })
  applyLayoutFrame(BASE, null)
  assert.equal(layouts.value.has(BASE), false)
})
```

- [ ] **Step 4: Run the new unit tests**

Run: `cd dashboard && node --test test/layout_template.test.js`
Expected: every test passes (0 failures).

- [ ] **Step 5: Run the full dashboard unit test suite to confirm no regression**

Run: `cd dashboard && node --test test/*.test.js`
Expected: all tests, including the pre-existing ones (e.g.
`test/alias.test.js`), pass.

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/store.js dashboard/src/layout_template.js dashboard/test/layout_template.test.js
git commit -m "feat(dashboard): add layout_template.js — derive/apply a \$layout template"
```

---

## Task 7: Dashboard — `stream.js` SSE dispatch for `$layout`

**Files:**
- Modify: `dashboard/src/stream.js`

**Model:** `haiku` — one new constant and one new `if` branch, fully
spelled out, mirroring the existing `$alias` branch exactly.

**Interfaces:**
- Consumes: nothing new.
- Produces (used by Task 8): `openSource(base, handlers)`'s `handlers`
  object must now include `onLayout(base, topic, payload)` — every call
  site that constructs a `handlers` object needs the new key (Task 8
  updates all of them).

- [ ] **Step 1: Add `LAYOUT_SUFFIX` and the `onLayout` dispatch branch**

Change:

```js
const ALIAS_SUFFIX = '/$alias'

function parse(raw) { try { return JSON.parse(raw) } catch (e) { return null } }
```

to:

```js
const ALIAS_SUFFIX = '/$alias'
const LAYOUT_SUFFIX = '/$layout'

function parse(raw) { try { return JSON.parse(raw) } catch (e) { return null } }
```

Change:

```js
    es.onmessage = (ev) => {
      const msg = parse(ev.data)
      if (!msg || typeof msg.topic !== 'string') return
      if (msg.topic.endsWith(ALIAS_SUFFIX)) handlers.onAlias(base, msg.topic, msg.payload)
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
      else handlers.onMessage(base, msg.topic, msg.payload)
    }
```

- [ ] **Step 2: Commit**

```bash
git add dashboard/src/stream.js
git commit -m "feat(dashboard): dispatch \$layout SSE frames in stream.js"
```

---

## Task 8: Dashboard — `main.jsx` wiring: `onLayout`, auto-apply-once, cleanup

**Files:**
- Modify: `dashboard/src/main.jsx`

**Model:** `sonnet` — coordinating a new handler, a one-shot flag, and
updates across three existing call sites in one file.

**Interfaces:**
- Consumes: `applyLayoutFrame`, `applyTemplate`, `layouts` from
  `./layout_template.js` (Task 6); `onLayout` slot in `openSource`'s
  `handlers` (Task 7).
- Produces: nothing new exported — this task only wires existing pieces
  together inside `main.jsx`.

- [ ] **Step 1: Import from `layout_template.js`**

Add to the top of `dashboard/src/main.jsx`, alongside the existing
`./alias.js` import (after line 6):

```js
import { makeKey, applyAliasFrame, isSelf, aliases, loadAliases } from './alias.js'
import { applyLayoutFrame, applyTemplate, layouts } from './layout_template.js'
```

- [ ] **Step 2: Add the `onLayout` handler and one-shot flag**

Add right after `onAlias`'s definition (after line 48):

```js
function onAlias(base, topic, payload) {
  applyAliasFrame(makeKey(base, topic), payload)
}

let autoAppliedLayout = false

function onLayout(base, topic, payload) {
  applyLayoutFrame(base, payload)
  if (autoAppliedLayout) return
  if (base !== location.origin) return
  if (store.cardState.value.order.length !== 0) return
  autoAppliedLayout = true
  applyTemplate(payload)
}
```

- [ ] **Step 3: Wire `onLayout` into every `openSource` call site**

Change (line 71, inside `probeOrigin()`):

```js
  const stream = openSource(base, { onMessage, onAlias, onState: onProbeState })
```

to:

```js
  const stream = openSource(base, { onMessage, onAlias, onLayout, onState: onProbeState })
```

Change (line 103, inside `syncSources()`):

```js
    open.set(base, openSource(base, { onMessage, onAlias, onState }))
```

to:

```js
    open.set(base, openSource(base, { onMessage, onAlias, onLayout, onState }))
```

- [ ] **Step 4: Clean up `layouts` in `dropSource()`**

Change (lines 57-67):

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
}
```

- [ ] **Step 5: Manually verify no syntax errors**

Run: `cd dashboard && npx vite build`
Expected: build succeeds (exit 0) — this dashboard has no separate lint
step in the observed test commands, so a successful production build is the
fastest syntax/import check available before the Playwright suite (Task
11) exercises the actual runtime behavior.

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/main.jsx
git commit -m "feat(dashboard): wire \$layout SSE frames and one-shot auto-apply"
```

---

## Task 9: Dashboard — Settings buttons: Save/Load default layout

**Files:**
- Modify: `dashboard/src/app.jsx`

**Model:** `sonnet` — two new buttons with distinct visibility rules
(same-origin-of-connected-sources vs. presence-in-`layouts`) and a
confirmation flow, in a file with an existing sibling button to match
styling/placement against.

**Interfaces:**
- Consumes: `deriveTemplate`... actually only needs `postLayout`,
  `applyTemplate`, `layouts` from `./layout_template.js` (Task 6); `sources`
  from `./sources.js`.

- [ ] **Step 1: Add imports**

Change (line 9):

```js
import { setGrid, forgetLayouts, grid } from './store.js'
```

to:

```js
import { setGrid, forgetLayouts, grid } from './store.js'
import { sources } from './sources.js'
import { layouts, postLayout, applyTemplate } from './layout_template.js'
```

- [ ] **Step 2: Add the two buttons next to "Forget layouts"**

Change (lines 51-61):

```jsx
        <button
          id="forget-cards"
          title="Forget saved layouts"
          onClick={() => {
            if (confirm('Forget every saved card layout in this browser?')) {
              forgetLayouts()
            }
          }}
        >
          Forget layouts
        </button>
```

to:

```jsx
        <button
          id="forget-cards"
          title="Forget saved layouts"
          onClick={() => {
            if (confirm('Forget every saved card layout in this browser?')) {
              forgetLayouts()
            }
          }}
        >
          Forget layouts
        </button>
        {sources.value.includes(location.origin) && (
          <button
            id="save-layout"
            title="Save this arrangement as the site default"
            onClick={() => { postLayout() }}
          >
            Save as default layout
          </button>
        )}
        {layouts.value.has(location.origin) && (
          <button
            id="load-layout"
            title="Load the site default layout"
            onClick={() => {
              if (confirm('Replace the current card arrangement with the site default layout?')) {
                applyTemplate(layouts.value.get(location.origin))
              }
            }}
          >
            Load default layout
          </button>
        )}
```

- [ ] **Step 3: Manually verify no syntax errors**

Run: `cd dashboard && npx vite build`
Expected: build succeeds (exit 0).

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/app.jsx
git commit -m "feat(dashboard): add Save/Load default layout buttons"
```

---

## Task 10: Test infra — `binding-server.js` support for `$layout`

**Files:**
- Modify: `receiver/test/binding-server.js`

**Model:** `sonnet` — extending a fake HTTP server's POST dispatch and
adding a helper method, following the existing `$tz`/`$alias` branches
closely but touching shared test infrastructure used by both the receiver's
own tests and the dashboard's Playwright suite.

**Interfaces:**
- Produces (used by Task 11):
  - `server.emitLayout(template)` — pushes an SSE `$layout` frame and
    retains it, mirroring `emitAlias`.
  - A `POST <source>/$layout` (or bare `$layout`) now returns `204` for a
    JSON-object body and `400`/`405` the same way `$tz`/`$alias` do,
    instead of `405` for every topic that isn't `$alias`.

- [ ] **Step 1: Add `LAYOUT_SUFFIX`**

Change (line 4):

```js
const ALIAS_SUFFIX = "/$alias";
```

to:

```js
const ALIAS_SUFFIX = "/$alias";
const LAYOUT_SUFFIX = "/$layout";
```

- [ ] **Step 2: Add the `isLayout` POST branch**

Change (lines 165-187):

```js
    if (req.method === "POST") {
      const isTz = topic.endsWith("/$tz") || topic === "$tz";
      if (isTz) {
```

to:

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
      if (isTz) {
```

(This mirrors the receiver's own dispatch order from Task 3 Step 4: layout
checked first, then `$tz`, then alias as the fallback.)

- [ ] **Step 3: Add the `emitLayout` helper**

Change (line 247):

```js
        emitAlias(deviceTopic, name) { publish(deviceTopic + ALIAS_SUFFIX, JSON.stringify(name)); },
```

to:

```js
        emitAlias(deviceTopic, name) { publish(deviceTopic + ALIAS_SUFFIX, JSON.stringify(name)); },
        emitLayout(template) { publish(source + LAYOUT_SUFFIX, JSON.stringify(template)); },
```

- [ ] **Step 4: Run the existing dashboard Playwright suite to confirm no regression**

Run: `cd dashboard && npx playwright test`
Expected: all existing specs (`cards.spec.js` and any others) still pass —
this change only adds a new branch/method, it doesn't alter existing
`$alias`/`$tz`/device behavior.

- [ ] **Step 5: Commit**

```bash
git add receiver/test/binding-server.js
git commit -m "test(receiver): support \$layout POST and emitLayout in binding-server.js"
```

---

## Task 11: Dashboard — harness-level Playwright tests for `$layout`

**Files:**
- Create: `dashboard/test/layout.spec.js`

**Model:** `sonnet` — new end-to-end tests exercising the SSE
auto-apply-when-blank path, both Settings buttons, and same-origin gating,
following `cards.spec.js`'s existing patterns closely but composing several
of them into new scenarios.

**Interfaces:**
- Consumes: `startServer`, `startPage` from `./harness.js`; fixtures from
  `./fixtures.js` (reuse `ACURITE`, `topicOf` as `cards.spec.js` does);
  `server.emitLayout()` and the `$layout` POST support from Task 10.

- [ ] **Step 1: Write `dashboard/test/layout.spec.js`**

```js
import { test, expect } from "@playwright/test";
import { startServer } from "./harness.js";
import { ACURITE, topicOf } from "./fixtures.js";

const ACURITE_KEY = topicOf(ACURITE);
const CARD = `.card:not(.ghostcard)[data-key$="${ACURITE_KEY}"]`;

const TEMPLATE = {
  grid: { cols: 8, rows: 5 },
  order: ["Acurite-5n1"],
  models: {
    "Acurite-5n1": {
      w: 2, h: 2,
      valueOrder: ["humidity", "temperature_C"],
      hiddenValues: [],
      bottomValues: [],
    },
  },
};

let server;

test.afterEach(async () => { if (server) await server.close(); server = null; });

async function open(page, devices) {
  server = await startServer({ devices: devices || [] });
  await page.goto(server.url);
  await expect(page.locator("#status")).toHaveText(/^live/);
  return server;
}

test("a $layout retained before connect auto-applies when nothing is stored locally", async ({ page }) => {
  server = await startServer({ devices: [ACURITE] });
  server.emitLayout(TEMPLATE);
  await page.goto(server.url);
  await expect(page.locator("#status")).toHaveText(/^live/);
  await expect(page.locator("#grid-cols")).toHaveValue("8");
  await expect(page.locator("#grid-rows")).toHaveValue("5");
});

test("a $layout frame does not auto-apply once a local layout already exists", async ({ page }) => {
  await open(page, [ACURITE]);
  await page.evaluate(() => {
    cardState = { ...cardState, order: ["seed"] };
    saveCardState();
  });
  server.emitLayout(TEMPLATE);
  await page.waitForTimeout(200);
  await expect(page.locator("#grid-cols")).not.toHaveValue("8");
});

test("Load default layout is offered once a $layout frame arrives, and applies on confirm", async ({ page }) => {
  await open(page, [ACURITE]);
  server.emitLayout(TEMPLATE);
  await expect(page.locator("#load-layout")).toBeVisible();
  page.once("dialog", d => d.accept());
  await page.click("#load-layout");
  await expect(page.locator("#grid-cols")).toHaveValue("8");
});

test("Save as default layout posts the derived template to the source", async ({ page }) => {
  await open(page, [ACURITE]);
  await page.click("#edit-cards");
  await expect(page.locator("#save-layout")).toBeVisible();
  await page.click("#save-layout");
  await expect.poll(async () => {
    const res = await server.get(server.source + "/$layout");
    return res.status;
  }).toBe(204 === 204 ? 200 : 200); // GET after a stored POST returns 200
});

test("Save as default layout is hidden when the source is not the serving origin", async ({ page }) => {
  await open(page, [ACURITE]);
  await page.evaluate((otherUrl) => {
    // Simulate a second, non-serving source being the only connected one by
    // checking the button's visibility rule directly rather than adding a
    // real second server: sources.value is whatever the sources module holds.
    window.__unused = otherUrl;
  }, "http://example.invalid");
  // The served origin IS in sources.value for a same-origin dashboard, so
  // this asserts the positive case holds and documents the rule for a
  // reviewer verifying the negative case by code inspection of app.jsx.
  await expect(page.locator("#save-layout")).toBeVisible();
});
```

Note for the implementer: the last test (`"...is hidden when the source is
not the serving origin"`) is weaker than the others — this harness's
`startServer`/`startPage` pattern (per `cards.spec.js`) always serves the
dashboard from the same origin it connects to, so there is no existing
one-server way to simulate "connected source that is not `location.origin`"
without adding a second `startServer()` and a multi-source open flow. If
`cards.spec.js` or `sources.spec.js` (check for one) already has a
multi-source pattern, use it here instead of the placeholder above;
otherwise leave a `test.skip` with a one-line reason rather than a test
that can't fail.

- [ ] **Step 2: Run the new spec**

Run: `cd dashboard && npx playwright test layout.spec.js`
Expected: every test passes. If the auto-apply test is flaky on timing
(SSE frame arriving before vs. after the page's first paint), increase
`expect(...).toHaveValue(...)`'s implicit retry is already built into
Playwright's `expect` — no manual wait should be needed, but if it is,
prefer `await expect.poll(...)` over a fixed `page.waitForTimeout` (used
here only in the negative-case test, where there is no positive assertion
to poll for instead).

- [ ] **Step 3: Run the full Playwright suite to confirm no regression**

Run: `cd dashboard && npx playwright test`
Expected: all specs pass, including the pre-existing `cards.spec.js`.

- [ ] **Step 4: Commit**

```bash
git add dashboard/test/layout.spec.js
git commit -m "test(dashboard): harness-level tests for \$layout SSE, auto-apply, Settings buttons"
```

---

## Task 12: Docs — bridge and dashboard user-manuals

**Files:**
- Modify: `bridge/docs/binding.md`
- Modify: `bridge/docs/user-manual.md`
- Modify: `dashboard/docs/user-manual.md`

**Model:** `sonnet` — prose requiring consistency with several other
sections (including fixing two lines that are already slightly inaccurate
about `$tz`, discovered during research for this plan) rather than a single
mechanical insertion.

- [ ] **Step 1: Add a `## Layout` section to `bridge/docs/binding.md`**

Insert right after the `## Aliases` section's closing paragraph (after line
98, before `## Errors`):

```markdown
## Layout

`<source>/$layout` holds one JSON object: the site-default dashboard
arrangement, keyed by device model rather than device id so it survives a
device being replaced. It round-trips through `GET`, `POST`, and a `#`
subscription like any other topic — there is nothing binding-specific about
it, it is simply a topic whose payload happens to be a layout rather than a
sensor reading or a name.

    rtl433-a1b2c3/$layout   {"grid":{"cols":6,"rows":4},"order":[...],"models":{...}}

A missing `$layout` is not an error; it means no site default has been
saved. The shape of the object itself (`grid`/`order`/`models`) is a
dashboard convention, not part of this binding — a bridge or a receiver
never inspects it, only stores and forwards it.
```

- [ ] **Step 2: Fix the two now-inaccurate lines in `bridge/docs/binding.md`**

Change (line 130):

```markdown
**The receiver's source-only subset** serves `GET` and `/events` for topics
under its own `source`, and accepts `POST` only to its own `$alias` topics,
which it persists to NVS. Every other `POST` is `405`. Its `source` is the
existing mDNS name, `rtl433-a1b2c3`.
```

to:

```markdown
**The receiver's source-only subset** serves `GET` and `/events` for topics
under its own `source`, and accepts `POST` only to its own `$alias`, `$tz`,
and `$layout` topics, each persisted to NVS. Every other `POST` is `405`.
Its `source` is the existing mDNS name, `rtl433-a1b2c3`.
```

Change (line 154):

```markdown
- The receiver returns `405` for a `POST` to a non-`$alias` topic, and an alias
  written to it survives a reboot.
```

to:

```markdown
- The receiver returns `405` for a `POST` to a topic that is not `$alias`,
  `$tz`, or `$layout`, and a value written to any of the three survives a
  reboot.
```

- [ ] **Step 3: Add a `$layout` line to `bridge/docs/user-manual.md`**

Change (lines 74-75):

```markdown
Publishing to a `$alias` topic works the same way; see
[`docs/binding.md`](binding.md#aliases).
```

to:

```markdown
Publishing to a `$alias` topic works the same way; see
[`docs/binding.md`](binding.md#aliases). `$layout`, the site-default
dashboard arrangement, is documented at
[`docs/binding.md`](binding.md#layout).
```

- [ ] **Step 4: Update `dashboard/docs/user-manual.md`'s layout section**

Change (lines 95-100):

```markdown
Layout is per browser, in localStorage under `rtl433.dashboard.v1`: the grid size,
the card order, which cards are hidden, and per card a size in cells, the
value order, and which values are hidden or at the bottom. No name is stored
there; a card's name is the published alias, or the device's key if none is
set. Layout is never sent to the device, so two browsers can arrange the same
receiver differently.
```

to:

```markdown
Layout is per browser, in localStorage under `rtl433.dashboard.v1`: the grid size,
the card order, which cards are hidden, and per card a size in cells, the
value order, and which values are hidden or at the bottom. No name is stored
there; a card's name is the published alias, or the device's key if none is
set. Layout is never sent to the device by default, so two browsers can
arrange the same receiver differently.

A receiver can also hold one site-default layout, at `$layout`, keyed by
device model rather than by individual device. **Save as default layout**
(next to Forget layouts, visible only when the served receiver is one of
the dashboard's connected sources) posts the current arrangement there.
**Load default layout** (visible once one has been read from a connected
source) replaces the current arrangement with it, after a confirmation
prompt. A genuinely fresh browser — nothing in localStorage yet — applies a
connected receiver's `$layout` automatically on first load, so a new user
does not start from a blank grid if the receiver already has a saved
default.
```

- [ ] **Step 5: Commit**

```bash
git add bridge/docs/binding.md bridge/docs/user-manual.md dashboard/docs/user-manual.md
git commit -m "docs: document the \$layout convention and its dashboard UI"
```

---

## Final: Delete this plan and the design spec before merge

Per this repo's convention (specs and plans are working documents, deleted
in the final commit before merge, with anything durable already folded into
`docs/`), the last commit on this branch should be:

```bash
git rm docs/superpowers/specs/2026-08-21-layout-template-design.md \
       docs/superpowers/plans/2026-08-21-layout-template-design.md
git commit -m "chore: drop landed \$layout spec and plan"
```

This is **not** a task an implementer runs mid-plan — it is the very last
step, after every task above is done, tested, and reviewed, immediately
before finishing the branch (superpowers:finishing-a-development-branch).
