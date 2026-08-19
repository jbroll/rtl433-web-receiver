# Daily Rainfall Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Derive `rain_today_mm` on the receiver from the weather station's cumulative `rain_mm`, reset at local midnight, using a per-device-type hook that augments decoded payloads before store and forward.

**Architecture:** A new Arduino-free `device_hooks` module holds the rain baseline logic and a model→hook registry. `signal_store` gains an optional `RecordHook` callback it calls after parsing and stamping, before storing. A `Reading` struct bridges `signal_store` (ArduinoJson) and `device_hooks` (plain C++), keeping `device_hooks` host-testable. A `tz_store` module persists a signed GMT offset in NVS; the dashboard POSTs the offset to `/$tz` when the location is set.

**Tech Stack:** C++17 (firmware), ArduinoJson, ESP32 Preferences (NVS), Preact signals + esbuild (dashboard), Playwright (tests), `node --test` (host C++ tests via g++).

## Global Constraints

- ESP32-S3, espressif32@6.1.0, Arduino framework, PlatformIO.
- Arduino-free modules host-tested by `bash test/host/run.sh` with g++ -std=c++17 -Wall -Wextra -Werror.
- NVS keys limited to 15 characters.
- Dashboard tests run via `npx playwright test` from `receiver/` against `test/binding-server.js`.
- `signal_store` stays a dumb store; sensor-specific logic lives in `device_hooks`.
- No comments in code unless earning their place (per AGENTS.md).
- Default TZ offset is -240 minutes (EDT).

## Spec refinement

The spec says the hook takes `JsonDocument&`. This plan uses a plain `Reading` struct instead, so `device_hooks` has no ArduinoJson dependency and host-tests with plain g++. `signal_store` fills the struct from its `JsonDocument`, calls the hook, and writes the result back. Same behavior, testable boundary.

---

## Task 1: device_hooks module — rain baseline logic (host-tested)

**Files:**
- Create: `receiver/device_hooks.h`
- Create: `receiver/device_hooks.cpp`
- Create: `receiver/test/host/device_hooks_test.cpp`
- Modify: `receiver/test/host/run.sh`

**Interfaces:**
- Consumes: nothing (Arduino-free, own TZ offset and time override)
- Produces:
  - `struct Reading { const char* model; bool has_rain_mm; float rain_mm; bool has_rain_in; float rain_in; bool set_rain_today_mm; float rain_today_mm; }`
  - `void setTzOffset(int16_t minutes)` — firmware calls this from tz_store; tests call it directly
  - `void setNow(time_t t)` — tests only; production uses `time(NULL)`
  - `void registerHook(const char* model, Hook h)`
  - `void dispatch(const char* key, Reading& r)`
  - `void begin()` — registers the rain hook for "Acurite-5n1"

- [ ] **Step 1: Write the host test**

`receiver/test/host/device_hooks_test.cpp`:

```cpp
#include <stdio.h>
#include <time.h>
#include <cmath>

#include "device_hooks.h"

static int failures = 0;

static void check(const char* what, bool ok) {
  printf("%-64s %s\n", what, ok ? "PASS" : "FAIL");
  if (!ok) failures++;
}

static float rainToday(const char* key, const char* model, float rain_mm, bool has_rain = true) {
  device_hooks::Reading r;
  r.model = model;
  r.has_rain_mm = has_rain;
  r.rain_mm = rain_mm;
  r.has_rain_in = false;
  r.rain_in = 0;
  r.set_rain_today_mm = false;
  r.rain_today_mm = 0;
  device_hooks::dispatch(key, r);
  return r.set_rain_today_mm ? r.rain_today_mm : -1.0f;
}

int main() {
  device_hooks::begin();

  // A model with no registered hook is untouched.
  {
    device_hooks::Reading r;
    r.model = "Acurite-Tower";
    r.has_rain_mm = true;
    r.rain_mm = 5.0f;
    r.has_rain_in = false;
    r.rain_in = 0;
    r.set_rain_today_mm = false;
    r.rain_today_mm = 0;
    device_hooks::dispatch("src/Acurite-Tower/1", r);
    check("an unregistered model is untouched", !r.set_rain_today_mm);
  }

  // No rain_mm and no rain_in: untouched.
  {
    device_hooks::Reading r;
    r.model = "Acurite-5n1";
    r.has_rain_mm = false;
    r.rain_mm = 0;
    r.has_rain_in = false;
    r.rain_in = 0;
    r.set_rain_today_mm = false;
    r.rain_today_mm = 0;
    device_hooks::dispatch("src/Acurite-5n1/1", r);
    check("a rain model with no rain field is untouched", !r.set_rain_today_mm);
  }

  // First reading: baseline set, delta is 0.
  device_hooks::setNow(1700000000);  // 2023-11-14 UTC
  device_hooks::setTzOffset(-240);   // EDT
  check("first reading sets rain_today to 0",
        fabs(rainToday("src/Acurite-5n1/1", "Acurite-5n1", 10.0f) - 0.0f) < 0.01f);

  // Subsequent reading same day: delta accumulates.
  check("second reading same day shows the delta",
        fabs(rainToday("src/Acurite-5n1/1", "Acurite-5n1", 12.5f) - 2.5f) < 0.01f);

  // Day change: baseline resets, delta is 0.
  // 1700000000 + 86400 = 1700086400 (next UTC day). With -240 offset, local
  // day changes when UTC crosses midnight minus 4h, i.e. at 1700000000 + ...
  // Actually localDay = (utc + offset*60) / 86400. At t=1700000000, offset=-240:
  //   localDay = (1700000000 - 14400) / 86400 = 1699985600 / 86400 = 19675
  // At t=1700086400 ( +86400 ):
  //   localDay = (1700086400 - 14400) / 86400 = 1700072000 / 86400 = 19676
  device_hooks::setNow(1700086400);
  check("day change resets baseline to 0 delta",
        fabs(rainToday("src/Acurite-5n1/1", "Acurite-5n1", 15.0f) - 0.0f) < 0.01f);

  // Station power-cycle (counter drops below baseline): baseline resets.
  device_hooks::setNow(1700086400 + 60);
  check("counter roll resets baseline to 0 delta",
        fabs(rainToday("src/Acurite-5n1/1", "Acurite-5n1", 3.0f) - 0.0f) < 0.01f);

  // rain_in converted to mm when rain_mm absent.
  device_hooks::setNow(1700000000);
  device_hooks::setTzOffset(0);
  float inResult = rainToday("src/Acurite-5n1/2", "Acurite-5n1", 0.0f, false);
  {
    device_hooks::Reading r;
    r.model = "Acurite-5n1";
    r.has_rain_mm = false;
    r.rain_mm = 0;
    r.has_rain_in = true;
    r.rain_in = 1.0f;  // 1 inch = 25.4 mm
    r.set_rain_today_mm = false;
    r.rain_today_mm = 0;
    device_hooks::dispatch("src/Acurite-5n1/2", r);
    check("first rain_in reading sets baseline (delta 0)",
          r.set_rain_today_mm && fabs(r.rain_today_mm - 0.0f) < 0.01f);
  }
  {
    device_hooks::Reading r;
    r.model = "Acurite-5n1";
    r.has_rain_mm = false;
    r.rain_mm = 0;
    r.has_rain_in = true;
    r.rain_in = 2.0f;  // 2 inches; delta = 1 inch = 25.4 mm
    r.set_rain_today_mm = false;
    r.rain_today_mm = 0;
    device_hooks::dispatch("src/Acurite-5n1/2", r);
    check("second rain_in reading shows 25.4 mm delta",
          r.set_rain_today_mm && fabs(r.rain_today_mm - 25.4f) < 0.1f);
  }

  // Clock unset (time < 1700000000): baseline tracks, no day reset.
  device_hooks::setNow(0);
  check("clock-unset first reading: delta 0",
        fabs(rainToday("src/Acurite-5n1/3", "Acurite-5n1", 100.0f) - 0.0f) < 0.01f);
  device_hooks::setNow(0);
  check("clock-unset second reading: delta accumulates",
        fabs(rainToday("src/Acurite-5n1/3", "Acurite-5n1", 105.0f) - 5.0f) < 0.01f);

  // TZ offset change moves the day boundary.
  device_hooks::setNow(1700000000);
  device_hooks::setTzOffset(-240);
  rainToday("src/Acurite-5n1/4", "Acurite-5n1", 10.0f);
  device_hooks::setTzOffset(0);
  // With offset 0, localDay = 1700000000/86400 = 19675 (same as -240 gave
  // 1699985600/86400 = 19675). So no day change here. Use a time where the
  // offset crosses a day boundary: t=1700060000 with offset 0 is day 19675,
  // with offset -240 is (1700060000-14400)/86400 = 1700045600/86400 = 19675
  // still. Let's pick t=1700070000: with 0 -> 19676, with -240 -> 19675.
  // Start fresh:
  device_hooks::setNow(1700060000);
  device_hooks::setTzOffset(-240);
  rainToday("src/Acurite-5n1/5", "Acurite-5n1", 10.0f);
  device_hooks::setNow(1700060000 + 60);
  device_hooks::setTzOffset(0);  // now day 19676 with offset 0
  check("TZ offset change can cross a day boundary",
        fabs(rainToday("src/Acurite-5n1/5", "Acurite-5n1", 11.0f) - 0.0f) < 0.01f);

  printf("%d failures\n", failures);
  return failures ? 1 : 0;
}
```

