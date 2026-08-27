#include "signal_store.h"

#include <ArduinoJson.h>
#include <ArduinoLog.h>
#include <time.h>

#include "device_hooks.h"
#include "selftest_check.h"
#include "str_util.h"

namespace signal_store {

#define SIGNAL_PENDING_SLOTS 8
// JSON_MSG_BUFFER is 512 and SIGNAL_PAYLOAD_MAX is 600: the module's own
// input bound already reaches ~600 bytes before record() adds time, rssi and
// count. 2 KB measured short of that — a single 500-byte string field parsed
// but 540 bytes returned NoMemory — so messages the store used to accept
// were being silently dropped. 4 KB was measured, the same way, to parse a
// SIGNAL_PAYLOAD_MAX payload shaped as one string field filling the payload,
// with room for ArduinoJson's own bookkeeping (per platformio.ini's
// ARDUINOJSON_POOL_CAPACITY=16 chunking). Other shapes under the same cap
// cost more per byte; see docs/backlog.md.
#define SIGNAL_JSON_POOL_BYTES 4096

// The arena's alignment constant must cover ArduinoJson's slot union
// (a uint64_t/double, alignof 8) on every build target, not just the host
// selfTest() below exercises. See "RecordAllocator arena alignment" in
// docs/architecture.md.
static_assert(alignof(max_align_t) >= alignof(uint64_t),
              "arena block alignment must be at least alignof(uint64_t)");

// A fixed arena for the parser: bump-allocates from a static buffer instead
// of malloc/realloc, and is reset once per record() call rather than freed,
// since the doc never outlives the function. A size_t header in front of
// each block lets reallocate() grow by copying into a fresh block; the
// common case, ArduinoJson shrinking a string to its final length, reuses
// the block in place. Returns null on exhaustion so ArduinoJson reports the
// parse as out of memory instead of falling back to the heap.
class RecordAllocator : public ArduinoJson::Allocator {
 public:
  void* allocate(size_t size) override {
    return alloc(size);
  }
  void deallocate(void*) override {}
  void* reallocate(void* ptr, size_t newSize) override {
    if (ptr == nullptr) {
      return alloc(newSize);
    }
    size_t oldSize = reinterpret_cast<size_t*>(ptr)[-1];
    if (newSize <= oldSize) {
      return ptr;
    }
    // The old block isn't reclaimed here; only the next record()'s reset()
    // gets it back. Harmless given the current per-record reset pattern.
    void* fresh = alloc(newSize);
    if (fresh != nullptr) {
      memcpy(fresh, ptr, oldSize);
    }
    return fresh;
  }
  void reset() { _used = 0; }

 private:
  // Header size is alignof(max_align_t), not sizeof(size_t) rounded to
  // sizeof(void*); see "RecordAllocator arena alignment" in
  // docs/architecture.md for why.
  void* alloc(size_t size) {
    constexpr size_t kAlign = alignof(max_align_t);
    size_t need = kAlign + size;
    need = (need + kAlign - 1) & ~(kAlign - 1);
    if (need > sizeof(_buf) - _used) {
      return nullptr;
    }
    uint8_t* block = _buf + _used;
    void* payload = block + kAlign;
    reinterpret_cast<size_t*>(payload)[-1] = size;
    _used += need;
    return payload;
  }

