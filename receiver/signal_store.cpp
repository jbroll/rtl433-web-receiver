#include "signal_store.h"

#include <ArduinoJson.h>
#include <ArduinoLog.h>
#include <time.h>

namespace signal_store {

static DeviceSlot _devices[SIGNAL_DEVICE_SLOTS];
static uint32_t   _seq[SIGNAL_DEVICE_SLOTS]; // orders and evicts devices; unlike lastSeen, never rolls over
static uint8_t    _order[SIGNAL_DEVICE_SLOTS];
static uint8_t    _deviceCount = 0;
static uint32_t   _seqCounter = 0;
static uint32_t   _total = 0;
static uint32_t   _dropped = 0;
static char       _source[SIGNAL_SOURCE_MAX] = "rtl433";
static DeviceSub  _subs[SIGNAL_SUB_TABLE];

void reset() {
  memset(_devices, 0, sizeof(_devices));
  memset(_seq, 0, sizeof(_seq));
  memset(_subs, 0, sizeof(_subs));
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
  // Free the evicted slot's subs so its payloads do not replay under the
  // reused slot's key until the hour sweep.
  for (int i = 0; i < SIGNAL_SUB_TABLE; i++) {
    if (_subs[i].used && _subs[i].slotIdx == (uint8_t)oldest) {
      _subs[i].used = false;
    }
  }
  memset(&_devices[oldest], 0, sizeof(DeviceSlot));
  return oldest;
}

static int findSub(int slotIdx, const char* msgType) {
  for (int i = 0; i < SIGNAL_SUB_TABLE; i++) {
    if (_subs[i].used && _subs[i].slotIdx == (uint8_t)slotIdx &&
        strcmp(_subs[i].msgType, msgType) == 0) {
      return i;
    }
  }
  return -1;
}

static int claimSub(int slotIdx, const char* msgType) {
  for (int i = 0; i < SIGNAL_SUB_TABLE; i++) {
    if (!_subs[i].used) {
      _subs[i].used = true;
      _subs[i].slotIdx = slotIdx;
      copyTruncated(_subs[i].msgType, sizeof(_subs[i].msgType), msgType);
      return i;
    }
  }
  // Table full: evict this device's lowest-seq sub if it has more than one.
  int deviceSubs[SIGNAL_SUB_TABLE];
  int n = 0;
  for (int i = 0; i < SIGNAL_SUB_TABLE; i++) {
    if (_subs[i].used && _subs[i].slotIdx == (uint8_t)slotIdx) {
      deviceSubs[n++] = i;
    }
  }
  if (n <= 1) return -1;  // preserve the device's existing type
  int oldest = deviceSubs[0];
  for (int i = 1; i < n; i++) {
    if (_subs[deviceSubs[i]].seq < _subs[oldest].seq) oldest = deviceSubs[i];
  }
  copyTruncated(_subs[oldest].msgType, sizeof(_subs[oldest].msgType), msgType);
  _subs[oldest].lastSeen = 0;
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

  char msgType[16] = "";
  if (!doc["message_type"].isNull()) {
    copyTruncated(msgType, sizeof(msgType), doc["message_type"].as<String>().c_str());
  }

  int subIdx = findSub(idx, msgType);
  if (subIdx < 0) {
    subIdx = claimSub(idx, msgType);
    if (subIdx < 0) {
      _dropped++;
      return false;
    }
  }

  DeviceSub& sub = _subs[subIdx];
  serializeJson(doc, sub.payload, sizeof(sub.payload));
  sub.lastSeen = millis();
  slot.lastSeen = sub.lastSeen;
  sub.seq = _seq[idx] = ++_seqCounter;
  slot.count = count;

  if (isDecode) {
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

const DeviceSlot* slotAt(uint8_t i) {
  if (i >= SIGNAL_DEVICE_SLOTS || !_devices[i].used) {
    return NULL;
  }
  return &_devices[i];
}

int indexOf(const DeviceSlot& slot) {
  if (&slot < &_devices[0] || &slot > &_devices[SIGNAL_DEVICE_SLOTS - 1]) {
    return -1;
  }
  return (int)(&slot - &_devices[0]);
}

const char* latestPayload(const DeviceSlot& slot) {
  int idx = indexOf(slot);
  if (idx < 0) return nullptr;
  int latest = -1;
  for (int i = 0; i < SIGNAL_SUB_TABLE; i++) {
    if (_subs[i].used && _subs[i].slotIdx == (uint8_t)idx) {
      if (latest < 0 || _subs[i].seq > _subs[latest].seq) latest = i;
    }
  }
  return latest < 0 ? nullptr : _subs[latest].payload;
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
