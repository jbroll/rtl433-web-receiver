# The HTTP binding in the receiver — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the receiver's `/api/state`, `/api/status`, and `signal`-named SSE
with the source-only subset of the HTTP binding in
`~/src/mqtt-http-bridge/docs/binding.md`, so device keys become stable topics and
aliases live on the device.

**Architecture:** Two new firmware modules (`topic`, `alias_store`) sit under a
rewritten `web_ui` that dispatches every request from `onNotFound`, because topics
are arbitrary paths. `signal_store` keys its slots as `<source>/<model>/<id>` and
stamps `time`, `rssi`, and `count` into the payload it stores, which makes the
stored message self-describing and lets the page age it against its own clock.
`/events` gains MQTT-style filters and a retained replay drained a few frames per
`web_ui::loop()`. The page stops fetching a snapshot and builds its whole table
from the stream.

**Tech Stack:** C++ (Arduino/ESP32, PlatformIO `espressif32@6.1.0`), ArduinoJson 7,
ESP32 `WebServer`, `Preferences` (NVS), a PROGMEM HTML page, Playwright + Node for
the page tests, and `g++` for a host test of the topic module.

## Global Constraints

- Source spec: `docs/superpowers/specs/2026-08-14-receiver-binding-design.md`.
  Binding spec: `~/src/mqtt-http-bridge/docs/binding.md`. The binding spec is
  linked, never copied into this repo.
- Static allocation only on the decode path, except the `JsonDocument` already
  there. No new heap use in `signal_store`, `topic`, or `alias_store`.
- Buffer sizes, exact values: `SIGNAL_KEY_MAX` 96, `SIGNAL_PAYLOAD_MAX` 600,
  `SIGNAL_MODEL_MAX` 64, `SIGNAL_DEVICE_SLOTS` 24 (unchanged), `ALIAS_SLOTS` 32,
  `ALIAS_TOPIC_MAX` 96, `ALIAS_NAME_MAX` 32, `ALIAS_BLOB_MAX` 2048, four SSE
  clients (unchanged), four filters per connection, 64 bytes per filter.
- NVS: namespace `alias`, key `map`, one JSON object of topic to name.
- Statuses: `204` on a stored alias, `400` on a malformed topic or filter or a body
  that is not a JSON string, `404` on a topic with no message, `405` on a `POST`
  that is not to an `$alias` topic under this source, `503` when the alias table or
  blob is full.
- SSE frames carry no event name. Frame data is
  `{"topic":"<topic>","payload":<json>}` with a device payload embedded as the
  object it is and an alias payload as a JSON string.
- **Deviation from the spec, deliberate:** because the payload is now embedded in
  the frame as JSON rather than carried as an escaped string, a truncated payload
  would produce an unparseable frame. `record()` therefore drops a message whose
  stamped serialisation exceeds `SIGNAL_PAYLOAD_MAX` instead of truncating it. The
  library's own message buffer is 512 bytes and the three stamped fields cost about
  56, so a real decode still fits.
- Comments: default to none, say why and never what, one or two lines. Test names
  state the behaviour and need no preamble.
- Docs change in the same commit as the code they describe.
- Never open a pull request. Work stays on the `receiver-binding` branch.

**Verification commands used throughout:**

- Firmware build: `cd /home/john/src/rtl433-web-receiver && pio run -e esp32s3-generic`
- Host topic test: `cd /home/john/src/rtl433-web-receiver && bash test/host/run.sh`
- Page tests: `cd /home/john/src/rtl433-web-receiver && npx playwright test`

---

### Task 1: The topic module and its host test

**Files:**
- Create: `topic.h`
- Create: `topic.cpp`
- Create: `test/host/topic_test.cpp`
- Create: `test/host/run.sh`

**Model:** `sonnet` — new module written from prose plus a host build script.

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `bool topic::validTopic(const char* topic)`
  - `bool topic::validFilter(const char* filter)`
  - `bool topic::matchFilter(const char* filter, const char* topic)`
  - `bool topic::isAlias(const char* topic)`

  `topic.h` deliberately includes no Arduino header, so the module compiles on the
  host as well as on the device.

- [ ] **Step 1: Write the failing test**

Create `test/host/topic_test.cpp`:

```cpp
#include <stdio.h>

#include "topic.h"

static int failures = 0;

static void check(const char* what, bool ok) {
  printf("%-64s %s\n", what, ok ? "PASS" : "FAIL");
  if (!ok) failures++;
}

int main() {
  check("a three segment topic is valid", topic::validTopic("rtl433-a1b2c3/Acurite-5n1/1234"));
  check("an empty topic is invalid", !topic::validTopic(""));
  check("a topic holding + is invalid", !topic::validTopic("a/+/c"));
  check("a topic holding # is invalid", !topic::validTopic("a/#"));
  check("a topic holding a space is invalid", !topic::validTopic("a/b c/d"));
  check("a topic with an empty segment is invalid", !topic::validTopic("a//c"));
  check("a topic with a trailing slash is invalid", !topic::validTopic("a/b/"));
  check("a one segment topic is valid", topic::validTopic("rtl433-a1b2c3"));

  check("# alone is a valid filter", topic::validFilter("#"));
  check("+ in the middle is a valid filter", topic::validFilter("a/+/c"));
  check("# as the last segment is a valid filter", topic::validFilter("a/b/#"));
  check("# before the last segment is invalid", !topic::validFilter("a/#/c"));
  check("# inside a segment is invalid", !topic::validFilter("a/b#/c"));
  check("+ inside a segment is invalid", !topic::validFilter("a/b+/c"));
  check("an empty filter is invalid", !topic::validFilter(""));
  check("a filter holding a space is invalid", !topic::validFilter("a/b c"));

  check("# matches everything", topic::matchFilter("#", "a/b/c"));
  check("# matches the remainder", topic::matchFilter("a/#", "a/b/c"));
  check("# matches its own prefix", topic::matchFilter("a/#", "a"));
  check("# does not match another prefix", !topic::matchFilter("a/#", "b/c"));
  check("+ matches exactly one segment", topic::matchFilter("a/+/c", "a/b/c"));
  check("+ does not span a separator", !topic::matchFilter("a/+/c", "a/b/x/c"));
  check("+ does not match a missing segment", !topic::matchFilter("a/+/c", "a/c"));
  check("an exact filter matches its topic", topic::matchFilter("a/b/c", "a/b/c"));
  check("a longer topic does not match an exact filter", !topic::matchFilter("a/b", "a/b/c"));
  check("a shorter topic does not match an exact filter", !topic::matchFilter("a/b/c", "a/b"));
  check("+ matches a whole one segment topic", topic::matchFilter("+", "a"));

  check("a $alias topic is an alias", topic::isAlias("rtl433-a1b2c3/Acurite-5n1/1234/$alias"));
  check("a source level $alias is an alias", topic::isAlias("rtl433-a1b2c3/$alias"));
  check("a device topic is not an alias", !topic::isAlias("rtl433-a1b2c3/Acurite-5n1/1234"));
  check("$alias not in the last segment is not an alias", !topic::isAlias("a/$alias/b"));

  printf("%s\n", failures == 0 ? "topic: PASS" : "topic: FAIL");
  return failures == 0 ? 0 : 1;
}
```

Create `test/host/run.sh`:

```sh
#!/bin/sh
# topic.cpp is the one firmware module with no Arduino dependency, so its rules
# are checked here rather than by compilation alone.
set -e
root=$(cd "$(dirname "$0")/../.." && pwd)
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
g++ -std=c++17 -Wall -Wextra -Werror -I"$root" \
    -o "$out/topic_test" "$root/topic.cpp" "$root/test/host/topic_test.cpp"
"$out/topic_test"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bash test/host/run.sh`
Expected: FAIL, `fatal error: topic.h: No such file or directory`

- [ ] **Step 3: Write the header**

Create `topic.h`:

```cpp
#pragma once

// No Arduino header: this module is also compiled on the host by
// test/host/run.sh, and its rules mirror mqtt-http-bridge/src/topic.js.
namespace topic {
bool validTopic(const char* topic);
bool validFilter(const char* filter);
bool matchFilter(const char* filter, const char* topic);
bool isAlias(const char* topic);
} // namespace topic
```

- [ ] **Step 4: Write the implementation**

Create `topic.cpp`:

```cpp
#include "topic.h"

#include <string.h>

namespace topic {

static bool segmentHas(const char* seg, size_t len, char c) {
  return memchr(seg, c, len) != NULL;
}

bool validTopic(const char* t) {
  if (t == NULL || *t == '\0') {
    return false;
  }
  const char* seg = t;
  for (const char* p = t;; p++) {
    if (*p == '+' || *p == '#' || *p == ' ') {
      return false;
    }
    if (*p == '/' || *p == '\0') {
      if (p == seg) {
        return false;
      }
      seg = p + 1;
    }
    if (*p == '\0') {
      return true;
    }
  }
}

bool validFilter(const char* f) {
  if (f == NULL || *f == '\0') {
    return false;
  }
  const char* seg = f;
  for (const char* p = f;; p++) {
    if (*p == ' ') {
      return false;
    }
    if (*p == '/' || *p == '\0') {
      size_t len = (size_t)(p - seg);
      if (len == 0) {
        return false;
      }
      bool last = (*p == '\0');
      if (segmentHas(seg, len, '#') && !(len == 1 && seg[0] == '#' && last)) {
        return false;
      }
      if (segmentHas(seg, len, '+') && !(len == 1 && seg[0] == '+')) {
        return false;
      }
      seg = p + 1;
    }
    if (*p == '\0') {
      return true;
    }
  }
}

bool matchFilter(const char* filter, const char* t) {
  const char* f = filter;
  const char* p = t;
  for (;;) {
    if (f[0] == '#' && f[1] == '\0') {
      return true;
    }
    if (*f == '\0' || *p == '\0') {
      return *f == '\0' && *p == '\0';
    }
    const char* fend = strchr(f, '/');
    const char* pend = strchr(p, '/');
    if (fend == NULL) {
      fend = f + strlen(f);
    }
    if (pend == NULL) {
      pend = p + strlen(p);
    }
    size_t fl = (size_t)(fend - f), pl = (size_t)(pend - p);
    if (!(fl == 1 && f[0] == '+')) {
      if (fl != pl || strncmp(f, p, fl) != 0) {
        return false;
      }
    }
    f = (*fend == '\0') ? fend : fend + 1;
    p = (*pend == '\0') ? pend : pend + 1;
  }
}

bool isAlias(const char* t) {
  if (t == NULL) {
    return false;
  }
  const char* last = strrchr(t, '/');
  return strcmp(last != NULL ? last + 1 : t, "$alias") == 0;
}

} // namespace topic
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bash test/host/run.sh`
Expected: every line PASS, final line `topic: PASS`, exit status 0

- [ ] **Step 6: Verify the firmware still builds**

Run: `pio run -e esp32s3-generic`
Expected: `[SUCCESS]`

- [ ] **Step 7: Commit**

```bash
git add topic.h topic.cpp test/host/topic_test.cpp test/host/run.sh
git commit -m "Add topic and filter handling for the binding"
```

---

### Task 2: The alias store

**Files:**
- Create: `alias_store.h`
- Create: `alias_store.cpp`
- Modify: `WebReceiver.ino` — call `alias_store::begin()` in `setup()` and
  `alias_store::selfTest()` beside the existing `signal_store::selfTest()`