- [ ] **Step 2: Write `device_hooks.h`**

`receiver/device_hooks.h`:

```cpp
#pragma once

#include <stdint.h>
#include <time.h>

namespace device_hooks {

struct Reading {
  const char* model;
  bool   has_rain_mm;
  float  rain_mm;
  bool   has_rain_in;
  float  rain_in;
  bool   set_rain_today_mm;
  float  rain_today_mm;
};

typedef void (*Hook)(const char* key, Reading& r);

void registerHook(const char* model, Hook h);
void dispatch(const char* key, Reading& r);
void begin();

void setTzOffset(int16_t minutes);
void setNow(time_t t);

}  // namespace device_hooks
```

- [ ] **Step 3: Write `device_hooks.cpp`**

`receiver/device_hooks.cpp`:

```cpp
#include "device_hooks.h"

#include <string.h>
#include <stdlib.h>

namespace device_hooks {

#define RAIN_HOOK_SLOTS 8
#define RAIN_KEY_MAX    96
#define MAX_HOOKS       8

struct RainBaseline {
  char    key[RAIN_KEY_MAX];
  float   baseline;
  int32_t day;
  bool    used;
};

struct HookEntry {
  char  model[32];
  Hook  fn;
  bool  used;
};

static RainBaseline _rain[RAIN_HOOK_SLOTS];
static HookEntry    _hooks[MAX_HOOKS];
static int16_t      _tzOffset = -240;
static time_t       _nowOverride = 0;

static time_t now() {
  return _nowOverride > 0 ? _nowOverride : time(NULL);
}

static int32_t localDay() {
  time_t t = now();
  if (t < 1700000000) return 0;
  return (int32_t)((t + (time_t)_tzOffset * 60) / 86400);
}

void setTzOffset(int16_t minutes) { _tzOffset = minutes; }
void setNow(time_t t) { _nowOverride = t; }

void registerHook(const char* model, Hook h) {
  for (int i = 0; i < MAX_HOOKS; i++) {
    if (!_hooks[i].used) {
      strncpy(_hooks[i].model, model, sizeof(_hooks[i].model) - 1);
      _hooks[i].model[sizeof(_hooks[i].model) - 1] = '\0';
      _hooks[i].fn = h;
      _hooks[i].used = true;
      return;
    }
  }
}

static Hook findHook(const char* model) {
  if (model == NULL) return NULL;
  for (int i = 0; i < MAX_HOOKS; i++) {
    if (_hooks[i].used && strcmp(_hooks[i].model, model) == 0) {
      return _hooks[i].fn;
    }
  }
  return NULL;
}

static int findRain(const char* key) {
  for (int i = 0; i < RAIN_HOOK_SLOTS; i++) {
    if (_rain[i].used && strcmp(_rain[i].key, key) == 0) return i;
  }
  return -1;
}

static int claimRain() {
  for (int i = 0; i < RAIN_HOOK_SLOTS; i++) {
    if (!_rain[i].used) return i;
  }
  int oldest = 0;
  for (int i = 1; i < RAIN_HOOK_SLOTS; i++) {
    if (_rain[i].day < _rain[oldest].day) oldest = i;
  }
  _rain[oldest].used = false;
  return oldest;
}

static void rainHook(const char* key, Reading& r) {
  float mm;
  if (r.has_rain_mm) {
    mm = r.rain_mm;
  } else if (r.has_rain_in) {
    mm = r.rain_in * 25.4f;
  } else {
    return;
  }

  int32_t day = localDay();
  int idx = findRain(key);

  if (idx < 0) {
    idx = claimRain();
    strncpy(_rain[idx].key, key, RAIN_KEY_MAX - 1);
    _rain[idx].key[RAIN_KEY_MAX - 1] = '\0';
    _rain[idx].baseline = mm;
    _rain[idx].day = day;
    _rain[idx].used = true;
    r.set_rain_today_mm = true;
    r.rain_today_mm = 0.0f;
    return;
  }

  if (day != _rain[idx].day || mm < _rain[idx].baseline) {
    _rain[idx].baseline = mm;
    _rain[idx].day = day;
    r.set_rain_today_mm = true;
    r.rain_today_mm = 0.0f;
    return;
  }

  r.set_rain_today_mm = true;
  float delta = mm - _rain[idx].baseline;
  r.rain_today_mm = (float)(int)(delta * 10 + (delta >= 0 ? 0.5f : -0.5f)) / 10.0f;
}

void dispatch(const char* key, Reading& r) {
  Hook h = findHook(r.model);
  if (h != NULL) h(key, r);
}

void begin() {
  memset(_rain, 0, sizeof(_rain));
  memset(_hooks, 0, sizeof(_hooks));
  registerHook("Acurite-5n1", rainHook);
}

}  // namespace device_hooks
```