  alignas(max_align_t) uint8_t _buf[SIGNAL_JSON_POOL_BYTES];
  size_t _used = 0;
};

static RecordAllocator _jsonPool;

struct PendingKey {
  char     key[SIGNAL_KEY_MAX];
  uint32_t seq;
  bool     used;
};

static PendingKey _pending[SIGNAL_PENDING_SLOTS];

static DeviceSlot _devices[SIGNAL_DEVICE_SLOTS];
static uint32_t   _seq[SIGNAL_DEVICE_SLOTS]; // orders and evicts devices; unlike lastSeen, never rolls over
static uint8_t    _order[SIGNAL_DEVICE_SLOTS];
static uint8_t    _deviceCount = 0;
static uint32_t   _seqCounter = 0;
static uint32_t   _total = 0;
static uint32_t   _dropped = 0;
static char       _source[SIGNAL_SOURCE_MAX] = "rtl433";
static DeviceSub  _subs[SIGNAL_SUB_TABLE];
static RecordHook _hooks[SIGNAL_MAX_HOOKS];
static uint8_t    _hookCount = 0;
static int        _lastRecordedIdx = -1;
#ifdef FAKE_SIGNALS
// Test-only counters distinguishing which rejection fired: a parse that
// exhausted the fixed arena never gets here, so a case reaching measureJson's
// size check advances _parseOkForTest first. Not compiled into the firmware.
static uint32_t _parseOkForTest = 0;
static uint32_t _sizeRejectForTest = 0;
#endif

void reset() {
  memset(_devices, 0, sizeof(_devices));
  memset(_seq, 0, sizeof(_seq));
  memset(_subs, 0, sizeof(_subs));
  memset(_pending, 0, sizeof(_pending));
  _deviceCount = 0;
  _seqCounter = 0;
  _total = 0;
  _dropped = 0;
  _lastRecordedIdx = -1;
}

void setSource(const char* source) {
  if (source != NULL && source[0] != '\0') {
    copyTruncated(_source, sizeof(_source), source);
  }
}

const char* source() {
  return _source;
}

void addRecordHook(RecordHook hook) {
  if (_hookCount < SIGNAL_MAX_HOOKS) {
    _hooks[_hookCount++] = hook;
  }
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
  if (doc["id"].is<const char*>()) {
    const char* idStr = doc["id"].as<const char*>();
    if (strlen(idStr) >= sizeof(id)) {
      return false;
    }
    copyTruncated(id, sizeof(id), idStr);
  } else if (doc["id"].is<long>()) {
    int n = snprintf(id, sizeof(id), "%ld", doc["id"].as<long>());
    if (n < 0 || (size_t)n >= sizeof(id)) {
      return false;
    }
  } else if (doc["id"].is<unsigned long>()) {
    String idStr = doc["id"].as<String>();
    if (idStr.length() >= sizeof(id)) {
      return false;
    }
    copyTruncated(id, sizeof(id), idStr.c_str());
  } else if (doc["channel"].is<const char*>()) {
    copyTruncated(id, sizeof(id), doc["channel"].as<const char*>());
  } else if (doc["channel"].is<long>()) {
    snprintf(id, sizeof(id), "%ld", doc["channel"].as<long>());
  } else if (!doc["channel"].isNull()) {
    copyTruncated(id, sizeof(id), doc["channel"].as<String>().c_str());
  } else {
    // The binding requires an id segment; a device with one instance uses 0.
    strcpy(id, "0");
  }
  sanitizeSegment(id);

  int n = snprintf(key, keySize, "%s/%s/%s", _source, model, id);
  return n >= 0 && (size_t)n < keySize;
}

static int findSlot(const char* key) {
  for (int i = 0; i < SIGNAL_DEVICE_SLOTS; i++) {
    if (_devices[i].used && strcmp(_devices[i].key, key) == 0) {
      return i;
    }
  }
  return -1;
}

// A freed slot must not keep subs: their payloads would replay under the
// reused slot's key until the hour sweep.
static void freeSlotSubs(int slotIdx) {
  for (int i = 0; i < SIGNAL_SUB_TABLE; i++) {
    if (_subs[i].used && _subs[i].slotIdx == (uint8_t)slotIdx) {
      _subs[i].used = false;
    }
  }
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
  freeSlotSubs(oldest);
  memset(&_devices[oldest], 0, sizeof(DeviceSlot));
  return oldest;
}

static int findPending(const char* key) {
  for (int i = 0; i < SIGNAL_PENDING_SLOTS; i++) {
    if (_pending[i].used && strcmp(_pending[i].key, key) == 0) {
      return i;
    }
  }
  return -1;
}

static int claimPending() {
  for (int i = 0; i < SIGNAL_PENDING_SLOTS; i++) {
    if (!_pending[i].used) return i;
  }
  int oldest = 0;
  for (int i = 1; i < SIGNAL_PENDING_SLOTS; i++) {
    if (_pending[i].seq < _pending[oldest].seq) oldest = i;
  }
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
  _lastRecordedIdx = -1;
  _jsonPool.reset();
  JsonDocument doc(&_jsonPool);
  if (deserializeJson(doc, payload) != DeserializationError::Ok) {
    _dropped++;
    return false;
  }
#ifdef FAKE_SIGNALS
  _parseOkForTest++;
#endif
  char key[SIGNAL_KEY_MAX];
  if (!buildKey(doc, key, sizeof(key))) {
    _dropped++;
    return false;
  }
  if (!device_hooks::validate(doc)) {
    _dropped++;
    return false;
  }

  int idx = findSlot(key);
  if (isDecode && idx < 0) {
    int p = findPending(key);
    if (p < 0) {
      p = claimPending();
      copyTruncated(_pending[p].key, SIGNAL_KEY_MAX, key);
      _pending[p].seq = ++_seqCounter;
      _pending[p].used = true;
      return false;
    }
    _pending[p].used = false;
  }
  uint32_t count = (idx < 0 ? 0 : _devices[idx].count) + 1;

  char stamp[24];
  if (isoTime(stamp, sizeof(stamp))) {
    doc["time"] = stamp;
  }
  doc["rssi"] = rssi;
  doc["count"] = count;

  // The frame embeds the payload as JSON rather than as an escaped string, so a
  // truncated one would be unparseable on the wire. Drop it instead, before any
  // hook runs, so a message the store refuses is never published either.
  if (measureJson(doc) > SIGNAL_PAYLOAD_MAX) {
    _dropped++;
#ifdef FAKE_SIGNALS
    _sizeRejectForTest++;
#endif
    return false;
  }

  bool newSlot = idx < 0;
  if (newSlot) {
    idx = claimSlot();
    copyTruncated(_devices[idx].key, SIGNAL_KEY_MAX, key);
    _devices[idx].used = true;
  }
  DeviceSlot& slot = _devices[idx];

  char msgType[16] = "";
  if (doc["message_type"].is<const char*>()) {
    copyTruncated(msgType, sizeof(msgType), doc["message_type"].as<const char*>());
  } else if (doc["message_type"].is<long>()) {
    snprintf(msgType, sizeof(msgType), "%ld", doc["message_type"].as<long>());
  } else if (!doc["message_type"].isNull()) {
    copyTruncated(msgType, sizeof(msgType), doc["message_type"].as<String>().c_str());
  }

  // Resolved before any hook runs, so a record that will be dropped for want
  // of a sub slot never reaches a hook.
  int subIdx = findSub(idx, msgType);
  if (subIdx < 0) {
    subIdx = claimSub(idx, msgType);
    if (subIdx < 0) {
      // The sub table was full and this slot has no sub of its own to evict;
      // undo the claim above rather than leave a slot with no payload.
      if (newSlot) {
        _devices[idx].used = false;
        _deviceCount--;
        _seq[idx] = 0;
      }
      _dropped++;
      return false;
    }
  }

  for (uint8_t h = 0; h < _hookCount; h++) {
    _hooks[h](key, doc);
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
  _lastRecordedIdx = idx;
  return true;
}

uint8_t deviceCount() {
  return _deviceCount;
}

// The slot the most recent successful record() touched, which is always the
// slot device(0) would resolve to (it holds the highest _seq by
// construction). Null after a failed record(), so a caller that forgets to
// check the return value broadcasts nothing rather than a stale slot.
const DeviceSlot* lastRecorded() {
  if (_lastRecordedIdx < 0) {
    return NULL;
  }
  return &_devices[_lastRecordedIdx];
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

const DeviceSub* subAt(uint8_t i) {
  if (i >= SIGNAL_SUB_TABLE || !_subs[i].used) return NULL;
  return &_subs[i];
}

int latestSubIndex(const DeviceSlot& slot) {
  int idx = indexOf(slot);
  if (idx < 0) return -1;
  int latest = -1;
  for (int i = 0; i < SIGNAL_SUB_TABLE; i++) {
    if (_subs[i].used && _subs[i].slotIdx == (uint8_t)idx) {
      if (latest < 0 || _subs[i].seq > _subs[latest].seq) latest = i;
    }
  }
  return latest;
}

const char* subPayload(int subIdx) {
  if (subIdx < 0 || subIdx >= SIGNAL_SUB_TABLE || !_subs[subIdx].used) return NULL;
  return _subs[subIdx].payload;
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
      freeSlotSubs(i);
      _devices[i].used = false;
      _seq[i] = 0;
      _deviceCount--;
      // A lastRecorded() call after this sweep must not resolve to a slot
      // the sweep just reclaimed.
      if (_lastRecordedIdx == (int)i) {
        _lastRecordedIdx = -1;
      }
    }
  }
  sweepSubStale(now, SUB_STALE_MS);
}

// Reclaims a splitter's stale secondary message types; it never frees a
// device slot itself. sweepStale()'s device window and claimSlot()'s
// capacity eviction are what end a slot's life.
void sweepSubStale(unsigned long now, unsigned long staleMs) {
  if (staleMs == 0) return;
  int newest[SIGNAL_DEVICE_SLOTS];
  for (uint8_t s = 0; s < SIGNAL_DEVICE_SLOTS; s++) newest[s] = -1;
  for (uint8_t i = 0; i < SIGNAL_SUB_TABLE; i++) {
    if (!_subs[i].used || _subs[i].slotIdx >= SIGNAL_DEVICE_SLOTS) continue;
    uint8_t slotIdx = _subs[i].slotIdx;
    if (newest[slotIdx] < 0 || _subs[i].seq > _subs[newest[slotIdx]].seq) {
      newest[slotIdx] = i;
    }
  }
  for (uint8_t i = 0; i < SIGNAL_SUB_TABLE; i++) {
    if (!_subs[i].used) continue;
    if ((unsigned long)(now - _subs[i].lastSeen) <= staleMs) continue;
    uint8_t slotIdx = _subs[i].slotIdx;
    if (slotIdx < SIGNAL_DEVICE_SLOTS && newest[slotIdx] == i) continue;
    _subs[i].used = false;
    _subs[i].slotIdx = 0xFF;
    _subs[i].seq = 0;
  }
}

#ifdef FAKE_SIGNALS
uint32_t testParseOkCount() {
  return _parseOkForTest;
}

uint32_t testSizeRejectCount() {
  return _sizeRejectForTest;
}

#define check(what, ok) selfTestCheck("signal_store", what, ok)

bool selfTest() {
  bool ok = true;
  char buf[SIGNAL_PAYLOAD_MAX + 64];

  {
    // Host regression standing in for the target's alignment bug; see
    // "RecordAllocator arena alignment" in docs/architecture.md.
    RecordAllocator allocator;
    bool             allAligned = true;
    for (size_t n = 1; n <= 64 && allAligned; n++) {
      void* p = allocator.allocate(n);
      if (p == nullptr) break;
      if (reinterpret_cast<uintptr_t>(p) % alignof(max_align_t) != 0) {
        allAligned = false;
      }
    }
    ok &= check("arena payloads stay alignof(max_align_t)-aligned across varying allocation sizes",
                allAligned);
  }

  setSource("rtl433-a1b2c3");
  reset();
  ok &= check("first sighting of a new key is pending, not a device",
              !record("{\"model\":\"Acurite-Tower\",\"id\":1234,\"temperature_C\":21.5}", -70));
  ok &= check("no device after a first sighting", deviceCount() == 0);
  ok &= check("a pending sighting is not a drop", droppedCount() == 0);
  ok &= check("record accepts a decode on the second sighting",
              record("{\"model\":\"Acurite-Tower\",\"id\":1234,\"temperature_C\":21.5}", -70));
  ok &= check("one device after the second sighting", deviceCount() == 1);
  ok &= check("lastRecorded matches device(0) after a first record",
              lastRecorded() == &device(0));
  ok &= check("key is source/model/id",
              strcmp(device(0).key, "rtl433-a1b2c3/Acurite-Tower/1234") == 0);
  ok &= check("rssi is stamped into the payload",
              strstr(latestPayload(device(0)), "\"rssi\":-70") != NULL);
  ok &= check("count is stamped into the payload",
              strstr(latestPayload(device(0)), "\"count\":1") != NULL);

  record("{\"model\":\"Acurite-Tower\",\"id\":1234,\"temperature_C\":21.6}", -71);
  ok &= check("same key updates in place", deviceCount() == 1);
  ok &= check("lastRecorded matches device(0) after a repeat record",
              lastRecorded() == &device(0));
  ok &= check("count increments", device(0).count == 2);
  ok &= check("the stamped count follows",
              strstr(latestPayload(device(0)), "\"count\":2") != NULL);

  record("{\"model\":\"Acurite-Tower\",\"id\":1234,\"temperature_C\":21.7}", -73);
  ok &= check("a third sighting behaves as an ordinary repeat",
              deviceCount() == 1 && device(0).count == 3);

  ok &= check("channel is the id segment when id is absent",
              !record("{\"model\":\"Nexus-TH\",\"channel\":2}", -60) &&
                  record("{\"model\":\"Nexus-TH\",\"channel\":2}", -60) &&
                  strcmp(device(0).key, "rtl433-a1b2c3/Nexus-TH/2") == 0);
  ok &= check("the id segment is 0 when id and channel are absent",
              !record("{\"model\":\"Generic-Remote\"}", -60) &&
                  record("{\"model\":\"Generic-Remote\"}", -60) &&
                  strcmp(device(0).key, "rtl433-a1b2c3/Generic-Remote/0") == 0);
  ok &= check("a slash in a model name is replaced",
              !record("{\"model\":\"Odd/Name\",\"id\":1}", -60) &&
                  record("{\"model\":\"Odd/Name\",\"id\":1}", -60) &&
                  strcmp(device(0).key, "rtl433-a1b2c3/Odd-Name/1") == 0);

  reset();
  for (int i = 0; i < SIGNAL_DEVICE_SLOTS + 6; i++) {
    snprintf(buf, sizeof(buf), "{\"model\":\"Dev\",\"id\":%d}", i);
    record(buf, -70);  // first sighting: pending
    record(buf, -70);  // second sighting: promotes to a device
    delay(2);
  }
  ok &= check("table caps at SIGNAL_DEVICE_SLOTS", deviceCount() == SIGNAL_DEVICE_SLOTS);
  ok &= check("newest survives eviction",
              strcmp(device(0).key, "rtl433-a1b2c3/Dev/29") == 0);
  ok &= check("oldest was evicted",
              strcmp(device(SIGNAL_DEVICE_SLOTS - 1).key, "rtl433-a1b2c3/Dev/6") == 0);
  ok &= check("lastRecorded matches device(0) after an evicting record",
              lastRecorded() == &device(0));

  reset();
  ok &= check("an integer id and a string id build the same key",
              !record("{\"model\":\"Dev\",\"id\":42}", -70) &&
                  record("{\"model\":\"Dev\",\"id\":42}", -70) &&
                  strcmp(device(0).key, "rtl433-a1b2c3/Dev/42") == 0);
  reset();
  ok &= check("a string id builds the same key an integer id would",
              !record("{\"model\":\"Dev\",\"id\":\"42\"}", -70) &&
                  record("{\"model\":\"Dev\",\"id\":\"42\"}", -70) &&
                  strcmp(device(0).key, "rtl433-a1b2c3/Dev/42") == 0);

  reset();
  record("{\"model\":\"Dev\",\"id\":1}", -70);
  record("{\"model\":\"Dev\",\"id\":1}", -70);
  ok &= check("slotAt finds a used slot", slotAt(0) != NULL);
  ok &= check("slotAt reports an unused slot",
              slotAt(SIGNAL_DEVICE_SLOTS - 1) == NULL);
  ok &= check("slotAt bounds its index", slotAt(SIGNAL_DEVICE_SLOTS) == NULL);

  reset();
  ok &= check("unparseable payload is dropped", !record("not json at all", -70));
  ok &= check("lastRecorded is null after a failed record", lastRecorded() == NULL);
  ok &= check("payload without model is dropped", !record("{\"id\":7}", -70));
  ok &= check("a field outside its valid range is dropped",
              !record("{\"model\":\"Dev\",\"id\":1,\"humidity\":154}", -70));
  ok &= check("dropped counter advances", droppedCount() == 3);
  ok &= check("dropped payloads leave no device", deviceCount() == 0);

  reset();
  {
    char longSource[SIGNAL_SOURCE_MAX];
    memset(longSource, 's', sizeof(longSource) - 1);
    longSource[sizeof(longSource) - 1] = '\0';
    char longModel[SIGNAL_MODEL_MAX];
    memset(longModel, 'm', sizeof(longModel) - 1);
    longModel[sizeof(longModel) - 1] = '\0';
    setSource(longSource);
    snprintf(buf, sizeof(buf), "{\"model\":\"%s\",\"id\":123456789012}", longModel);
    record(buf, -70);
    ok &= check("a key that would not fit is rejected, not truncated",
                !record(buf, -70) && deviceCount() == 0);
    setSource("rtl433-a1b2c3");
  }

  reset();
  char note[SIGNAL_PAYLOAD_MAX]; // valid JSON, but longer than a slot holds
  memset(note, 'A', sizeof(note) - 1);
  note[sizeof(note) - 1] = '\0';
  snprintf(buf, sizeof(buf), "{\"model\":\"Long\",\"id\":1,\"note\":\"%s\"}", note);
  record(buf, -70);  // first sighting: held pending, not yet size-checked
  {
    uint32_t parseOkBefore = testParseOkCount();
    uint32_t sizeRejectBefore = testSizeRejectCount();
    ok &= check("an over-long payload is dropped rather than truncated",
                !record(buf, -70) && deviceCount() == 0);
    // With SIGNAL_JSON_POOL_BYTES at 2048 this payload's ~599-byte string
    // exhausted the arena before deserializeJson finished, so the size check
    // below was never reached; the assertion above still passed, but for the
    // wrong reason. Confirms the raised arena lets it reach measureJson and
    // get rejected there, on size, rather than failing the parse outright.
    ok &= check("the over-long payload reaches measureJson and is rejected for size, not a parse failure",
                testParseOkCount() == parseOkBefore + 1 &&
                    testSizeRejectCount() == sizeRejectBefore + 1);
  }

  reset();
  {
    // Calibrate a note length that lands the post-stamp payload right at
    // SIGNAL_PAYLOAD_MAX, the ceiling record()'s own size check enforces —
    // measured the same way the reviewer measured the 2 KB arena's ceiling,
    // but against the module's own bound rather than the arena's.
    char   calNote[SIGNAL_PAYLOAD_MAX];
    int    bestLen = 0;
    for (int n = 1; n < SIGNAL_PAYLOAD_MAX; n++) {
      memset(calNote, 'A', n);
      calNote[n] = '\0';
      JsonDocument calib;
      calib["model"] = "Limit";
      calib["id"] = 1;
      calib["note"] = calNote;
      char calStamp[24];
      if (isoTime(calStamp, sizeof(calStamp))) {
        calib["time"] = calStamp;
      }
      calib["rssi"] = -70;
      calib["count"] = 1;
      size_t measured = measureJson(calib);
      if (measured > SIGNAL_PAYLOAD_MAX) break;
      bestLen = n;
      if (measured == SIGNAL_PAYLOAD_MAX) break;
    }
    memset(calNote, 'A', bestLen);
    calNote[bestLen] = '\0';
    snprintf(buf, sizeof(buf), "{\"model\":\"Limit\",\"id\":1,\"note\":\"%s\"}", calNote);
    record(buf, -70);  // pending
    uint32_t parseOkBefore = testParseOkCount();
    bool     accepted = record(buf, -70);
    ok &= check("a message at SIGNAL_PAYLOAD_MAX parses in the raised arena and is accepted",
                accepted && deviceCount() == 1 &&
                    testParseOkCount() == parseOkBefore + 1);
  }

  reset();
  record("{\"model\":\"Acurite-5n1\",\"id\":396,\"message_type\":0,\"wind_avg_mi_h\":4.6}", -70);  // pending
  record("{\"model\":\"Acurite-5n1\",\"id\":396,\"message_type\":0,\"wind_avg_mi_h\":4.6}", -70);  // promotes: sub for type 0
  record("{\"model\":\"Acurite-5n1\",\"id\":396,\"message_type\":1,\"rain_mm\":0.5}", -71);         // sub for type 1
  ok &= check("two message_types create two subs", deviceCount() == 1);
  ok &= check("latest payload is the most recent message_type",
              strstr(latestPayload(device(0)), "\"rain_mm\"") != NULL);

  record("{\"model\":\"Acurite-5n1\",\"id\":396,\"message_type\":0,\"wind_avg_mi_h\":5.0}", -72);
  ok &= check("re-recording message_type 0 updates its sub",
              strstr(latestPayload(device(0)), "\"wind_avg_mi_h\":5") != NULL);

  reset();
  record("{\"model\":\"Acurite-Tower\",\"id\":1234,\"temperature_C\":21.5}", -70);
  record("{\"model\":\"Acurite-Tower\",\"id\":1234,\"temperature_C\":21.5}", -70);
  ok &= check("device without message_type has one sub",
              deviceCount() == 1);

  reset();
  record("{\"model\":\"Acurite-5n1\",\"id\":396,\"message_type\":0,\"wind_avg_mi_h\":4.6}", -70);  // pending
  record("{\"model\":\"Acurite-5n1\",\"id\":396,\"message_type\":0,\"wind_avg_mi_h\":4.6}", -70);  // promotes: sub 0
  delay(2);
  record("{\"model\":\"Acurite-5n1\",\"id\":396,\"message_type\":1,\"rain_mm\":0.5}", -71);         // sub 1, newer
  {
    unsigned long base = _subs[0].lastSeen;
    sweepSubStale(base + SUB_STALE_MS + 3, SUB_STALE_MS);  // both subs now past SUB_STALE_MS
    ok &= check("the sub sweep spares a slot's newest sub and never frees the device",
                deviceCount() == 1 && subAt(0) == NULL && subAt(1) != NULL);
    unsigned long deviceBase = _devices[0].lastSeen;
    sweepStale(deviceBase + 60001, 60000);
    ok &= check("the device window, not the sub sweep, is what ends the slot's life",
                deviceCount() == 0);
  }

  reset();
  record("{\"model\":\"Stale\",\"id\":1,\"temperature_C\":1}", -50);
  record("{\"model\":\"Stale\",\"id\":1,\"temperature_C\":1}", -50);
  record("{\"model\":\"Fresh\",\"id\":2,\"temperature_C\":2}", -50);
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
  record("{\"model\":\"Wrap\",\"id\":3,\"temperature_C\":3}", -50);
  unsigned long nearWrap = (unsigned long)-1 - 100;
  _devices[0].lastSeen = nearWrap;
  _subs[0].lastSeen = nearWrap; // sweepStale also sweeps subs; spare the wrap's sub too
  sweepStale(nearWrap + 151, 60000); // wraps to 50; 151ms elapsed, inside the window
  ok &= check("a device inside the window survives a millis rollover",
              deviceCount() == 1);
  sweepStale(nearWrap + 70000, 60000); // wraps to 69899; 70000ms elapsed, past the window
  ok &= check("a device past the window is swept across a millis rollover",
              deviceCount() == 0);

  reset();
  ok &= check("telemetry gets a card on the first call",
              record("{\"model\":\"Receiver\",\"temperature_C\":40}", -50, false));
  ok &= check("telemetry takes a device slot", deviceCount() == 1);
  ok &= check("telemetry keys with a 0 id",
              strcmp(device(0).key, "rtl433-a1b2c3/Receiver/0") == 0);
  ok &= check("telemetry is not counted as a decode", totalRecorded() == 0);

  ok &= check("a decode's first sighting does not take a slot",
              !record("{\"model\":\"Real\",\"id\":1}", -70));
  ok &= check("still just the telemetry device", deviceCount() == 1);
  ok &= check("a decode's second sighting promotes it",
              record("{\"model\":\"Real\",\"id\":1}", -70));
  ok &= check("both devices present", deviceCount() == 2);
  ok &= check("only the promoted decode counts as recorded", totalRecorded() == 1);

  reset();
  for (int i = 0; i < SIGNAL_PENDING_SLOTS + 3; i++) {
    snprintf(buf, sizeof(buf), "{\"model\":\"Churn\",\"id\":%d}", i);
    record(buf, -70);  // each a distinct new key: pending only, never confirmed
  }
  ok &= check("churn through distinct one-off keys creates no devices",
              deviceCount() == 0);
  ok &= check("a repeat of an evicted pending key is pending again",
              !record("{\"model\":\"Churn\",\"id\":0}", -70));
  ok &= check("a repeat of a still-pending key promotes it",
              record("{\"model\":\"Churn\",\"id\":10}", -70));
  ok &= check("the promoted device is the only one", deviceCount() == 1);

  reset();
  static int hookACalls = 0;
  static int hookBCalls = 0;
  // Production hooks may already fill every slot by the time this runs.
  uint8_t    savedHookCount = _hookCount;
  RecordHook savedHooks[SIGNAL_MAX_HOOKS];
  memcpy(savedHooks, _hooks, sizeof(_hooks));
  _hookCount = 0;
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

  _hookCount = savedHookCount;
  memcpy(_hooks, savedHooks, sizeof(_hooks));

  reset();
  record("{\"model\":\"Dev\",\"id\":\"12345678901234567890\"}", -70);  // pending regardless
  ok &= check("a 20-character id is rejected rather than truncated into a colliding key",
              !record("{\"model\":\"Dev\",\"id\":\"12345678901234567890\"}", -70) &&
                  deviceCount() == 0);

  reset();
  static int oversizeHookCalls = 0;
  {
    uint8_t    savedHookCount2 = _hookCount;
    RecordHook savedHooks2[SIGNAL_MAX_HOOKS];
    memcpy(savedHooks2, _hooks, sizeof(_hooks));
    _hookCount = 0;
    oversizeHookCalls = 0;
    addRecordHook([](const char*, JsonDocument&) { oversizeHookCalls++; });
    char longNote[SIGNAL_PAYLOAD_MAX];
    memset(longNote, 'A', sizeof(longNote) - 1);
    longNote[sizeof(longNote) - 1] = '\0';
    snprintf(buf, sizeof(buf), "{\"model\":\"Oversize\",\"id\":1,\"note\":\"%s\"}", longNote);
    record(buf, -70);  // first sighting: pending, no hook fires regardless
    ok &= check("an over-long payload is dropped before any hook runs",
                !record(buf, -70) && oversizeHookCalls == 0);
    _hookCount = savedHookCount2;
    memcpy(_hooks, savedHooks2, sizeof(_hooks));
  }

  // The record() arena is a fixed SIGNAL_JSON_POOL_BYTES buffer, not malloc, so
  // a parse that needs more than it holds must fail cleanly rather than
  // corrupt memory or assert. A single string value bigger than the whole
  // arena forces that path deterministically, regardless of the pool's slot
  // bookkeeping overhead.
  reset();
  static int poolExhaustedHookCalls = 0;
  {
    uint8_t    savedHookCount4 = _hookCount;
    RecordHook savedHooks4[SIGNAL_MAX_HOOKS];
    memcpy(savedHooks4, _hooks, sizeof(_hooks));
    _hookCount = 0;
    poolExhaustedHookCalls = 0;
    addRecordHook([](const char*, JsonDocument&) { poolExhaustedHookCalls++; });

    char      hugeNote[6000];
    memset(hugeNote, 'A', sizeof(hugeNote) - 1);
    hugeNote[sizeof(hugeNote) - 1] = '\0';
    char hugeBuf[6200];
    snprintf(hugeBuf, sizeof(hugeBuf), "{\"model\":\"Huge\",\"id\":1,\"note\":\"%s\"}", hugeNote);
    uint32_t droppedBefore = droppedCount();
    uint32_t parseOkBefore = testParseOkCount();
    ok &= check("a parse too big for the fixed JSON pool is dropped, not crashed",
                !record(hugeBuf, -70));
    ok &= check("the pool-exhausted parse advances the drop counter",
                droppedCount() == droppedBefore + 1);
    // Distinguishes which rejection fired: unlike the over-long-payload case
    // above, this parse must never complete, so testParseOkCount() must not
    // advance — the arena boundary is what rejects it, not measureJson's
    // size check.
    ok &= check("the pool-exhausted parse never advances past deserializeJson",
                testParseOkCount() == parseOkBefore);
    ok &= check("a pool-exhausted parse creates no device", deviceCount() == 0);
    ok &= check("a pool-exhausted parse never reaches a hook",
                poolExhaustedHookCalls == 0);

    _hookCount = savedHookCount4;
    memcpy(_hooks, savedHooks4, sizeof(_hooks));
  }

  reset();
  for (int d = 0; d < 8; d++) {
    for (int mt = 0; mt < 4; mt++) {
      snprintf(buf, sizeof(buf), "{\"model\":\"Splitter\",\"id\":%d,\"message_type\":%d}", d, mt);
      record(buf, -70);
      if (mt == 0) {
        record(buf, -70);  // first message_type needs a second sighting to promote
      }
    }
  }
  ok &= check("32 subs across 8 splitters fill the sub table", deviceCount() == 8);
  {
    uint8_t before = deviceCount();
    record("{\"model\":\"NewDev\",\"id\":1}", -70);  // pending
    record("{\"model\":\"NewDev\",\"id\":1}", -70);  // sub table is full; this device has no sub to evict
    ok &= check("a failed sub claim does not leak a device slot", deviceCount() == before);
    bool anyNullPayload = false;
    for (uint8_t i = 0; i < SIGNAL_DEVICE_SLOTS; i++) {
      const DeviceSlot* s = slotAt(i);
      if (s != NULL && latestPayload(*s) == NULL) anyNullPayload = true;
    }
    ok &= check("no live slot has a NULL latestPayload", !anyNullPayload);

    static int fullTableHookCalls = 0;
    uint8_t    savedHookCount3 = _hookCount;
    RecordHook savedHooks3[SIGNAL_MAX_HOOKS];
    memcpy(savedHooks3, _hooks, sizeof(_hooks));
    _hookCount = 0;
    fullTableHookCalls = 0;
    addRecordHook([](const char*, JsonDocument&) { fullTableHookCalls++; });
    record("{\"model\":\"AnotherNewDev\",\"id\":1}", -70);  // pending
    record("{\"model\":\"AnotherNewDev\",\"id\":1}", -70);  // sub table still full; promotion is dropped
    ok &= check("a record dropped for a full sub table never reaches a hook",
                fullTableHookCalls == 0 && deviceCount() == before);
    _hookCount = savedHookCount3;
    memcpy(_hooks, savedHooks3, sizeof(_hooks));
  }

  {
    DeviceSlot foreign{};
    ok &= check("indexOf rejects a slot outside the table", indexOf(foreign) < 0);
  }
  reset();
  record("{\"model\":\"Dev\",\"id\":1}", -70);
  record("{\"model\":\"Dev\",\"id\":1}", -70);
  ok &= check("indexOf finds a slot in the table", indexOf(device(0)) == 0);

  Log.notice(F("selfTest overall: %s" CR), ok ? "PASS" : "FAIL");
  return ok;
}
#endif

} // namespace signal_store