**Model:** `sonnet` — new module with NVS persistence and a self-test.

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `bool alias_store::begin()`
  - `const char* alias_store::get(const char* topic)` — `NULL` when unset
  - `bool alias_store::set(const char* topic, const char* name)` — `false` when the
    table or the blob is full; an empty `name` removes
  - `bool alias_store::remove(const char* topic)`
  - `uint8_t alias_store::count()`
  - `const char* alias_store::topicAt(uint8_t i)` — `NULL` past the end
  - `const char* alias_store::nameAt(uint8_t i)` — `NULL` past the end
  - `bool alias_store::selfTest()` under `FAKE_SIGNALS`
  - Constants `ALIAS_SLOTS` 32, `ALIAS_TOPIC_MAX` 96, `ALIAS_NAME_MAX` 32,
    `ALIAS_BLOB_MAX` 2048

  Entries are kept compacted: `remove()` shifts the tail down, so indices
  `0..count()-1` are always populated.

- [ ] **Step 1: Write the header**

Create `alias_store.h`:

```cpp
#pragma once

#include <Arduino.h>

#define ALIAS_SLOTS     32
#define ALIAS_TOPIC_MAX 96
#define ALIAS_NAME_MAX  32
// NVS keys are limited to 15 characters and an alias topic runs to 96, so the
// whole table is one blob under one key rather than an entry per alias.
#define ALIAS_BLOB_MAX  2048

namespace alias_store {
bool        begin();
const char* get(const char* topic);
bool        set(const char* topic, const char* name);
bool        remove(const char* topic);
uint8_t     count();
const char* topicAt(uint8_t i);
const char* nameAt(uint8_t i);
#ifdef FAKE_SIGNALS
bool selfTest();
#endif
} // namespace alias_store
```

- [ ] **Step 2: Write the implementation**

Create `alias_store.cpp`:

```cpp
#include "alias_store.h"

#include <ArduinoJson.h>
#include <ArduinoLog.h>
#include <Preferences.h>

namespace alias_store {

static char        _topics[ALIAS_SLOTS][ALIAS_TOPIC_MAX];
static char        _names[ALIAS_SLOTS][ALIAS_NAME_MAX];
static uint8_t     _count = 0;
static Preferences _prefs;
static bool        _open = false;

static void copyTruncated(char* dest, size_t destSize, const char* src) {
  strncpy(dest, src, destSize - 1);
  dest[destSize - 1] = '\0';
}

static int find(const char* topic) {
  for (uint8_t i = 0; i < _count; i++) {
    if (strcmp(_topics[i], topic) == 0) {
      return i;
    }
  }
  return -1;
}

static size_t serializeTable(char* out, size_t size) {
  JsonDocument doc;
  for (uint8_t i = 0; i < _count; i++) {
    doc[(const char*)_topics[i]] = (const char*)_names[i];
  }
  if (measureJson(doc) >= size) {
    return 0;
  }
  return serializeJson(doc, out, size);
}

static void loadTable(const char* json) {
  _count = 0;
  JsonDocument doc;
  if (json == NULL || *json == '\0') {
    return;
  }
  if (deserializeJson(doc, json) != DeserializationError::Ok) {
    return;
  }
  JsonObject obj = doc.as<JsonObject>();
  if (obj.isNull()) {
    return;
  }
  for (JsonPair kv : obj) {
    if (_count >= ALIAS_SLOTS || !kv.value().is<const char*>()) {
      continue;
    }
    copyTruncated(_topics[_count], ALIAS_TOPIC_MAX, kv.key().c_str());
    copyTruncated(_names[_count], ALIAS_NAME_MAX, kv.value().as<const char*>());
    _count++;
  }
}

static bool persist() {
  char   blob[ALIAS_BLOB_MAX];
  size_t n = serializeTable(blob, sizeof(blob));
  if (n == 0 && _count > 0) {
    return false;
  }
  if (!_open) {
    return true;
  }
  return _prefs.putString("map", blob) > 0 || _count == 0;
}

bool begin() {
  _count = 0;
  _open = _prefs.begin("alias", false);
  if (!_open) {
    Log.warning(F("alias store: NVS unavailable, aliases will not persist" CR));
    return false;
  }
  String stored = _prefs.getString("map", "");
  loadTable(stored.c_str());
  Log.notice(F("alias store: %d aliases loaded" CR), (int)_count);
  return true;
}

const char* get(const char* topic) {
  int i = find(topic);
  return i < 0 ? NULL : _names[i];
}

bool set(const char* topic, const char* name) {
  if (topic == NULL || name == NULL || strlen(topic) >= ALIAS_TOPIC_MAX) {
    return false;
  }
  if (*name == '\0') {
    return remove(topic);
  }
  int  i = find(topic);
  char previous[ALIAS_NAME_MAX];
  bool added = (i < 0);
  if (added) {
    if (_count >= ALIAS_SLOTS) {
      return false;
    }
    i = _count++;
    copyTruncated(_topics[i], ALIAS_TOPIC_MAX, topic);
    previous[0] = '\0';
  } else {
    copyTruncated(previous, sizeof(previous), _names[i]);
  }
  copyTruncated(_names[i], ALIAS_NAME_MAX, name);
  if (persist()) {
    return true;
  }
  if (added) {
    _count--;
  } else {
    copyTruncated(_names[i], ALIAS_NAME_MAX, previous);
  }
  return false;
}

bool remove(const char* topic) {
  int i = find(topic);
  if (i < 0) {
    return false;
  }
  for (uint8_t j = (uint8_t)i; j + 1 < _count; j++) {
    memcpy(_topics[j], _topics[j + 1], ALIAS_TOPIC_MAX);
    memcpy(_names[j], _names[j + 1], ALIAS_NAME_MAX);
  }
  _count--;
  persist();
  return true;
}

uint8_t count() {
  return _count;
}

const char* topicAt(uint8_t i) {
  return i < _count ? _topics[i] : NULL;
}

const char* nameAt(uint8_t i) {
  return i < _count ? _names[i] : NULL;
}

#ifdef FAKE_SIGNALS
static bool check(const char* what, bool ok) {
  Log.notice(F("alias selfTest %s: %s" CR), what, ok ? "PASS" : "FAIL");
  return ok;
}

bool selfTest() {
  bool ok = true;
  char blob[ALIAS_BLOB_MAX];
  char topic[ALIAS_TOPIC_MAX];

  _count = 0;
  ok &= check("an unset topic has no alias", get("s/M/1/$alias") == NULL);
  ok &= check("set stores a name", set("s/M/1/$alias", "Back fence"));
  ok &= check("get returns the name",
              get("s/M/1/$alias") != NULL && strcmp(get("s/M/1/$alias"), "Back fence") == 0);
  ok &= check("set of the same topic replaces in place",
              set("s/M/1/$alias", "Front gate") && count() == 1 &&
                  strcmp(get("s/M/1/$alias"), "Front gate") == 0);
  ok &= check("an empty name removes", set("s/M/1/$alias", "") && get("s/M/1/$alias") == NULL);
  ok &= check("removing an unset topic reports false", !remove("s/M/1/$alias"));

  _count = 0;
  set("s/M/1/$alias", "one");
  set("s/M/2/$alias", "two");
  set("s/M/3/$alias", "three");
  remove("s/M/2/$alias");
  ok &= check("removal compacts the table", count() == 2);
  ok &= check("the tail shifts down", strcmp(topicAt(1), "s/M/3/$alias") == 0);
  ok &= check("names follow their topics", strcmp(nameAt(1), "three") == 0);
  ok &= check("an index past the end is NULL", topicAt(2) == NULL && nameAt(2) == NULL);

  _count = 0;
  bool capped = true;
  for (int i = 0; i < ALIAS_SLOTS; i++) {
    snprintf(topic, sizeof(topic), "s/M/%d/$alias", i);
    capped &= set(topic, "n");
  }
  ok &= check("the table fills to ALIAS_SLOTS", capped && count() == ALIAS_SLOTS);
  ok &= check("a set past the cap fails", !set("s/M/99/$alias", "n"));
  ok &= check("a failed set leaves the table alone", count() == ALIAS_SLOTS);

  _count = 0;
  set("s/M/1/$alias", "Back \"fence\"");
  set("s/$alias", "Garage");
  size_t n = serializeTable(blob, sizeof(blob));
  ok &= check("the table serialises", n > 0);
  _count = 0;
  loadTable(blob);
  ok &= check("a serialised blob reloads", count() == 2);
  ok &= check("a quoted name survives the round trip",
              get("s/M/1/$alias") != NULL && strcmp(get("s/M/1/$alias"), "Back \"fence\"") == 0);
  ok &= check("a source level alias survives the round trip",
              get("s/$alias") != NULL && strcmp(get("s/$alias"), "Garage") == 0);

  _count = 0;
  loadTable("not json at all");
  ok &= check("an unparseable blob loads as empty", count() == 0);

  _count = 0;
  Log.notice(F("alias selfTest overall: %s" CR), ok ? "PASS" : "FAIL");
  return ok;
}
#endif

} // namespace alias_store
```

- [ ] **Step 3: Wire it into the sketch**

In `WebReceiver.ino`, add the include beside the others:

```cpp
#include "alias_store.h"
```

In `setup()`, add `alias_store::begin()` immediately after `connectWiFi();`:

```cpp
  connectWiFi();
  alias_store::begin();
  web_ui::begin();
```

and add the self-test beside the existing one:

```cpp
#ifdef FAKE_SIGNALS
  signal_store::selfTest();
  alias_store::selfTest();
#endif
```

- [ ] **Step 4: Verify the firmware builds**

Run: `pio run -e esp32s3-generic`
Expected: `[SUCCESS]`

- [ ] **Step 5: Verify the self-test compiles**

Run: `pio run -e esp32s3-generic -v 2>&1 | grep -c "FAKE_SIGNALS"` is not a check;
instead temporarily enable the flag:

```bash
sed -i "s|^;  '-DFAKE_SIGNALS=true'|  '-DFAKE_SIGNALS=true'|" platformio.ini
pio run -e esp32s3-generic
sed -i "s|^  '-DFAKE_SIGNALS=true'|;  '-DFAKE_SIGNALS=true'|" platformio.ini
git diff --stat platformio.ini
```

Expected: `[SUCCESS]` from the build, and `git diff --stat platformio.ini` prints
nothing, showing the flag was restored.

- [ ] **Step 6: Commit**

```bash
git add alias_store.h alias_store.cpp WebReceiver.ino
git commit -m "Persist aliases on the device in a fixed table"
```

---

### Task 3: Topic keys and stamped payloads in signal_store

**Files:**
- Modify: `signal_store.h` — buffer sizes, `DeviceSlot`, the namespace
- Modify: `signal_store.cpp` — `buildKey`, `record`, the deleted event ring, `selfTest`
- Modify: `web_ui.cpp` — remove the event ring's two uses in `handleState` so the
  build stays green; the rest of `web_ui` is Task 5 and 6

