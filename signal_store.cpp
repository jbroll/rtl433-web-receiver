#include "signal_store.h"

#include <ArduinoJson.h>
#include <ArduinoLog.h>

namespace signal_store {

static DeviceSlot  _devices[SIGNAL_DEVICE_SLOTS];
static uint32_t    _seq[SIGNAL_DEVICE_SLOTS]; // orders and evicts devices; unlike lastSeen, never rolls over
static uint8_t     _order[SIGNAL_DEVICE_SLOTS];
static uint8_t     _deviceCount = 0;
static uint32_t    _seqCounter = 0;
static SignalEvent _events[SIGNAL_EVENT_SLOTS];
static uint8_t     _eventHead = 0;
static uint8_t     _eventCount = 0;
static uint32_t    _total = 0;
static uint32_t    _dropped = 0;

void reset() {
  memset(_devices, 0, sizeof(_devices));
  memset(_seq, 0, sizeof(_seq));
  memset(_events, 0, sizeof(_events));
  _deviceCount = 0;
  _seqCounter = 0;
  _eventHead = 0;
  _eventCount = 0;
  _total = 0;
  _dropped = 0;
}

static void copyTruncated(char* dest, size_t destSize, const char* src) {
  strncpy(dest, src, destSize - 1);
  dest[destSize - 1] = '\0';
}

static bool buildKey(const JsonDocument& doc, char* key, size_t keySize,
                     char* model, size_t modelSize) {
  const char* m = doc["model"];
  if (m == NULL || m[0] == '\0') {
    return false;
  }
  copyTruncated(model, modelSize, m);
  if (doc["id"].is<const char*>() || doc["id"].is<long>() ||
      doc["id"].is<unsigned long>()) {
    snprintf(key, keySize, "%s/%s", m, doc["id"].as<String>().c_str());
  } else if (!doc["channel"].isNull()) {
    snprintf(key, keySize, "%s/%s", m, doc["channel"].as<String>().c_str());
  } else {
    copyTruncated(key, keySize, m);
  }
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

static void pushEvent(const char* payload, unsigned long at) {
  _eventHead = (_eventHead + 1) % SIGNAL_EVENT_SLOTS;
  copyTruncated(_events[_eventHead].payload, sizeof(_events[_eventHead].payload), payload);
  _events[_eventHead].at = at;
  if (_eventCount < SIGNAL_EVENT_SLOTS) {
    _eventCount++;
  }
}

bool record(const char* payload, int rssi, bool isDecode) {
  JsonDocument doc;
  if (deserializeJson(doc, payload) != DeserializationError::Ok) {
    _dropped++;
    return false;
  }
  char key[SIGNAL_KEY_MAX];
  char model[SIGNAL_MODEL_MAX];
  if (!buildKey(doc, key, sizeof(key), model, sizeof(model))) {
    _dropped++;
    return false;
  }

  unsigned long now = millis();
  int           idx = findSlot(key);
  if (idx < 0) {
    idx = claimSlot();
    copyTruncated(_devices[idx].key, SIGNAL_KEY_MAX, key);
    copyTruncated(_devices[idx].model, SIGNAL_MODEL_MAX, model);
    _devices[idx].used = true;
    _devices[idx].count = 0;
  }
  DeviceSlot& slot = _devices[idx];
  copyTruncated(slot.payload, sizeof(slot.payload), payload);
  slot.rssi = rssi;
  slot.lastSeen = now;
  slot.count++;
  _seq[idx] = ++_seqCounter;

  if (isDecode) {
    pushEvent(payload, now);
    _total++;
  }
  return true;
}

uint8_t deviceCount() {
  return _deviceCount;
}

const DeviceSlot& device(uint8_t i) {
  static DeviceSlot empty;
  uint8_t           n = 0;
  for (int s = 0; s < SIGNAL_DEVICE_SLOTS; s++) {
    if (_devices[s].used) {
      _order[n++] = s;
    }
  }
  for (uint8_t a = 1; a < n; a++) {
    uint8_t v = _order[a];
    int     b = a - 1;
    while (b >= 0 && _seq[_order[b]] < _seq[v]) {
      _order[b + 1] = _order[b];
      b--;
    }
    _order[b + 1] = v;
  }
  if (i >= n) {
    return empty;
  }
  return _devices[_order[i]];
}

uint8_t eventCount() {
  return _eventCount;
}

const SignalEvent& event(uint8_t i) {
  static SignalEvent empty;
  if (i >= _eventCount) {
    return empty;
  }
  int idx = (int)_eventHead - (int)i;
  while (idx < 0) {
    idx += SIGNAL_EVENT_SLOTS;
  }
  return _events[idx];
}

uint32_t totalRecorded() {
  return _total;
}

uint32_t droppedCount() {
  return _dropped;
}

// now is a parameter rather than a millis() call so the self-test can drive
// the clock. Unsigned subtraction makes the comparison rollover-correct as
// long as the sweep runs more often than millis() wraps.
void sweepStale(unsigned long now, unsigned long staleMs) {
  if (staleMs == 0) {
    return;
  }
  for (uint8_t i = 0; i < SIGNAL_DEVICE_SLOTS; i++) {
    if (_devices[i].used && (unsigned long)(now - _devices[i].lastSeen) > staleMs) {
      _devices[i].used = false;
      _seq[i] = 0;
      _deviceCount--;
    }
  }
}

#ifdef FAKE_SIGNALS
static bool check(const char* what, bool ok) {
  Log.notice(F("selfTest %s: %s" CR), what, ok ? "PASS" : "FAIL");
  return ok;
}

bool selfTest() {
  bool ok = true;
  char buf[SIGNAL_PAYLOAD_MAX + 64];

  reset();
  ok &= check("record accepts a decode",
              record("{\"model\":\"Acurite-Tower\",\"id\":1234,\"temperature_C\":21.5}", -70));
  ok &= check("one device after one decode", deviceCount() == 1);
  ok &= check("key is model/id", strcmp(device(0).key, "Acurite-Tower/1234") == 0);

  record("{\"model\":\"Acurite-Tower\",\"id\":1234,\"temperature_C\":21.6}", -71);
  ok &= check("same key updates in place", deviceCount() == 1);
  ok &= check("count increments", device(0).count == 2);

  ok &= check("channel keys when id is absent",
              record("{\"model\":\"Nexus-TH\",\"channel\":2}", -60) &&
                  strcmp(device(0).key, "Nexus-TH/2") == 0);
  ok &= check("model alone keys when id and channel are absent",
              record("{\"model\":\"Generic-Remote\"}", -60) &&
                  strcmp(device(0).key, "Generic-Remote") == 0);

  reset();
  for (int i = 0; i < SIGNAL_DEVICE_SLOTS + 6; i++) {
    snprintf(buf, sizeof(buf), "{\"model\":\"Dev\",\"id\":%d}", i);
    record(buf, -70);
    delay(2);
  }
  ok &= check("table caps at SIGNAL_DEVICE_SLOTS", deviceCount() == SIGNAL_DEVICE_SLOTS);
  ok &= check("newest survives eviction", strcmp(device(0).key, "Dev/29") == 0);
  ok &= check("oldest was evicted", strcmp(device(SIGNAL_DEVICE_SLOTS - 1).key, "Dev/6") == 0);

  reset();
  for (int i = 0; i < SIGNAL_EVENT_SLOTS + 5; i++) {
    snprintf(buf, sizeof(buf), "{\"model\":\"Dev\",\"id\":%d}", i);
    record(buf, -70);
  }
  ok &= check("ring caps at SIGNAL_EVENT_SLOTS", eventCount() == SIGNAL_EVENT_SLOTS);
  ok &= check("event 0 is newest",
              strstr(event(0).payload, "\"id\":44") != NULL);

  reset();
  ok &= check("unparseable payload is dropped", !record("not json at all", -70));
  ok &= check("payload without model is dropped", !record("{\"id\":7}", -70));
  ok &= check("dropped counter advances", droppedCount() == 2);
  ok &= check("dropped payloads leave no device", deviceCount() == 0);

  reset();
  record("{\"model\":\"Real\",\"id\":1}", -70);
  record("{\"model\":\"Receiver\",\"temperature_C\":40}", -50, false);
  ok &= check("telemetry takes a device slot", deviceCount() == 2);
  ok &= check("telemetry stays out of the event ring", eventCount() == 1);
  ok &= check("telemetry is not counted as a decode", totalRecorded() == 1);

  reset();
  char note[SIGNAL_PAYLOAD_MAX]; // valid JSON, but longer than a slot holds
  memset(note, 'A', sizeof(note) - 1);
  note[sizeof(note) - 1] = '\0';
  snprintf(buf, sizeof(buf), "{\"model\":\"Long\",\"id\":1,\"note\":\"%s\"}", note);
  ok &= check("long payload is kept and truncated",
              record(buf, -70) && strlen(device(0).payload) == SIGNAL_PAYLOAD_MAX);

  reset();
  record("{\"model\":\"Stale\",\"id\":1,\"temperature_C\":1}", -50);
  record("{\"model\":\"Fresh\",\"id\":2,\"temperature_C\":2}", -50);
  ok &= check("both devices present before sweep", deviceCount() == 2);

  // Both slots share a lastSeen from this run's millis(), so age them by
  // sweeping from a point far enough ahead that only a longer window spares
  // them; a zero window must spare both.
  unsigned long base = _devices[0].lastSeen;
  sweepStale(base + 1000, 0);
  ok &= check("a zero window sweeps nothing", deviceCount() == 2);
  sweepStale(base + 1000, 60000);
  ok &= check("a fresh device survives the sweep", deviceCount() == 2);
  sweepStale(base + 120000, 60000);
  ok &= check("a stale device is swept", deviceCount() == 0);

  // A lastSeen set 100ms before millis() wraps, swept from a now that has
  // already wrapped past zero: numerically now < lastSeen, but
  // (unsigned long)(now - lastSeen) still yields the true elapsed time.
  reset();
  record("{\"model\":\"Wrap\",\"id\":3,\"temperature_C\":3}", -50);
  unsigned long nearWrap = (unsigned long)-1 - 100;
  _devices[0].lastSeen = nearWrap;
  sweepStale(nearWrap + 151, 60000); // wraps to 50; 151ms elapsed, inside the window
  ok &= check("a device inside the window survives a millis rollover",
              deviceCount() == 1);
  sweepStale(nearWrap + 70000, 60000); // wraps to 69899; 70000ms elapsed, past the window
  ok &= check("a device past the window is swept across a millis rollover",
              deviceCount() == 0);

  Log.notice(F("selfTest overall: %s" CR), ok ? "PASS" : "FAIL");
  return ok;
}
#endif

} // namespace signal_store