- [ ] **Step 4: Update `test/host/run.sh`**

Add the device_hooks compilation after the radio_health test. The full file becomes:

```sh
#!/bin/sh
# topic.cpp, radio_health.cpp and device_hooks.cpp are the firmware modules
# with no Arduino dependency, so their rules are checked here rather than by
# compilation alone.
set -e
root=$(cd "$(dirname "$0")/../.." && pwd)
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
g++ -std=c++17 -Wall -Wextra -Werror -I"$root" \
    -o "$out/topic_test" "$root/topic.cpp" "$root/test/host/topic_test.cpp"
"$out/topic_test"
g++ -std=c++17 -Wall -Wextra -Werror -I"$root" \
    -o "$out/radio_health_test" "$root/radio_health.cpp" "$root/test/host/radio_health_test.cpp"
"$out/radio_health_test"
g++ -std=c++17 -Wall -Wextra -Werror -I"$root" \
    -o "$out/device_hooks_test" "$root/device_hooks.cpp" "$root/test/host/device_hooks_test.cpp"
"$out/device_hooks_test"
```

- [ ] **Step 5: Run the host test to verify it passes**

Run: `bash receiver/test/host/run.sh`
Expected: PASS on all checks, `0 failures`.

- [ ] **Step 6: Commit**

```bash
git add receiver/device_hooks.h receiver/device_hooks.cpp receiver/test/host/device_hooks_test.cpp receiver/test/host/run.sh
git commit -m "feat(receiver): device_hooks module with daily rain baseline logic"
```

---

## Task 2: signal_store record hook

**Files:**
- Modify: `receiver/signal_store.h`
- Modify: `receiver/signal_store.cpp`
- Modify: `receiver/WebReceiver.ino` (only the selfTest call site, to keep the build working)

**Interfaces:**
- Consumes: `device_hooks::Reading`, `device_hooks::dispatch` (from Task 1)
- Produces:
  - `typedef void (*RecordHook)(const char* key, device_hooks::Reading& r)`
  - `void setRecordHook(RecordHook hook)`
  - `record()` calls the hook (if set) after stamping time/rssi/count, before the size check

- [ ] **Step 1: Add the hook to `signal_store.h`**

Add after the `#include "Arduino.h"` line at the top:

```cpp
#include "device_hooks.h"
```

Add inside `namespace signal_store {`, before `bool record(...)`:

```cpp
typedef void (*RecordHook)(const char* key, device_hooks::Reading& r);
void setRecordHook(RecordHook hook);
```

- [ ] **Step 2: Add the hook storage and call to `signal_store.cpp`**

Add after `static DeviceSub _subs[SIGNAL_SUB_TABLE];` (line 17):

```cpp
static RecordHook _hook = nullptr;
```

Add after `void setSource(...)` / `const char* source()` pair, before `sanitizeSegment`:

```cpp
void setRecordHook(RecordHook hook) { _hook = hook; }
```

In `record()`, after `doc["rssi"] = rssi;` and `doc["count"] = count;` (line 185), and before the size check (line 189), add:

```cpp
  if (_hook != nullptr) {
    const char* model = doc["model"];
    device_hooks::Reading r;
    r.model = model ? model : "";
    r.has_rain_mm = doc["rain_mm"].is<float>();
    r.rain_mm = r.has_rain_mm ? doc["rain_mm"].as<float>() : 0.0f;
    r.has_rain_in = doc["rain_in"].is<float>();
    r.rain_in = r.has_rain_in ? doc["rain_in"].as<float>() : 0.0f;
    r.set_rain_today_mm = false;
    r.rain_today_mm = 0.0f;
    _hook(key, r);
    if (r.set_rain_today_mm) {
      doc["rain_today_mm"] = r.rain_today_mm;
    }
  }
```

- [ ] **Step 3: Verify the firmware compiles**

Run: `cd receiver && pio run -e esp32s3-generic`
Expected: SUCCESS. The build will compile because `device_hooks.cpp` has no Arduino dependency and is in the source directory (src_filter includes `+<*>`).