**Model:** `sonnet` — reshapes the store's core and its self-test.

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `void signal_store::setSource(const char* source)`
  - `const char* signal_store::source()` — defaults to `"rtl433"`
  - `const DeviceSlot* signal_store::slotAt(uint8_t i)` — raw table index
    `0..SIGNAL_DEVICE_SLOTS-1`, `NULL` when that slot is unused. Unlike `device(i)`
    this index does not move as devices are heard from, which is what the replay
    cursor in Task 6 walks.
  - `DeviceSlot` loses `model` and `rssi`; the payload now carries both.
  - `signal_store::eventCount`, `signal_store::event`, and `struct SignalEvent`
    are gone.

- [ ] **Step 1: Rewrite the header**

Replace the whole of `signal_store.h`:

```cpp
#pragma once

#include <Arduino.h>

// The rtl_433 message plus the time, rssi and count record() stamps into it. The
// library's own buffer is 512 bytes and the three fields cost about 56.
#define SIGNAL_PAYLOAD_MAX  600
#define SIGNAL_DEVICE_SLOTS 24
// A 14 byte source, a 64 byte model, and a 16 byte id.
#define SIGNAL_KEY_MAX      96
#define SIGNAL_MODEL_MAX    64
#define SIGNAL_SOURCE_MAX   32

struct DeviceSlot {
  char          key[SIGNAL_KEY_MAX];
  char          payload[SIGNAL_PAYLOAD_MAX + 1];
  unsigned long lastSeen;
  uint32_t      count;
  bool          used;
};

namespace signal_store {
void reset();
// The first segment of every key. mdnsHostname() supplies it once WiFi is up.
void        setSource(const char* source);
const char* source();
// isDecode false records the receiver's own telemetry: it takes a device slot
// like any other, but stays out of the decode count.
bool              record(const char* payload, int rssi, bool isDecode = true);
uint8_t           deviceCount();
const DeviceSlot& device(uint8_t i);
// Raw table index rather than recency order, so a cursor over it does not skip
// or repeat a slot when a device is heard from mid-walk.
const DeviceSlot* slotAt(uint8_t i);
void              sweepStale(unsigned long now, unsigned long staleMs);
uint32_t          totalRecorded();
uint32_t          droppedCount();
#ifdef FAKE_SIGNALS
bool selfTest();
#endif
} // namespace signal_store
```

- [ ] **Step 2: Rewrite the store's body**

In `signal_store.cpp`, add `#include <time.h>` under the existing includes, then
replace everything from the static declarations down to the end of `record()` with:

```cpp
static DeviceSlot _devices[SIGNAL_DEVICE_SLOTS];
static uint32_t   _seq[SIGNAL_DEVICE_SLOTS]; // orders and evicts devices; unlike lastSeen, never rolls over
static uint8_t    _order[SIGNAL_DEVICE_SLOTS];
static uint8_t    _deviceCount = 0;
static uint32_t   _seqCounter = 0;
static uint32_t   _total = 0;
static uint32_t   _dropped = 0;
static char       _source[SIGNAL_SOURCE_MAX] = "rtl433";

void reset() {
  memset(_devices, 0, sizeof(_devices));
  memset(_seq, 0, sizeof(_seq));
  _deviceCount = 0;
  _seqCounter = 0;
  _total = 0;
  _dropped = 0;
}

static void copyTruncated(char* dest, size_t destSize, const char* src) {
  strncpy(dest, src, destSize - 1);
  dest[destSize - 1] = '\0';
}

void setSource(const char* source) {
  if (source != NULL && source[0] != '\0') {
    copyTruncated(_source, sizeof(_source), source);
  }
}

const char* source() {
  return _source;
}

// A topic segment holding a slash or a space would not parse back out of the
// topic, and rtl_433 model names are free text.
static void sanitizeSegment(char* s) {
  for (char* p = s; *p; p++) {
    if (*p == '/' || *p == ' ' || *p == '+' || *p == '#') {
      *p = '-';
    }
  }
}

static bool buildKey(const JsonDocument& doc, char* key, size_t keySize) {
  const char* m = doc["model"];
  if (m == NULL || m[0] == '\0') {
    return false;
  }
  char model[SIGNAL_MODEL_MAX];
  copyTruncated(model, sizeof(model), m);
  sanitizeSegment(model);

  char id[16];
  if (doc["id"].is<const char*>() || doc["id"].is<long>() ||
      doc["id"].is<unsigned long>()) {
    copyTruncated(id, sizeof(id), doc["id"].as<String>().c_str());
  } else if (!doc["channel"].isNull()) {
    copyTruncated(id, sizeof(id), doc["channel"].as<String>().c_str());
  } else {
    // The binding requires an id segment; a device with one instance uses 0.
    strcpy(id, "0");
  }
  sanitizeSegment(id);

  snprintf(key, keySize, "%s/%s/%s", _source, model, id);
  return true;
}

static int findSlot(const char* key) {
  for (int i = 0; i < SIGNAL_DEVICE_SLOTS; i++) {
    if (_devices[i].used && strcmp(_devices[i].key, key) == 0) {
      return i;
    }
  }
  return -1;
}

static int claimSlot() {
  for (int i = 0; i < SIGNAL_DEVICE_SLOTS; i++) {
    if (!_devices[i].used) {
      _deviceCount++;
      return i;
    }
  }
  int oldest = 0;
  for (int i = 1; i < SIGNAL_DEVICE_SLOTS; i++) {
    if (_seq[i] < _seq[oldest]) {
      oldest = i;
    }
  }
  memset(&_devices[oldest], 0, sizeof(DeviceSlot));
  return oldest;
}

// An age has to be computable from a retained replay, which the binding's frame
// does not otherwise carry. Empty until SNTP has set the clock.
static bool isoTime(char* out, size_t size) {
  time_t now = time(NULL);
  if (now < 1700000000) { // before 2023; the clock has not been set
    return false;
  }
  struct tm utc;
  gmtime_r(&now, &utc);
  return strftime(out, size, "%Y-%m-%dT%H:%M:%SZ", &utc) > 0;
}

bool record(const char* payload, int rssi, bool isDecode) {
  JsonDocument doc;
  if (deserializeJson(doc, payload) != DeserializationError::Ok) {
    _dropped++;
    return false;
  }
  char key[SIGNAL_KEY_MAX];
  if (!buildKey(doc, key, sizeof(key))) {
    _dropped++;
    return false;
  }

  int      idx = findSlot(key);
  uint32_t count = (idx < 0 ? 0 : _devices[idx].count) + 1;

  char stamp[24];
  if (isoTime(stamp, sizeof(stamp))) {
    doc["time"] = stamp;
  }
  doc["rssi"] = rssi;
  doc["count"] = count;

  // The frame embeds the payload as JSON rather than as an escaped string, so a
  // truncated one would be unparseable on the wire. Drop it instead.
  if (measureJson(doc) > SIGNAL_PAYLOAD_MAX) {
    _dropped++;
    return false;
  }

  if (idx < 0) {
    idx = claimSlot();
    copyTruncated(_devices[idx].key, SIGNAL_KEY_MAX, key);
    _devices[idx].used = true;
  }
  DeviceSlot& slot = _devices[idx];
  serializeJson(doc, slot.payload, sizeof(slot.payload));
  slot.lastSeen = millis();
  slot.count = count;
  _seq[idx] = ++_seqCounter;

  if (isDecode) {
    _total++;
  }
  return true;
}
```

Delete `pushEvent()`, `eventCount()`, and `event()` entirely, and add `slotAt()`
beside `device()`:

```cpp
const DeviceSlot* slotAt(uint8_t i) {
  if (i >= SIGNAL_DEVICE_SLOTS || !_devices[i].used) {
    return NULL;
  }
  return &_devices[i];
}
```

- [ ] **Step 3: Keep the build green**

`web_ui.cpp`'s `handleState()` reads the event ring, which no longer exists. Delete
these lines from `handleState()`, leaving the rest of the function alone:

```cpp
  out.print("],\"events\":[");
  uint8_t events = signal_store::eventCount();
  for (uint8_t i = 0; i < events; i++) {
    const SignalEvent& e = signal_store::event(i);
    if (i) {
      out.print(',');
    }
    char at[40];
    snprintf(at, sizeof(at), "{\"at\":%lu,\"payload\":", e.at);
    out.print(at);
    writeJsonString(out, e.payload);
    out.print('}');
  }
  out.print("]}");
```

and put back a terminator plus the two now-missing slot fields:

```cpp
  out.print("]}");
```

In the same function, replace the device loop's body, which reads `d.model` and
`d.rssi`:

```cpp
    out.print("{\"key\":");
    writeJsonString(out, d.key);
    char nums[64];
    snprintf(nums, sizeof(nums), ",\"lastSeen\":%lu,\"count\":%lu,\"payload\":",
             d.lastSeen, (unsigned long)d.count);
    out.print(nums);
    writeJsonString(out, d.payload);
    out.print('}');
```

In `broadcast()`, delete the `slot.rssi` line and its label:

```cpp
  frame.print(",\"rssi\":");
  frame.print(slot.rssi);
```

`handleState` and this whole frame shape are deleted in Task 6; this step only
keeps the tree compiling between commits.

- [ ] **Step 4: Update the self-test**

In `signal_store.cpp`'s `selfTest()`, set a known source first and replace the key
and event-ring checks. The replacement for the whole function body, keeping the
sweep and rollover blocks from the current file verbatim at the end:

```cpp
bool selfTest() {
  bool ok = true;
  char buf[SIGNAL_PAYLOAD_MAX + 64];

  setSource("rtl433-a1b2c3");
  reset();
  ok &= check("record accepts a decode",
              record("{\"model\":\"Acurite-Tower\",\"id\":1234,\"temperature_C\":21.5}", -70));
  ok &= check("one device after one decode", deviceCount() == 1);
  ok &= check("key is source/model/id",
              strcmp(device(0).key, "rtl433-a1b2c3/Acurite-Tower/1234") == 0);
  ok &= check("rssi is stamped into the payload",
              strstr(device(0).payload, "\"rssi\":-70") != NULL);
  ok &= check("count is stamped into the payload",
              strstr(device(0).payload, "\"count\":1") != NULL);

  record("{\"model\":\"Acurite-Tower\",\"id\":1234,\"temperature_C\":21.6}", -71);
  ok &= check("same key updates in place", deviceCount() == 1);
  ok &= check("count increments", device(0).count == 2);
  ok &= check("the stamped count follows",
              strstr(device(0).payload, "\"count\":2") != NULL);

  ok &= check("channel is the id segment when id is absent",
              record("{\"model\":\"Nexus-TH\",\"channel\":2}", -60) &&
                  strcmp(device(0).key, "rtl433-a1b2c3/Nexus-TH/2") == 0);
  ok &= check("the id segment is 0 when id and channel are absent",
              record("{\"model\":\"Generic-Remote\"}", -60) &&
                  strcmp(device(0).key, "rtl433-a1b2c3/Generic-Remote/0") == 0);
  ok &= check("a slash in a model name is replaced",
              record("{\"model\":\"Odd/Name\",\"id\":1}", -60) &&
                  strcmp(device(0).key, "rtl433-a1b2c3/Odd-Name/1") == 0);

  reset();
  for (int i = 0; i < SIGNAL_DEVICE_SLOTS + 6; i++) {
    snprintf(buf, sizeof(buf), "{\"model\":\"Dev\",\"id\":%d}", i);
    record(buf, -70);
    delay(2);
  }
  ok &= check("table caps at SIGNAL_DEVICE_SLOTS", deviceCount() == SIGNAL_DEVICE_SLOTS);
  ok &= check("newest survives eviction",
              strcmp(device(0).key, "rtl433-a1b2c3/Dev/29") == 0);
  ok &= check("oldest was evicted",
              strcmp(device(SIGNAL_DEVICE_SLOTS - 1).key, "rtl433-a1b2c3/Dev/6") == 0);

  reset();
  record("{\"model\":\"Dev\",\"id\":1}", -70);
  ok &= check("slotAt finds a used slot", slotAt(0) != NULL);
  ok &= check("slotAt reports an unused slot",
              slotAt(SIGNAL_DEVICE_SLOTS - 1) == NULL);
  ok &= check("slotAt bounds its index", slotAt(SIGNAL_DEVICE_SLOTS) == NULL);

  reset();
  ok &= check("unparseable payload is dropped", !record("not json at all", -70));
  ok &= check("payload without model is dropped", !record("{\"id\":7}", -70));
  ok &= check("dropped counter advances", droppedCount() == 2);
  ok &= check("dropped payloads leave no device", deviceCount() == 0);

  reset();
  record("{\"model\":\"Real\",\"id\":1}", -70);
  record("{\"model\":\"Receiver\",\"temperature_C\":40}", -50, false);
  ok &= check("telemetry takes a device slot", deviceCount() == 2);
  ok &= check("telemetry keys with a 0 id",
              strcmp(device(0).key, "rtl433-a1b2c3/Receiver/0") == 0);
  ok &= check("telemetry is not counted as a decode", totalRecorded() == 1);

  reset();
  char note[SIGNAL_PAYLOAD_MAX]; // valid JSON, but longer than a slot holds
  memset(note, 'A', sizeof(note) - 1);
  note[sizeof(note) - 1] = '\0';
  snprintf(buf, sizeof(buf), "{\"model\":\"Long\",\"id\":1,\"note\":\"%s\"}", note);
  ok &= check("an over-long payload is dropped rather than truncated",
              !record(buf, -70) && deviceCount() == 0);

  reset();
  record("{\"model\":\"Stale\",\"id\":1,\"temperature_C\":1}", -50);
  record("{\"model\":\"Fresh\",\"id\":2,\"temperature_C\":2}", -50);
  ok &= check("both devices present before sweep", deviceCount() == 2);
```

Keep the rest of the existing function — the sweep block, the millis rollover
block, and the closing `Log.notice`/`return ok;` — exactly as it is.

- [ ] **Step 5: Verify the firmware builds, with and without the self-test**

Run:

```bash
pio run -e esp32s3-generic
sed -i "s|^;  '-DFAKE_SIGNALS=true'|  '-DFAKE_SIGNALS=true'|" platformio.ini
pio run -e esp32s3-generic
sed -i "s|^  '-DFAKE_SIGNALS=true'|;  '-DFAKE_SIGNALS=true'|" platformio.ini
git diff --stat platformio.ini
```

Expected: `[SUCCESS]` twice, and no diff on `platformio.ini`. Note the reported RAM
figure; the event ring's 20,520 bytes should be gone.

- [ ] **Step 6: Commit**

```bash
git add signal_store.h signal_store.cpp web_ui.cpp
git commit -m "Key devices by topic and stamp time, rssi and count into the payload"
```

---

### Task 4: The clock, the source name, and the build id

**Files:**
- Modify: `WebReceiver.ino` — `configTime` on connect, `signal_store::setSource`,
  `build` in the telemetry record

**Model:** `sonnet` — touches the WiFi lifecycle.

**Interfaces:**
- Consumes: `signal_store::setSource` from Task 3.
- Produces: `<source>/Receiver/0` messages carrying `build`, which the page reads
  in Task 8 to reload after a reflash. `mdnsHostname()` stays as it is.

- [ ] **Step 1: Sync the clock whenever WiFi comes up**

In `WebReceiver.ino`, add a helper above `startMDNS()`:

```cpp
// The device has no RTC, so record() gets its timestamp from SNTP. Resynced on
// each reconnect; until the first sync a message carries no time at all.
static void startTime() {
  configTime(0, 0, "pool.ntp.org");
}
```

Call it from both places that notice a connection. In `connectWiFi()`:

```cpp
  if (wifiReady()) {
    Log.notice(F("WiFi connected: %s" CR), WiFi.localIP().toString().c_str());
    startMDNS();
    startTime();
    signal_store::setSource(mdnsHostname());
    wifiWasConnected = true;
  } else {
```

and in `serviceWiFi()`:

```cpp
    if (!wifiWasConnected) {
      wifiWasConnected = true;
      Log.notice(F("WiFi up: %s" CR), WiFi.localIP().toString().c_str());
      startMDNS();
      startTime();
      signal_store::setSource(mdnsHostname());
    }
```

- [ ] **Step 2: Set the source even with no WiFi**

`mdnsHostname()` reads the MAC, which `WiFi.mode(WIFI_STA)` in `connectWiFi()` has
already made available, so a failed connect still names the source. In `setup()`,
after `connectWiFi();`:

```cpp
  connectWiFi();
  signal_store::setSource(mdnsHostname());
  alias_store::begin();
```

- [ ] **Step 3: Put the build id in the telemetry**

Add the fallback near the other `#ifndef` blocks at the top of `WebReceiver.ino`:

```cpp
#ifndef BUILD_ID
#  define BUILD_ID "dev"
#endif
```

and add the field in `recordReceiver()`, in the first `appendf`:

```cpp
  n = appendf(buf, sizeof(buf), n,
              "{\"model\":\"Receiver\",\"build\":\"" BUILD_ID "\","
              "\"temperature_C\":%.1f,\"heap_kB\":%lu",
              temperatureRead(), (unsigned long)(ESP.getFreeHeap() / 1024));
```

- [ ] **Step 4: Verify the firmware builds**

Run: `pio run -e esp32s3-generic`
Expected: `[SUCCESS]`

- [ ] **Step 5: Commit**

```bash
git add WebReceiver.ino
git commit -m "Name the source, sync the clock, and report the build in telemetry"
```

---

### Task 5: GET and POST of a topic

**Files:**
- Modify: `web_ui.cpp` — delete `handleState` and `handleStatus`, add the topic
  dispatcher
- Modify: `web_ui.h` — no signature change yet

**Model:** `sonnet` — routing and status handling across an existing file.

**Interfaces:**
- Consumes: `topic::*` (Task 1), `alias_store::*` (Task 2), `signal_store::slotAt`
  and `signal_store::source` (Task 3).
- Produces: `GET /<topic>`, `POST /<topic>` behaviour. `/events` is Task 6.

- [ ] **Step 1: Delete the old endpoints**

In `web_ui.cpp`, delete `handleState()` and `handleStatus()` in full, and their two
`_server.on(...)` registrations in `begin()`. Delete the now-unused
`extern bool wifiReady();` only if nothing else in the file uses it — `loop()` does,
so keep it.

- [ ] **Step 2: Add the dispatcher**

Add the includes at the top of `web_ui.cpp`:

```cpp
#include "alias_store.h"
#include "topic.h"
```

and add these handlers above `begin()`:

```cpp
static void sendStatus(int code, const char* body) {
  _server.sendHeader("Cache-Control", "no-store");
  _server.send(code, "text/plain", body);
}

static void handleAliasPost(const char* path) {
  const char* src = signal_store::source();
  size_t      srcLen = strlen(src);
  bool        ownSource = strncmp(path, src, srcLen) == 0 && path[srcLen] == '/';
  if (!topic::isAlias(path) || !ownSource) {
    sendStatus(405, "not allowed");
    return;
  }
  String body = _server.arg("plain");
  JsonDocument doc;
  if (deserializeJson(doc, body) != DeserializationError::Ok || !doc.is<const char*>()) {
    sendStatus(400, "body must be a JSON string");
    return;
  }
  const char* name = doc.as<const char*>();
  if (*name == '\0') {
    alias_store::remove(path);
  } else if (!alias_store::set(path, name)) {
    sendStatus(503, "alias store full");
    return;
  }
  web_ui::broadcastAlias(path, name);
  _server.sendHeader("Cache-Control", "no-store");
  _server.send(204, "text/plain", "");
}

static void handleTopic() {
  String      uri = _server.uri();
  const char* path = uri.c_str();
  if (*path == '/') {
    path++;
  }
  if (!topic::validTopic(path)) {
    sendStatus(400, "malformed topic");
    return;
  }
  if (_server.method() == HTTP_POST) {
    handleAliasPost(path);
    return;
  }
  if (_server.method() != HTTP_GET) {
    sendStatus(405, "not allowed");
    return;
  }
  if (topic::isAlias(path)) {
    const char* name = alias_store::get(path);
    if (name == NULL) {
      sendStatus(404, "no message");
      return;
    }
    FrameBuffer json;
    writeJsonString(json, name);
    _server.sendHeader("Cache-Control", "no-store");
    _server.send(200, "application/json", String(json.data()));
    return;
  }
  for (uint8_t i = 0; i < SIGNAL_DEVICE_SLOTS; i++) {
    const DeviceSlot* slot = signal_store::slotAt(i);
    if (slot != NULL && strcmp(slot->key, path) == 0) {
      _server.sendHeader("Cache-Control", "no-store");
      _server.send(200, "application/json", slot->payload);
      return;
    }
  }
  sendStatus(404, "no message");
}
```

`FrameBuffer` is declared in the anonymous namespace above; it needs a
null-terminated `data()`, which it already has since `_len` never reaches
`sizeof(_buf)`.

- [ ] **Step 3: Register it**

Replace `begin()`'s body:

```cpp
void begin() {
  _server.on("/", HTTP_GET, handleRoot);
  _server.on("/events", HTTP_GET, handleEvents);
  // Topics are arbitrary paths, so every other request is dispatched here.
  _server.onNotFound(handleTopic);
  _server.begin();
  _started = true;
  Log.notice(F("web server listening on port 80" CR));
}
```

- [ ] **Step 4: Declare the alias broadcast**

`handleAliasPost` calls `web_ui::broadcastAlias`, which Task 6 implements. Add the
declaration to `web_ui.h` now and a stub to `web_ui.cpp` so this task builds:

In `web_ui.h`:

```cpp
void broadcastAlias(const char* topic, const char* name);
```

In `web_ui.cpp`, beside `broadcast()`:

```cpp
void broadcastAlias(const char* topic, const char* name) {
  (void)topic;
  (void)name;
}
```

- [ ] **Step 5: Verify the firmware builds**

Run: `pio run -e esp32s3-generic`
Expected: `[SUCCESS]`

- [ ] **Step 6: Commit**

```bash
git add web_ui.h web_ui.cpp
git commit -m "Serve GET and POST of a topic, drop /api/state and /api/status"
```

---

### Task 6: Filtered subscriptions and the retained replay

**Files:**
- Modify: `web_ui.cpp` — `handleEvents`, the replay cursor, `broadcast`,
  `broadcastAlias`, `FrameBuffer`
- Modify: `web_ui.h` — `broadcast` signature
- Modify: `WebReceiver.ino` — the two `web_ui::broadcast` calls

**Model:** `sonnet` — the most intricate firmware change; touches the loop budget.

**Interfaces:**
- Consumes: `topic::matchFilter` (Task 1), `alias_store::topicAt`/`nameAt`/`count`
  (Task 2), `signal_store::slotAt` (Task 3).
- Produces:
  - `void web_ui::broadcast(const DeviceSlot& slot)` — the `isDecode` parameter is
    gone; the page no longer needs a telemetry marker.
  - `void web_ui::broadcastAlias(const char* topic, const char* name)` — a removal
    passes `""`, which tells live viewers the name is cleared.

- [ ] **Step 1: Size the frame buffer for the new shape**

In `web_ui.cpp`'s anonymous namespace, replace `FrameBuffer`'s buffer comment and
size:

```cpp
  // "data: {"topic":"","payload":}\n\n" plus a key, plus a payload that is
  // embedded raw for a device and escaped for an alias, where escaping can
  // double it.
  char _buf[64 + SIGNAL_KEY_MAX + (2 * SIGNAL_PAYLOAD_MAX + 2) + 1];
```

- [ ] **Step 2: Add per-slot filters and a replay cursor**

Replace the SSE state declarations near the top of `namespace web_ui`:

```cpp
#define WEB_UI_SSE_CLIENTS 4
#define WEB_UI_SSE_FILTERS 4
#define WEB_UI_FILTER_MAX  65
#define SSE_KEEPALIVE_MS   15000
// A browser reading 24 payloads of 600 bytes in one pass overflows the socket's
// send buffer and is dropped, so the replay is drained a few frames per loop().
#define REPLAY_PER_LOOP    3

static WiFiClient    _sse[WEB_UI_SSE_CLIENTS];
static uint32_t      _sseAttachedAt[WEB_UI_SSE_CLIENTS] = {0};
static char          _filters[WEB_UI_SSE_CLIENTS][WEB_UI_SSE_FILTERS][WEB_UI_FILTER_MAX];
static uint8_t       _filterCount[WEB_UI_SSE_CLIENTS] = {0};
static int16_t       _replay[WEB_UI_SSE_CLIENTS] = {-1, -1, -1, -1};
static uint32_t      _sseAttachCounter = 0;
static unsigned long _lastKeepalive = 0;
```

- [ ] **Step 3: Send a frame to one slot**

Add above `handleEvents()`:

```cpp
static bool slotWants(int i, const char* topic) {
  for (uint8_t f = 0; f < _filterCount[i]; f++) {
    if (topic::matchFilter(_filters[i][f], topic)) {
      return true;
    }
  }
  return false;
}

// payload is JSON text, embedded as it stands: an object for a device, a quoted
// string for an alias.
static void buildFrame(FrameBuffer& frame, const char* topic, const char* payload) {
  frame.print("data: {\"topic\":");
  writeJsonString(frame, topic);
  frame.print(",\"payload\":");
  frame.print(payload);
  frame.print("}\n\n");
}

static void sendTo(int i, const FrameBuffer& frame) {
  WiFiClient& c = _sse[i];
  if (!c) {
    return;
  }
  if (!socketReadyToWrite(c)) {
    Log.warning(F("SSE slot %d not ready, dropping" CR), i);
    c.stop();
    _filterCount[i] = 0;
    _replay[i] = -1;
    return;
  }
  sendFrameOrDrop(c, frame.data(), frame.length());
}
```

`writeJsonString` is declared in `web_ui.h` and defined below the anonymous
namespace; move its definition above these helpers, or add a file-scope forward
declaration beside them.

- [ ] **Step 4: Parse filters on connect**

Replace `handleEvents()`:

```cpp
static void handleEvents() {
  WiFiClient client = _server.client();

  char    filters[WEB_UI_SSE_FILTERS][WEB_UI_FILTER_MAX];
  uint8_t count = 0;
  for (uint8_t i = 0; i < _server.args(); i++) {
    if (_server.argName(i) != "f") {
      continue;
    }
    String v = _server.arg(i);
    if (count >= WEB_UI_SSE_FILTERS || v.length() >= WEB_UI_FILTER_MAX ||
        !topic::validFilter(v.c_str())) {
      _server.send(400, "text/plain", "bad filter");
      return;
    }
    strcpy(filters[count++], v.c_str());
  }
  if (count == 0) {
    strcpy(filters[count++], "#");
  }

  reapClosedClients();

  int slot = -1;
  for (int i = 0; i < WEB_UI_SSE_CLIENTS; i++) {
    if (!_sse[i]) {
      slot = i;
      break;
    }
  }
  if (slot < 0) {
    // A peer that vanishes without a FIN holds its slot until a write fails, so
    // drop the longest-attached stream rather than locking a new viewer out.
    slot = 0;
    for (int i = 1; i < WEB_UI_SSE_CLIENTS; i++) {
      if (_sseAttachedAt[i] < _sseAttachedAt[slot]) {
        slot = i;
      }
    }
    _sse[slot].stop();
    Log.notice(F("SSE slots full, evicted slot %d" CR), slot);
  }
  static const char header[] = "HTTP/1.1 200 OK\r\n"
                                "Content-Type: text/event-stream\r\n"
                                "Cache-Control: no-store\r\n"
                                "Connection: keep-alive\r\n"
                                "\r\n"
                                "retry: 3000\r\n\r\n";
  sendFrameOrDrop(client, header, sizeof(header) - 1);
  if (!client.connected()) {
    return;
  }
  _sse[slot] = client;
  _sseAttachedAt[slot] = ++_sseAttachCounter;
  _filterCount[slot] = count;
  for (uint8_t f = 0; f < count; f++) {
    strcpy(_filters[slot][f], filters[f]);
  }
  _replay[slot] = 0;
  Log.notice(F("SSE client attached to slot %d, %d filters" CR), slot, (int)count);
}
```

- [ ] **Step 5: Drain the replay in loop()**

Add above `loop()`:

```cpp
// The cursor walks raw device slots and then the alias table, so a device heard
// from mid-replay is delivered with its newer payload when the cursor reaches
// it, and one evicted mid-replay is simply not delivered.
static void drainReplay(int i) {
  for (int sent = 0; sent < REPLAY_PER_LOOP && _replay[i] >= 0; ) {
    int16_t at = _replay[i]++;
    const char* topic = NULL;
    const char* payload = NULL;
    FrameBuffer frame;
    if (at < SIGNAL_DEVICE_SLOTS) {
      const DeviceSlot* slot = signal_store::slotAt((uint8_t)at);
      if (slot == NULL) {
        continue;
      }
      topic = slot->key;
      payload = slot->payload;
      if (!slotWants(i, topic)) {
        continue;
      }
      buildFrame(frame, topic, payload);
    } else if (at < SIGNAL_DEVICE_SLOTS + ALIAS_SLOTS) {
      topic = alias_store::topicAt((uint8_t)(at - SIGNAL_DEVICE_SLOTS));
      if (topic == NULL) {
        _replay[i] = -1; // the table is compacted, so the first hole is the end
        return;
      }
      if (!slotWants(i, topic)) {
        continue;
      }
      FrameBuffer name;
      writeJsonString(name, alias_store::nameAt((uint8_t)(at - SIGNAL_DEVICE_SLOTS)));
      buildFrame(frame, topic, name.data());
    } else {
      _replay[i] = -1;
      return;
    }
    if (frame.overflowed()) {
      Log.warning(F("SSE replay frame overflow, skipping %s" CR), topic);
      continue;
    }
    if (!socketReadyToWrite(_sse[i])) {
      _replay[i]--; // retry this one next pass rather than losing it
      return;
    }
    sendTo(i, frame);
    sent++;
  }
}
```

and call it from `loop()`, after `_server.handleClient()`:

```cpp
  _server.handleClient();
  for (int i = 0; i < WEB_UI_SSE_CLIENTS; i++) {
    if (_sse[i] && _replay[i] >= 0) {
      drainReplay(i);
    }
  }
```

- [ ] **Step 6: Rewrite the broadcasts**

Replace `broadcast()` and the `broadcastAlias()` stub:

```cpp
static void broadcastFrame(const char* topic, const FrameBuffer& frame) {
  for (int i = 0; i < WEB_UI_SSE_CLIENTS; i++) {
    if (!_sse[i]) {
      continue;
    }
    // A slot still replaying gets this topic from its own cursor, which reads
    // the live table, so sending it now would duplicate it.
    if (_replay[i] >= 0 || !slotWants(i, topic)) {
      continue;
    }
    sendTo(i, frame);
  }
}

void broadcast(const DeviceSlot& slot) {
  FrameBuffer frame;
  buildFrame(frame, slot.key, slot.payload);
  if (frame.overflowed()) {
    Log.warning(F("SSE frame overflow, dropping frame" CR));
    return;
  }
  broadcastFrame(slot.key, frame);
}

void broadcastAlias(const char* topic, const char* name) {
  FrameBuffer quoted;
  writeJsonString(quoted, name);
  FrameBuffer frame;
  buildFrame(frame, topic, quoted.data());
  if (frame.overflowed()) {
    Log.warning(F("SSE alias frame overflow, dropping frame" CR));
    return;
  }
  broadcastFrame(topic, frame);
}
```

In `web_ui.h`, replace the `broadcast` declaration and its comment:

```cpp
void begin();
void loop();
void broadcast(const DeviceSlot& slot);
void broadcastAlias(const char* topic, const char* name);
void writeJsonString(Print& out, const char* s);
```

- [ ] **Step 7: Update the sketch's calls**

In `WebReceiver.ino`, three call sites drop their second argument:

```cpp
      web_ui::broadcast(signal_store::device(0));
```

in `drainSignalQueue()`, in `recordReceiver()` (was `broadcast(..., false)`), and in
`fakeSignalTick()`.

- [ ] **Step 8: Also free the slot state on a reap**

In `reapClosedClients()`, clear the slot's filters and cursor so a reused slot never
inherits them:

```cpp
static void reapClosedClients() {
  for (int i = 0; i < WEB_UI_SSE_CLIENTS; i++) {
    if (_sse[i] && peerClosed(_sse[i])) {
      _sse[i].stop();
      _filterCount[i] = 0;
      _replay[i] = -1;
    }
  }
}
```

- [ ] **Step 9: Verify the firmware builds**

Run:

```bash
pio run -e esp32s3-generic
sed -i "s|^;  '-DFAKE_SIGNALS=true'|  '-DFAKE_SIGNALS=true'|" platformio.ini
pio run -e esp32s3-generic
sed -i "s|^  '-DFAKE_SIGNALS=true'|;  '-DFAKE_SIGNALS=true'|" platformio.ini
git diff --stat platformio.ini
```

Expected: `[SUCCESS]` twice, no diff on `platformio.ini`. Record the RAM and flash
percentages in the commit message body.

- [ ] **Step 10: Commit**

```bash
git add web_ui.h web_ui.cpp WebReceiver.ino
git commit -m "Subscribe with filters and replay retained messages on connect"
```

---

### Task 7: The test harness implements the binding

**Files:**
- Rewrite: `test/harness.js`
- Create: `test/binding.spec.js`
- Modify: `test/fixtures.js` — a `SOURCE` constant, a `topicOf` helper, and `build`
  on `RECEIVER`

**Model:** `sonnet` — the harness is the executable model of the wire shape.