- [ ] **Step 4: Commit**

```bash
git add receiver/signal_store.h receiver/signal_store.cpp
git commit -m "feat(receiver): optional record hook in signal_store for payload augmentation"
```

---

## Task 3: tz_store module — NVS persistence of GMT offset

**Files:**
- Create: `receiver/tz_store.h`
- Create: `receiver/tz_store.cpp`

**Interfaces:**
- Consumes: `device_hooks::setTzOffset` (from Task 1)
- Produces:
  - `bool tz_store::begin()` — loads offset from NVS, defaults to -240, calls `device_hooks::setTzOffset`
  - `int16_t tz_store::offsetMinutes()`
  - `void tz_store::set(int16_t minutes)` — persists to NVS, calls `device_hooks::setTzOffset`

- [ ] **Step 1: Write `tz_store.h`**

`receiver/tz_store.h`:

```cpp
#pragma once

#include <Arduino.h>
#include <stdint.h>

namespace tz_store {
bool     begin();
int16_t  offsetMinutes();
void     set(int16_t minutes);
}  // namespace tz_store
```

- [ ] **Step 2: Write `tz_store.cpp`**

`receiver/tz_store.cpp`:

```cpp
#include "tz_store.h"

#include <Preferences.h>

#include "device_hooks.h"

namespace tz_store {

static Preferences _prefs;
static bool        _open = false;
static int16_t     _offset = -240;

static const char* kOffset = "offset";

bool begin() {
  _open = _prefs.begin("tz", false);
  _offset = _open ? (int16_t)_prefs.getShort(kOffset, -240) : -240;
  device_hooks::setTzOffset(_offset);
  return _open;
}

int16_t offsetMinutes() { return _offset; }

void set(int16_t minutes) {
  _offset = minutes;
  device_hooks::setTzOffset(minutes);
  if (_open) {
    _prefs.putShort(kOffset, minutes);
  }
}

}  // namespace tz_store
```

- [ ] **Step 3: Verify the firmware compiles**

Run: `cd receiver && pio run -e esp32s3-generic`
Expected: SUCCESS.

- [ ] **Step 4: Commit**

```bash
git add receiver/tz_store.h receiver/tz_store.cpp
git commit -m "feat(receiver): tz_store persists GMT offset in NVS"
```

---

## Task 4: web_ui POST /$tz handling

**Files:**
- Modify: `receiver/web_ui.cpp`
- Modify: `receiver/web_ui.h`

**Interfaces:**
- Consumes: `tz_store::set` (from Task 3)
- Produces: HTTP `POST /<source>/$tz` accepts a JSON number body, calls `tz_store::set`, returns 204.

- [ ] **Step 1: Add the `/$tz` handler in `web_ui.cpp`**

Add `#include "tz_store.h"` at the top with the other includes.

Add a new handler function before `handleTopic()`:

```cpp
static void handleTzPost(const char* path) {
  const char* src = signal_store::source();
  size_t      srcLen = strlen(src);
  bool        ownSource = strncmp(path, src, srcLen) == 0 && path[srcLen] == '/';
  if (!ownSource) {
    sendStatus(405, "not allowed");
    return;
  }
  String body = _server.arg("plain");
  JsonDocument doc;
  if (deserializeJson(doc, body) != DeserializationError::Ok || !doc.is<long>()) {
    sendStatus(400, "body must be a JSON number");
    return;
  }
  tz_store::set((int16_t)doc.as<long>());
  sendCors();
  _server.sendHeader("Cache-Control", "no-store");
  _server.send(204, "text/plain", "");
}
```

In `handleTopic()`, after the `handleAliasPost(path)` call in the POST branch (line 359), add:

```cpp
  if (topic::isTz(path)) {
    handleTzPost(path);
    return;
  }
```

- [ ] **Step 2: Add `isTz` to `topic.h` and `topic.cpp`**

In `receiver/topic.h`, after `bool isAlias(const char* t);`:

```cpp
bool isTz(const char* t);
```

In `receiver/topic.cpp`, after `bool isAlias(const char* t) { ... }`:

```cpp
bool isTz(const char* t) {
  if (t == NULL) return false;
  const char* last = strrchr(t, '/');
  return strcmp(last != NULL ? last + 1 : t, "$tz") == 0;
}
```

- [ ] **Step 3: Add a host test for `isTz`**

In `receiver/test/host/topic_test.cpp`, add before the final `return`:

```cpp
check("isTz identifies a $tz topic", topic::isTz("src/Receiver/0/$tz"));
check("isTz rejects a non-$tz topic", !topic::isTz("src/Acurite-5n1/396"));
check("isTz rejects NULL", !topic::isTz(NULL));
```

If the test file uses a different check macro/pattern, follow the existing one.

- [ ] **Step 4: Run the host tests**

Run: `bash receiver/test/host/run.sh`
Expected: PASS on all checks including the new `isTz` checks.

- [ ] **Step 5: Verify the firmware compiles**

Run: `cd receiver && pio run -e esp32s3-generic`
Expected: SUCCESS.

- [ ] **Step 6: Commit**

```bash
git add receiver/web_ui.cpp receiver/web_ui.h receiver/topic.h receiver/topic.cpp receiver/test/host/topic_test.cpp
git commit -m "feat(receiver): POST /\$tz endpoint for GMT offset"
```

---

## Task 5: Wire everything in WebReceiver.ino

**Files:**
- Modify: `receiver/WebReceiver.ino`

- [ ] **Step 1: Add includes and setup calls**

Add after `#include "signal_store.h"` (line 20):

```cpp
#include "device_hooks.h"
#include "tz_store.h"
```

In `setup()`, after `signal_store::setSource(mdnsHostname());` (line 454), add:

```cpp
  tz_store::begin();
  device_hooks::begin();
  signal_store::setRecordHook(device_hooks::dispatch);
```

- [ ] **Step 2: Flash and verify via serial monitor**

Run: `cd receiver && pio run -e esp32s3-generic -t upload`
Then capture boot log:
```sh
python3 receiver/monitor.py -d 12 -q
```
Expected: boot completes with `****** setup complete ******` and no crash. The `device_hooks` module runs silently (no boot log unless a rain message arrives).

- [ ] **Step 3: Commit**

```bash
git add receiver/WebReceiver.ino
git commit -m "feat(receiver): wire device_hooks and tz_store into setup"
```

---

## Task 6: binding-server.js — rain model and /$tz handling

**Files:**
- Modify: `receiver/test/binding-server.js`

**Interfaces:**
- Consumes: nothing new
- Produces: the JS model now stamps `rain_today_mm` for registered rain models and accepts `POST /$tz`.

- [ ] **Step 1: Add the rain model to `binding-server.js`**

Add after the `let globalSeq = 0;` line (line 39):

```javascript
  let tzOffset = -240;
  const rainBaselines = new Map();  // topic -> { baseline, day }
  const rainModels = new Set(["Acurite-5n1"]);

  function localDay() {
    const t = Date.now() / 1000;
    if (t < 1700000000) return 0;
    return Math.floor((t + tzOffset * 60) / 86400);
  }

  function applyRainHook(topic, payload) {
    if (!rainModels.has(payload.model)) return;
    let mm = null;
    if (typeof payload.rain_mm === "number") mm = payload.rain_mm;
    else if (typeof payload.rain_in === "number") mm = payload.rain_in * 25.4;
    if (mm === null) return;

    const day = localDay();
    let entry = rainBaselines.get(topic);
    if (!entry || entry.day !== day || mm < entry.baseline) {
      entry = { baseline: mm, day };
      rainBaselines.set(topic, entry);
    }
    payload.rain_today_mm = Math.round((mm - entry.baseline) * 10) / 10;
  }
```

In the `put()` function, after `if (stamped.model === "Receiver") stamped.build = ...;` (line 73) and before `publish(topic, ...)`, add:

```javascript
    applyRainHook(topic, stamped);
```

- [ ] **Step 2: Add `POST /$tz` handling**

In the POST branch of the HTTP handler (after the alias check, around line 142), add before the alias-specific `if (!isAlias ...)`:

```javascript
      const isTz = topic.endsWith("/$tz");
      if (isTz) {
        if (!topic.startsWith(source + "/")) {
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

Add a `tzOffset` getter to the returned server object (after `setBuild(id) { ... }`):

```javascript
        tzOffset() { return tzOffset; },
```

- [ ] **Step 3: Run existing binding tests to verify nothing broke**

Run: `cd receiver && npx playwright test test/binding.spec.js`
Expected: all existing tests PASS.

- [ ] **Step 4: Commit**

```bash
git add receiver/test/binding-server.js
git commit -m "test(receiver): model rain_today_mm and POST /\$tz in binding-server"
```

---

## Task 7: binding.spec.js — rain_today_mm and POST /$tz tests

**Files:**
- Modify: `receiver/test/binding.spec.js`

- [ ] **Step 1: Add tests for rain_today_mm and /$tz**

Add at the end of `receiver/test/binding.spec.js`:

```javascript
test("an Acurite-5n1 rain payload gets rain_today_mm stamped", async () => {
  server = await startServer({ devices: [ACURITE_RAIN] });
  const body = JSON.parse((await server.get(topicOf(ACURITE_RAIN))).body);
  expect(typeof body.rain_today_mm).toBe("number");
  expect(body.rain_today_mm).toBe(0);
});

test("a second rain payload shows the accumulated delta", async () => {
  server = await startServer({ devices: [ACURITE_RAIN] });
  server.emit({ ...ACURITE_RAIN, rain_mm: 2.3 });
  const body = JSON.parse((await server.get(topicOf(ACURITE_RAIN))).body);
  expect(body.rain_today_mm).toBeCloseTo(1.8, 1);
});

test("a non-rain model is not augmented", async () => {
  server = await startServer({ devices: [ACURITE_WIND] });
  const body = JSON.parse((await server.get(topicOf(ACURITE_WIND))).body);
  expect(body.rain_today_mm).toBeUndefined();
});

test("POST /\$tz sets the offset", async () => {
  server = await startServer({ devices: [] });
  const r = await server.post(SOURCE + "/Receiver/0/$tz", JSON.stringify(-300));
  expect(r.status).toBe(204);
  expect(server.tzOffset()).toBe(-300);
});

test("POST /\$tz with a non-number body is 400", async () => {
  server = await startServer({ devices: [] });
  const r = await server.post(SOURCE + "/Receiver/0/$tz", JSON.stringify("not a number"));
  expect(r.status).toBe(400);
});

test("POST /\$tz to another source is 405", async () => {
  server = await startServer({ devices: [] });
  const r = await server.post("other/Receiver/0/$tz", JSON.stringify(-300));
  expect(r.status).toBe(405);
});
```

- [ ] **Step 2: Run the tests**

Run: `cd receiver && npx playwright test test/binding.spec.js`
Expected: all tests PASS, including the 6 new ones.

- [ ] **Step 3: Commit**

```bash
git add receiver/test/binding.spec.js
git commit -m "test(receiver): cover rain_today_mm stamping and POST /\$tz"
```

---

## Task 8: Dashboard — POST offset on location set

**Files:**
- Modify: `dashboard/src/settings.js`

**Interfaces:**
- Consumes: `offsetMinutes` from `feeds/zone.js`, `activeZone` (already in settings.js)
- Produces: `setLocation` now POSTs the GMT offset to `${location.origin}/$tz` when the location is valid.

- [ ] **Step 1: Add the offset push to `setLocation` in `settings.js`**

Add at the top of `dashboard/src/settings.js`:

```javascript
import { offsetMinutes } from './feeds/zone.js'
```

Replace the existing `setLocation` function (lines 106-111) with:

```javascript
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

- [ ] **Step 2: Verify the dashboard builds**

Run: `cd dashboard && node build.js`
Expected: `dist/index.html` written, no errors.

- [ ] **Step 3: Run existing dashboard tests to verify nothing broke**

Run: `cd dashboard && npx playwright test`
Expected: all existing tests PASS.

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/settings.js
git commit -m "feat(dashboard): POST GMT offset to receiver on location set"
```

---

## Task 9: Dashboard test — offset push on location set

**Files:**
- Create: `dashboard/test/rain-today.spec.js` (or add to `feeds.spec.js`)

- [ ] **Step 1: Write the test**

Create `dashboard/test/rain-today.spec.js`. The dashboard's `fixtures.js` has `ACURITE` (Acurite-5n1, no rain_mm); build a rain payload inline by spreading it.

```javascript
import { test, expect } from "@playwright/test";
import { startServer } from "./harness.js";
import { ACURITE } from "./fixtures.js";

const RAIN = { ...ACURITE, message_type: 1, rain_mm: 0.5 };

let server;

test.afterEach(async () => { if (server) await server.close(); server = null; });

test("setting a location POSTs the GMT offset to /\$tz", async ({ page }) => {
  server = await startServer({ devices: [RAIN] });
  await page.goto(server.url);
  await expect(page.locator("#status")).toHaveText(/^live/);

  await page.evaluate(() => {
    setLocation({ lat: 40.015, lon: -105.2705, zone: "America/Denver" });
  });

  // The binding-server's tzOffset should now reflect America/Denver's offset.
  // Denver is -6:00 (MDT) or -7:00 (MST); accept either since DST depends on date.
  const offset = server.tzOffset();
  expect([-360, -420]).toContain(offset);
});