**Interfaces:**
- Consumes: nothing from the firmware tasks; it mirrors them.
- Produces, from `test/harness.js`:
  - `startServer({ devices, source, build })` → `{ url, source, emit, emitAlias,
    get, post, setBuild, close }`
  - `emit(payload, meta)` — stamps `time`, `rssi`, `count`, stores as retained, and
    publishes to matching streams. `meta.rssi`, `meta.count`, `meta.time` override.
  - `emitAlias(deviceTopic, name)` — retains and publishes `<topic>/$alias`
  - `get(topic)` → `{ status, headers, body }`
  - `post(topic, rawBody)` → `{ status, body }`
  - `page()` unchanged
- Produces, from `test/fixtures.js`:
  - `SOURCE` = `"rtl433-test"`, `topicOf(payload)` → `"<SOURCE>/<model>/<id>"`

- [ ] **Step 1: Add the fixture helpers**

In `test/fixtures.js`, add above the exports:

```javascript
const SOURCE = "rtl433-test";

// The same rule as signal_store::buildKey(): id, then channel, then 0.
function topicOf(payload, source) {
  const id = payload.id !== undefined ? payload.id
           : payload.channel !== undefined ? payload.channel : 0;
  return (source || SOURCE) + "/" + payload.model + "/" + id;
}
```

and change `RECEIVER` and the export line:

```javascript
const RECEIVER = {
  model: "Receiver", build: "test", temperature_C: 47.2, radio_C: 31,
  noise_dBm: -104, heap_kB: 177,
};

module.exports = { ACURITE, OREGON, THERMO, LONGNAME, FREEZER, RECEIVER, SOURCE, topicOf };
```

- [ ] **Step 2: Write the failing binding tests**

Create `test/binding.spec.js`:

```javascript
const { test, expect } = require("@playwright/test");
const http = require("http");
const { startServer } = require("./harness");
const { ACURITE, OREGON, SOURCE, topicOf } = require("./fixtures");

let server;

test.afterEach(async () => { if (server) await server.close(); server = null; });

// Collects SSE frames from a raw request, since the tests run in node rather
// than in a page.
function openStream(url, query) {
  return new Promise(resolve => {
    const req = http.get(url.replace(/\/$/, "") + "/events" + (query || ""), res => {
      const frames = [];
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", chunk => {
        buf += chunk;
        let at;
        while ((at = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, at);
          buf = buf.slice(at + 2);
          const line = block.split("\n").find(l => l.startsWith("data: "));
          if (line) frames.push(JSON.parse(line.slice(6)));
        }
      });
      resolve({
        status: res.statusCode,
        frames: frames,
        async settle() { await new Promise(r => setTimeout(r, 150)); return frames; },
        close() { req.destroy(); },
      });
    });
    req.on("error", () => {});
  });
}

test("a topic with no message is 404 and a stored one returns its body", async () => {
  server = await startServer({ devices: [ACURITE] });
  const missing = await server.get(SOURCE + "/Nothing/1");
  expect(missing.status).toBe(404);

  const found = await server.get(topicOf(ACURITE));
  expect(found.status).toBe(200);
  expect(found.headers["content-type"]).toContain("application/json");
  expect(JSON.parse(found.body).model).toBe("Acurite-5n1");
});

test("a posted alias comes back byte for byte", async () => {
  server = await startServer({ devices: [ACURITE] });
  const topic = topicOf(ACURITE) + "/$alias";
  expect((await server.get(topic)).status).toBe(404);

  expect((await server.post(topic, JSON.stringify("Back fence"))).status).toBe(204);
  const got = await server.get(topic);
  expect(got.status).toBe(200);
  expect(got.body).toBe(JSON.stringify("Back fence"));
});

test("a post of a non-JSON body is 400 and leaves the alias alone", async () => {
  server = await startServer({ devices: [ACURITE] });
  const topic = topicOf(ACURITE) + "/$alias";
  await server.post(topic, JSON.stringify("Back fence"));

  expect((await server.post(topic, "not json at all")).status).toBe(400);
  expect((await server.post(topic, JSON.stringify({ name: "x" }))).status).toBe(400);
  expect((await server.get(topic)).body).toBe(JSON.stringify("Back fence"));
});

test("a post to a non-$alias topic is 405", async () => {
  server = await startServer({ devices: [ACURITE] });
  expect((await server.post(topicOf(ACURITE), JSON.stringify("x"))).status).toBe(405);
  expect((await server.post("other-source/M/1/$alias", JSON.stringify("x"))).status).toBe(405);
});

test("a malformed topic is 400", async () => {
  server = await startServer({});
  expect((await server.get("a//c")).status).toBe(400);
  expect((await server.get(SOURCE + "/M/1 2")).status).toBe(400);
});

test("an empty alias body removes the alias", async () => {
  server = await startServer({ devices: [ACURITE] });
  const topic = topicOf(ACURITE) + "/$alias";
  await server.post(topic, JSON.stringify("Back fence"));
  expect((await server.post(topic, JSON.stringify(""))).status).toBe(204);
  expect((await server.get(topic)).status).toBe(404);
});

test("+ matches one segment and # matches the remainder", async () => {
  server = await startServer({ devices: [ACURITE, OREGON] });
  const one = await openStream(server.url, "?f=" + encodeURIComponent(SOURCE + "/+/396"));
  const all = await openStream(server.url, "?f=" + encodeURIComponent(SOURCE + "/#"));
  expect((await one.settle()).map(f => f.topic)).toEqual([topicOf(ACURITE)]);
  expect((await all.settle()).map(f => f.topic).sort())
    .toEqual([topicOf(ACURITE), topicOf(OREGON)].sort());
  one.close();
  all.close();
});

test("a filter matching nothing opens a stream that stays empty", async () => {
  server = await startServer({ devices: [ACURITE] });
  const s = await openStream(server.url, "?f=nobody/%2B/%2B");
  expect(s.status).toBe(200);
  server.emit(OREGON);
  expect(await s.settle()).toEqual([]);
  s.close();
});

test("an invalid filter is 400", async () => {
  server = await startServer({});
  const s = await openStream(server.url, "?f=" + encodeURIComponent("a/#/c"));
  expect(s.status).toBe(400);
  s.close();
});

test("repeated f delivers from every filter and a topic matching both once", async () => {
  server = await startServer({ devices: [] });
  const s = await openStream(server.url,
    "?f=" + encodeURIComponent(SOURCE + "/Acurite-5n1/#") +
    "&f=" + encodeURIComponent(SOURCE + "/+/396") +
    "&f=" + encodeURIComponent(SOURCE + "/Oregon-THN132N/23"));
  server.emit(ACURITE);
  server.emit(OREGON);
  const topics = (await s.settle()).map(f => f.topic);
  expect(topics).toEqual([topicOf(ACURITE), topicOf(OREGON)]);
  s.close();
});

test("a subscriber receives retained messages before any live one", async () => {
  server = await startServer({ devices: [ACURITE] });
  const alias = topicOf(ACURITE) + "/$alias";
  await server.post(alias, JSON.stringify("Back fence"));
  const s = await openStream(server.url);
  server.emit(OREGON);
  const topics = (await s.settle()).map(f => f.topic);
  expect(topics.indexOf(topicOf(OREGON))).toBe(topics.length - 1);
  expect(topics.slice(0, -1).sort()).toEqual([alias, topicOf(ACURITE)].sort());
  s.close();
});

test("$alias round-trips through a # subscription", async () => {
  server = await startServer({ devices: [ACURITE] });
  const s = await openStream(server.url, "?f=%23");
  await s.settle();
  const alias = topicOf(ACURITE) + "/$alias";
  await server.post(alias, JSON.stringify("Back fence"));
  const frames = await s.settle();
  expect(frames[frames.length - 1]).toEqual({ topic: alias, payload: "Back fence" });
  s.close();
});

test("a device with no alias omits the topic rather than returning an empty string", async () => {
  server = await startServer({ devices: [ACURITE] });
  const s = await openStream(server.url);
  const topics = (await s.settle()).map(f => f.topic);
  expect(topics).not.toContain(topicOf(ACURITE) + "/$alias");
  s.close();
});

test("a device payload carries time, rssi and count", async () => {
  server = await startServer({ devices: [ACURITE] });
  const body = JSON.parse((await server.get(topicOf(ACURITE))).body);
  expect(typeof body.time).toBe("string");
  expect(Number.isFinite(Date.parse(body.time))).toBe(true);
  expect(typeof body.rssi).toBe("number");
  expect(body.count).toBe(1);

  server.emit(ACURITE);
  expect(JSON.parse((await server.get(topicOf(ACURITE))).body).count).toBe(2);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx playwright test test/binding.spec.js`
Expected: FAIL, `server.get is not a function`

- [ ] **Step 4: Rewrite the harness**

Replace `test/harness.js` from `function startServer` to the end of the file,
keeping `progmem()` and `page()` as they are:

```javascript
const SOURCE = "rtl433-test";
const ALIAS_SUFFIX = "/$alias";

function validTopic(topic) {
  if (!topic) return false;
  if (/[+#\s]/.test(topic)) return false;
  return topic.split("/").every(s => s.length > 0);
}

function validFilter(filter) {
  if (!filter || /\s/.test(filter)) return false;
  const segments = filter.split("/");
  return segments.every((segment, i) => {
    if (segment.length === 0) return false;
    if (segment === "#") return i === segments.length - 1;
    if (segment === "+") return true;
    return !segment.includes("#") && !segment.includes("+");
  });
}

function matchFilter(filter, topic) {
  const f = filter.split("/");
  const t = topic.split("/");
  for (let i = 0; i < f.length; i++) {
    if (f[i] === "#") return true;
    if (i >= t.length) return false;
    if (f[i] !== "+" && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}

function startServer(opts = {}) {
  const source = opts.source || SOURCE;
  let build = opts.build || "test";
  // topic -> JSON text, exactly what a GET returns and a frame embeds.
  const retained = new Map();
  const counts = new Map();
  const streams = new Set();

  function topicOf(payload) {
    const id = payload.id !== undefined ? payload.id
             : payload.channel !== undefined ? payload.channel : 0;
    return source + "/" + payload.model + "/" + id;
  }

  function publish(topic, json) {
    retained.set(topic, json);
    const frame = "data: {\"topic\":" + JSON.stringify(topic) + ",\"payload\":" + json + "}\n\n";
    for (const s of streams) {
      if (s.filters.some(f => matchFilter(f, topic))) s.res.write(frame);
    }
  }

  function put(payload, meta = {}) {
    const topic = topicOf(payload);
    const count = meta.count !== undefined ? meta.count : (counts.get(topic) || 0) + 1;
    counts.set(topic, count);
    const stamped = Object.assign({}, payload, {
      time: meta.time !== undefined ? meta.time : new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      rssi: meta.rssi !== undefined ? meta.rssi : -72,
      count: count,
    });
    if (stamped.model === "Receiver") stamped.build = meta.build !== undefined ? meta.build : build;
    publish(topic, JSON.stringify(stamped));
    return topic;
  }

  for (const p of opts.devices || []) put(p);

  function readBody(req) {
    return new Promise(resolve => {
      let body = "";
      req.on("data", c => { body += c; });
      req.on("end", () => resolve(body));
    });
  }

  const server = http.createServer(async (req, res) => {
    const [rawPath, query] = req.url.split("?");
    const path = decodeURIComponent(rawPath);
    if (path === "/" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      res.end(page());
      return;
    }
    if (path === "/events" && req.method === "GET") {
      const params = new URLSearchParams(query || "");
      const filters = params.getAll("f");
      if (filters.length > 4 || filters.some(f => f.length >= 65 || !validFilter(f))) {
        res.writeHead(400).end("bad filter");
        return;
      }
      if (filters.length === 0) filters.push("#");
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      });
      res.write("retry: 3000\n\n");
      const entry = { res: res, filters: filters };
      streams.add(entry);
      req.on("close", () => streams.delete(entry));
      for (const [topic, json] of retained) {
        if (filters.some(f => matchFilter(f, topic))) {
          res.write("data: {\"topic\":" + JSON.stringify(topic) + ",\"payload\":" + json + "}\n\n");
        }
      }
      return;
    }
    const topic = path.replace(/^\//, "");
    if (!validTopic(topic)) {
      res.writeHead(400).end("malformed topic");
      return;
    }
    if (req.method === "POST") {
      const isAlias = topic.endsWith(ALIAS_SUFFIX);
      if (!isAlias || !topic.startsWith(source + "/")) {
        res.writeHead(405).end("not allowed");
        return;
      }
      const body = await readBody(req);
      let value;
      try { value = JSON.parse(body); } catch (e) { value = undefined; }
      if (typeof value !== "string") {
        res.writeHead(400).end("body must be a JSON string");
        return;
      }
      if (value === "") retained.delete(topic);
      publish(topic, JSON.stringify(value));
      if (value === "") retained.delete(topic);
      res.writeHead(204).end();
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405).end("not allowed");
      return;
    }
    const json = retained.get(topic);
    if (json === undefined) {
      res.writeHead(404).end("no message");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(json);
  });

  const sockets = new Set();
  server.on("connection", s => { sockets.add(s); s.on("close", () => sockets.delete(s)); });

  function request(method, topic, body) {
    return new Promise(resolve => {
      const req = http.request({
        host: "127.0.0.1", port: server.address().port,
        path: "/" + topic, method: method,
        headers: body === undefined ? {} : { "Content-Type": "application/json" },
      }, res => {
        let out = "";
        res.setEncoding("utf8");
        res.on("data", c => { out += c; });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: out }));
      });
      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  return new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        url: "http://127.0.0.1:" + server.address().port + "/",
        source: source,
        emit(payload, meta) { return put(payload, meta); },
        emitAlias(deviceTopic, name) { publish(deviceTopic + ALIAS_SUFFIX, JSON.stringify(name)); },
        get(topic) { return request("GET", topic); },
        post(topic, body) { return request("POST", topic, body === undefined ? "" : body); },
        setBuild(id) { build = id; },
        close() {
          for (const s of streams) s.res.end();
          // close() waits out every idle keep-alive socket, and the page's
          // EventSource keeps reconnecting into that wait.
          for (const s of sockets) s.destroy();
          return new Promise(done => server.close(done));
        },
      });
    });
  });
}

module.exports = { startServer, page, matchFilter, validFilter, validTopic };
```

- [ ] **Step 5: Fix the double delete**

`publish()` on an empty alias must broadcast the clear but not retain it. Replace
the two `if (value === "") retained.delete(topic);` lines around the `publish` call
with one after it:

```javascript
      publish(topic, JSON.stringify(value));
      if (value === "") retained.delete(topic);
```

- [ ] **Step 6: Run the binding tests to verify they pass**

Run: `npx playwright test test/binding.spec.js`
Expected: all pass. `test/cards.spec.js` fails at this point; Task 8 fixes it.

- [ ] **Step 7: Commit**

```bash
git add test/harness.js test/binding.spec.js test/fixtures.js
git commit -m "Test the binding against a harness that implements it"
```

---

### Task 8: The page reads the stream

**Files:**
- Modify: `index_html.h` — `META`, the globals, `connect()`, the log, the device
  table, deleted `refresh()`
- Modify: `cards_html.h` — `CARDS_KEY`, `SELF_KEY`, `cardLabel`, `pruneCardState`
- Modify: `test/cards.spec.js` — topic keys, the `v2` storage key, the build reload

**Model:** `sonnet` — a page-wide reshape with a large existing test suite.

**Interfaces:**
- Consumes: the harness from Task 7.
- Produces, for Task 9:
  - `aliases`, a `Map` of device topic to published name
  - `isSelf(topic)` — true for `<source>/Receiver/0`
  - `shortKey(topic)` — the topic without its source segment
  - `postAlias(topic, name)` — a stub in this task, implemented in Task 9

- [ ] **Step 1: Rewrite the page's stream handling**

In `index_html.h`, replace the constants and globals:

```javascript
// Everything rtl_433 and the binding add around the actual sensor readings.
const META = new Set(["model", "id", "channel", "protocol", "rssi", "duration",
                      "mic", "message_type", "sequence_num", "time", "count",
                      "build"]);
const LOG_MAX = 200;
const DEVICE_MAX = 24;
const ALIAS_SUFFIX = "/$alias";
const devices = new Map();
const aliases = new Map();
let source = null;
let logRows = [];
let build = null;
```

Delete `let offset = 0;` and `let refreshSeq = 0;`.

Replace `refresh()` and `connect()` in full:

```javascript
function isSelf(topic) { return topic.split("/")[1] === "Receiver"; }

function shortKey(topic) { return topic.split("/").slice(1).join("/"); }

function aliasOf(topic) { return aliases.get(topic) || ""; }

function applyAlias(topic, payload) {
  const key = topic.slice(0, -ALIAS_SUFFIX.length);
  if (typeof payload === "string" && payload !== "") aliases.set(key, payload);
  else aliases.delete(key);
  renderCards();
  renderDevices();
}

function applyMessage(topic, obj) {
  if (!obj || typeof obj !== "object") return;
  if (source === null) source = topic.split("/")[0];
  // A message stamped before the device's clock was set has no time, so it ages
  // from its arrival instead.
  const stamped = obj.time ? Date.parse(obj.time) : NaN;
  const at = Number.isFinite(stamped) ? stamped : Date.now();
  // A reflashed device reboots, the stream reconnects, and its telemetry names
  // the new build: the page it served is the old firmware's, so reload it.
  if (isSelf(topic) && typeof obj.build === "string") {
    if (build === null) build = obj.build;
    else if (obj.build !== build) { location.reload(); return; }
  }
  const raw = JSON.stringify(obj);
  upsert({ key: topic, obj: obj, raw: raw, rssi: obj.rssi, count: obj.count,
           seenAt: at, at: at }, true);
  if (!isSelf(topic)) addLog(at, raw);
}

function connect() {
  const es = new EventSource("/events");
  es.onopen = () => { $("status").textContent = "live"; };
  es.onerror = () => {
    $("status").textContent = "reconnecting";
    // A non-200 (every slot busy) closes the stream for good, so retry by hand.
    if (es.readyState === EventSource.CLOSED) setTimeout(connect, 5000);
  };
  es.onmessage = ev => {
    const msg = parse(ev.data);
    if (!msg || typeof msg.topic !== "string") return;
    if (msg.topic.endsWith(ALIAS_SUFFIX)) applyAlias(msg.topic, msg.payload);
    else applyMessage(msg.topic, msg.payload);
  };
}
```

Replace the bottom of the script:

```javascript
setInterval(() => { renderCards(); renderDevices(); }, 1000);
connect();
```

- [ ] **Step 2: Age and log against the page's own clock**

In `renderLog()`, drop `offset`:

```javascript
    const t = el("td", "nw", new Date(e.at).toLocaleTimeString());
```

In `deviceRow()`, name the row from the topic and read the alias from the stream:

```javascript
function deviceRow(r) {
  const obj = r.obj;
  const name = obj && obj.model ? obj.model : shortKey(r.key);
  const tr = el("tr", r.flashUntil > Date.now() ? "flash" : "");
  tr.dataset.key = r.key;
  const cells = [
    name,
    obj && obj.id !== undefined ? obj.id : (obj && obj.channel !== undefined ? "ch" + obj.channel : ""),
    reading(r),
    r.rssi === undefined ? "" : r.rssi,
    r.count === undefined ? "" : r.count,
    ageText(Date.now() - r.seenAt)
  ];
```

The rest of `deviceRow` is unchanged; `cardAlias`/`setCardAlias` are rewired in
Task 9.

- [ ] **Step 3: Move the cards page onto topics**

In `cards_html.h`:

```javascript
const CARDS_KEY = "rtl433.cards.v2";
```

Delete `const SELF_KEY = "Receiver";` and use `isSelf()` in `ensureCard()`:

```javascript
    if (hideNewCards && !isSelf(key) && cardState.hidden.indexOf(key) < 0) {
```

Replace `cardLabel()`:

```javascript
// The client's own config would win here, but nothing sets a local name: the
// rename posts an alias. So the published alias, then the stable segments.
function cardLabel(key) {
  return aliasOf(key) || shortKey(key);
}
```

Replace the `name` clause in `pruneCardState()`:

```javascript
  const keep = new Set(cardState.order.filter(
    k => devices.has(k) || !cardHidden(k) || aliases.has(k)));
```

Delete the `name` field from `loadCardState()`'s per-card object, since a name is
no longer stored in the browser:

```javascript
    cardState.cards[k] = {
      w: size.w, h: size.h,
      valueOrder: Array.isArray(c.valueOrder) ? c.valueOrder.filter(f => typeof f === "string") : [],
      hiddenValues: Array.isArray(c.hiddenValues) ? c.hiddenValues.filter(f => typeof f === "string") : [],
      bottomValues: Array.isArray(c.bottomValues) ? c.bottomValues.filter(f => typeof f === "string") : [],
    };
```

- [ ] **Step 4: Update the card tests for topics**

In `test/cards.spec.js`:

```javascript
const { ACURITE, OREGON, THERMO, LONGNAME, FREEZER, RECEIVER, SOURCE, topicOf } = require("./fixtures");

const CARD = `.card[data-key="${topicOf(ACURITE)}"]`;
const LONG_KEY = topicOf(LONGNAME);
const LONG_CARD = `.card[data-key="${LONG_KEY}"]`;
```

Replace every `"rtl433.cards.v1"` with `"rtl433.cards.v2"`, every bare
`"Acurite-5n1/396"`-style key with `topicOf(...)`, and
`'.card[data-key="Receiver"]'` with `` `.card[data-key="${topicOf(RECEIVER)}"]` ``.
Where the test asserts the card's visible name, it is now the topic without its
source: `Receiver/0` rather than `Receiver`.

Rewrite the build-reload test, which called the deleted `refresh()`:

```javascript
test("the page reloads when the device reports a different build", async ({ page }) => {
  await open(page, [RECEIVER]);
  await page.evaluate(() => { window.marker = 1; });
  server.emit(RECEIVER);
  await expect(page.locator("#status")).toHaveText("live");
  expect(await page.evaluate(() => window.marker)).toBe(1);

  server.setBuild("other");
  server.emit(RECEIVER);
  await page.waitForFunction(() => window.marker === undefined);
});
```

Where a test asserted the log excludes the receiver, keep it: the page skips
logging any topic whose model segment is `Receiver`.

- [ ] **Step 5: Run the page tests**

Run: `npx playwright test`
Expected: every test in `binding.spec.js` and `cards.spec.js` passes. Fix the card
tests, not the page, unless a failure shows real page behaviour is wrong.

- [ ] **Step 6: Verify the firmware still builds**

Run: `pio run -e esp32s3-generic`
Expected: `[SUCCESS]`

- [ ] **Step 7: Commit**

```bash
git add index_html.h cards_html.h test/cards.spec.js
git commit -m "Build the page's table from the stream alone"
```

---

### Task 9: Aliases on the page

**Files:**
- Modify: `index_html.h` — `postAlias`, the device table's Alias field
- Modify: `cards_html.h` — `renameCard`, `startRename`, the `cardAlias` bindings
- Modify: `test/cards.spec.js` — alias tests through the server

**Model:** `sonnet` — behaviour split across both page files and their tests.

**Interfaces:**
- Consumes: `aliases`, `aliasOf`, `isSelf`, `shortKey` from Task 8;
  `server.get`/`server.post`/`server.emitAlias` from Task 7.
- Produces: nothing later tasks build on.

- [ ] **Step 1: Write the failing tests**

Add to `test/cards.spec.js`:

```javascript
test("a card takes the name published for its topic", async ({ page }) => {
  await open(page, [ACURITE]);
  server.emitAlias(topicOf(ACURITE), "Back fence");
  await expect(page.locator(CARD + " .nm")).toHaveText("Back fence");

  server.emitAlias(topicOf(ACURITE), "");
  await expect(page.locator(CARD + " .nm")).toHaveText(shortKeyOf(ACURITE));
});

test("renaming a card posts an alias", async ({ page }) => {
  await open(page, [ACURITE]);
  await page.click("#edit-cards");
  await page.dblclick(CARD + " .lbl");
  await page.fill(CARD + " .lbl input", "Back fence");
  await page.press(CARD + " .lbl input", "Enter");

  await expect.poll(async () => (await server.get(topicOf(ACURITE) + "/$alias")).body)
    .toBe(JSON.stringify("Back fence"));
});

test("clearing the device table's alias field removes the alias", async ({ page }) => {
  await open(page, [ACURITE]);
  server.emitAlias(topicOf(ACURITE), "Back fence");
  await page.click("#tab-devices");
  const field = page.locator('#devices tr[data-key="' + topicOf(ACURITE) + '"] input[type=text]');
  await expect(field).toHaveValue("Back fence");

  await field.fill("");
  await field.blur();
  await expect.poll(async () => (await server.get(topicOf(ACURITE) + "/$alias")).status)
    .toBe(404);
});
```

and the helper beside the other constants:

```javascript
const shortKeyOf = payload => topicOf(payload).split("/").slice(1).join("/");
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx playwright test test/cards.spec.js -g alias`
Expected: FAIL — the card still shows the topic, and no alias reaches the server.

- [ ] **Step 3: Post the alias from the page**

In `index_html.h`, add beside `applyAlias`:

```javascript
// Applied locally first so the field and the card settle at once; the frame the
// device sends back confirms it.
function postAlias(topic, name) {
  const trimmed = String(name).trim();
  if (trimmed) aliases.set(topic, trimmed); else aliases.delete(topic);
  renderCards();
  renderDevices();
  fetch("/" + topic + ALIAS_SUFFIX, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(trimmed),
  }).catch(() => {});
}
```

- [ ] **Step 4: Wire the two entry points**

In `cards_html.h`, replace the binding block and `renameCard`:

```javascript
cardAlias = key => aliasOf(key);
setCardAlias = renameCard;
```

```javascript
function renameCard(key, name) {
  postAlias(key, name);
}
```

and in `startRename()`, seed the input from the published alias:

```javascript
  input.value = aliasOf(key);
```

`renameCard` no longer touches `cardState`, so its `saveCardState()` call goes.

- [ ] **Step 5: Run the tests**

Run: `npx playwright test`
Expected: all pass.

- [ ] **Step 6: Verify the firmware still builds**

Run: `pio run -e esp32s3-generic`
Expected: `[SUCCESS]`

- [ ] **Step 7: Commit**

```bash
git add index_html.h cards_html.h test/cards.spec.js
git commit -m "Publish card names as aliases instead of storing them per browser"
```

---

### Task 10: Documentation

**Files:**
- Modify: `README.md` — the endpoints section, the limits, the alias and card text
- Create: `docs/user-manual.md`
- Create: `docs/architecture.md`
- Modify: `docs/backlog.md` — delete roadmap item 3 and the two closed gaps
- Delete: `docs/superpowers/specs/2026-08-14-receiver-binding-design.md` and
  `docs/superpowers/plans/2026-08-14-receiver-binding.md`

**Model:** `sonnet` — prose against the house style, spread over four documents.

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Rewrite the README's endpoint section**

Replace the `## Pages and endpoints` table and the four paragraphs under it:

```markdown
## The HTTP surface

The receiver serves the source-only subset of the
[HTTP binding for MQTT](../mqtt-http-bridge/docs/binding.md): stable
`<source>/<model>/<id>` topics, the rtl_433 message as the payload, and an alias
at every level.

| Request | Returns |
|---|---|
| `GET /` | the live page: a card dashboard, a device table, and a raw log, behind tabs; the page opens on Cards |
| `GET /<topic>` | the stored message, `Content-Type: application/json`; `404` if there is none |
| `POST /<topic>` | store an alias, `204`; `405` unless the topic is an `$alias` under this receiver's source |
| `GET /events?f=…` | SSE stream; each frame's `data` is `{"topic":…,"payload":…}`, with a `:keepalive` comment every 15 s |

`source` is the mDNS name, `rtl433-a1b2c3`. The receiver's own telemetry is
`rtl433-a1b2c3/Receiver/0`, and a device with no id and no channel uses `0` too.

Every stored message carries `time` (ISO 8601 UTC, from SNTP), `rssi`, and
`count`, stamped in by the receiver. Until the clock is set `time` is absent and
the page ages that device from when it arrived.

`build` rides on the telemetry message. The page keeps the first id it sees and
reloads itself when a later one differs, so a reflash reboots the device, the
stream reconnects, and every open browser picks up the new page.

See [docs/user-manual.md](docs/user-manual.md) for the routes, their statuses,
and the filter syntax, and [docs/architecture.md](docs/architecture.md) for the
module boundaries and the replay design.
```

Update the `## Limits` list: the event ring is gone, payloads are 600 bytes and
dropped rather than truncated when longer, 32 aliases, four filters per stream.
Update the alias paragraph under the device table: the Alias box now publishes to
`<topic>/$alias` and every viewer sees it. Update the localStorage paragraph in
`## Cards`: `rtl433.cards.v2`, holding layout and value modes but no names.
Update `## Testing without a radio` to mention `bash test/host/run.sh` and that the
harness implements the binding rather than stubbing `/api/state`.

- [ ] **Step 2: Write the user manual**

Create `docs/user-manual.md` covering, with no introduction section:

- Every route, its statuses, and an example request and response for each.
- Topic shape, the `0` id segment, and the source name.
- Filter syntax: `+`, `#`, repeated `f`, four per connection, 64 bytes each, `400`
  on an invalid one, `#` when `f` is omitted.
- The retained replay: what arrives on connect and in what order.
- Aliases: the three levels, a `""` body to remove, `405` for anything else,
  `503` when the table or the 2 KB blob is full, and that they survive a reboot.
- The page's tabs, the device table's columns and controls, the three value modes,
  and card edit mode, moved from the README where it repeats.
- The Log tab starts empty on reload, because the device keeps no history.

- [ ] **Step 3: Write the architecture doc**

Create `docs/architecture.md` covering:

- The module boundaries: `topic` (no Arduino dependency, host-tested, mirrors
  `mqtt-http-bridge/src/topic.js`), `alias_store` (fixed table, one NVS blob, why
  not one key per alias), `signal_store` (slots, `_seq` ordering, eviction, the
  stale sweep, the stamped payload, why an over-long message is dropped rather
  than truncated), `web_ui` (dispatch from `onNotFound`, the SSE slots).
- Data flow: decoder task → queue → `loop()` → `signal_store::record` →
  `web_ui::broadcast` → subscribers.
- The replay design: why it is drained a few frames per `loop()`, why the cursor
  walks raw slot indices, why live frames are suppressed to a replaying slot, and
  what happens to a device updated or evicted mid-replay.
- The name layering: the browser's own layout config, then the published alias,
  then the stable segment.
- The clock: SNTP once WiFi is up, resynced on reconnect, and what an absent
  `time` means.

- [ ] **Step 4: Cut the closed items from the backlog**

In `docs/backlog.md`:

- Delete the `## 3. The binding in the receiver` roadmap section, and reword the
  roadmap's lead so the remaining projects read in order.
- Delete `## Device keys can collide` — keys are 96 bytes and hold a source.
- Delete `## Ages skew for ~49 days after a millis() rollover` — the page ages
  against `time`.
- Delete `## A decode can be missed at page load` — there is no snapshot fetch.
- Update `## Constants duplicated between the firmware and the page`: the fix
  through `/api/state` is gone, so only the build-time generation option remains.
- Update the `Egress to home automation` bullet: polling `/api/state` is no longer
  the cheap first step; a `GET` of a topic is.
- Add one item: an alias surviving a reboot needs hardware and is unverified, like
  the self-test gap already recorded.
- Add one item: `alias_store::selfTest` and the widened `signal_store::selfTest`
  have never been read on a device either.

- [ ] **Step 5: Delete the working documents**

```bash
git rm docs/superpowers/specs/2026-08-14-receiver-binding-design.md
git rm docs/superpowers/plans/2026-08-14-receiver-binding.md
```

- [ ] **Step 6: Verify everything**

Run:

```bash
bash test/host/run.sh
npx playwright test
pio run -e esp32s3-generic
```

Expected: `topic: PASS`, every Playwright test passing, `[SUCCESS]`.

- [ ] **Step 7: Commit**

```bash
git add README.md docs/
git commit -m "Document the binding as the receiver's HTTP surface"
```

---

## Self-review against the spec

Spec coverage, section by section:

- Names — Task 3 (`buildKey`, `SIGNAL_KEY_MAX` 96), Task 4 (`setSource` from
  `mdnsHostname()`).
- Payload, Time — Task 3 (`time`/`rssi`/`count`, `SIGNAL_PAYLOAD_MAX` 600,
  `isoTime`), Task 4 (`configTime`), Task 8 (`META` gains `count`).
- `topic.h`/`topic.cpp` — Task 1.
- `alias_store` — Task 2.
- `signal_store` — Task 3, including the deleted event ring.
- `web_ui` four routes — Task 5 (`/`, `GET`, `POST`), Task 6 (`/events`).
- Operations and statuses — Task 5 and Task 6.
- Retained replay — Task 6.
- The page — Task 8 and Task 9.
- Testing — Task 1 (host), Task 2 and Task 3 (self-tests), Task 7 (`harness.js`,
  `binding.spec.js`), Task 8 and Task 9 (`cards.spec.js`).
- Documentation — Task 10.

Deviations from the spec, both stated in Global Constraints and to be carried into
`docs/architecture.md`: an over-long payload is dropped rather than truncated,
because the frame now embeds it as JSON; and the replay cursor walks raw slot
indices rather than the recency-ordered `device(i)`, so a device heard from
mid-replay is neither skipped nor sent twice.