test("clearing a location does not POST", async ({ page }) => {
  server = await startServer({ devices: [RAIN] });
  await page.goto(server.url);
  await expect(page.locator("#status")).toHaveText(/^live/);

  // Set first so we have a baseline.
  await page.evaluate(() => {
    setLocation({ lat: 40.015, lon: -105.2705, zone: "America/Denver" });
  });
  const offsetBefore = server.tzOffset();

  await page.evaluate(() => {
    clearLocation();
  });
  // Offset unchanged after clear.
  expect(server.tzOffset()).toBe(offsetBefore);
});
```

`harness.js`'s `startServer` returns the binding-server object directly, so `server.tzOffset()` passes through once Task 6 adds the getter.

- [ ] **Step 2: Run the test**

Run: `cd dashboard && npx playwright test test/rain-today.spec.js`
Expected: both tests PASS.

- [ ] **Step 3: Commit**

```bash
git add dashboard/test/rain-today.spec.js
git commit -m "test(dashboard): verify offset POST on location set"
```

---

## Task 10: Documentation

**Files:**
- Modify: `receiver/docs/architecture.md`
- Modify: `receiver/docs/user-manual.md`
- Modify: `dashboard/docs/user-manual.md`

- [ ] **Step 1: Update `receiver/docs/architecture.md`**

In the module boundaries section, add entries for `device_hooks` and `tz_store` after the `health_store` entry:

```markdown
**`device_hooks.h` / `device_hooks.cpp`** — an Arduino-free decision module,
host-tested by `test/host/run.sh` like `topic` and `radio_health`. It holds a
registry mapping rtl_433 model names to hook functions, and a rain baseline
table that tracks the cumulative `rain_mm` per device, resetting at local
midnight. `signal_store::record()` fills a `Reading` struct from the parsed
payload and calls `device_hooks::dispatch`, which looks up the model's hook
and calls it. The rain hook writes `rain_today_mm` (the delta from the
baseline) back into the struct, and `record()` stamps it into the JSON before
storing. The baseline is RAM-only; a receiver reboot loses it and today's
rain restarts from 0.

**`tz_store.h` / `tz_store.cpp`** — persists the GMT offset (signed minutes)
to `Preferences` namespace `"tz"`. Defaults to -240 (EDT) at first boot. The
dashboard POSTs the offset to `/$tz` when the location is set; `tz_store::set`
persists it and pushes it into `device_hooks` so the rain hook's midnight
boundary follows the user's timezone.
```

In the data-flow section, add a note after the existing `record()` description:

```markdown
Before the size check, `record()` calls the registered record hook (if any).
`device_hooks::dispatch` reads the model from the payload, calls the matching
hook, and the rain hook computes `rain_today_mm` from the cumulative `rain_mm`
and a per-device baseline reset at local midnight. The hook writes back into
the `JsonDocument` before it is serialized into the sub.
```

- [ ] **Step 2: Update `receiver/docs/user-manual.md`**

Add `POST /$tz` to the HTTP surface table:

```markdown
| `POST /<source>/$tz` | store the GMT offset (JSON number, signed minutes); `204`; `405` unless under this receiver's source |
```

Add a note about `rain_today_mm`:

```markdown
A weather station reporting `rain_mm` (cumulative bucket tips since power-up)
also carries `rain_today_mm`, the rainfall since the start of the current local
day. The receiver derives this from a per-device baseline reset at local
midnight. The baseline is RAM-only, so a receiver reboot restarts today's
count from 0.
```

- [ ] **Step 3: Update `dashboard/docs/user-manual.md`**

Add a note in the rain section (or near the weather station description):

```markdown
Setting the weather location pushes the local GMT offset to the receiver so
its daily rain counter resets at your midnight, not UTC midnight. The offset
is sent only when the location changes; a DST transition leaves the reset
boundary off by an hour until the location is set again.
```

- [ ] **Step 4: Commit**

```bash
git add receiver/docs/architecture.md receiver/docs/user-manual.md dashboard/docs/user-manual.md
git commit -m "docs: daily rainfall tracking and POST /\$tz"
```

---

## Final verification

- [ ] **Run host tests**: `bash receiver/test/host/run.sh` — all PASS
- [ ] **Run binding tests**: `cd receiver && npx playwright test` — all PASS
- [ ] **Run dashboard tests**: `cd dashboard && npx playwright test` — all PASS
- [ ] **Build firmware**: `cd receiver && pio run -e esp32s3-generic` — SUCCESS
- [ ] **Flash and boot**: `cd receiver && pio run -t upload && python3 monitor.py -d 12 -q` — setup complete, no crash
