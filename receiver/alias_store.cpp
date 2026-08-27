#include "alias_store.h"

#include <ArduinoJson.h>
#include <ArduinoLog.h>
#include <Preferences.h>

#include "selftest_check.h"
#include "str_util.h"

namespace alias_store {

// NVS keys are typed: a getBytesLength on a key still holding the old
// putString value reads as absent, which is what makes the two-key
// migration below safe to run on every begin(). LEGACY_KEY is the string
// this used to be written as.
#define BLOB_KEY   "tbl"
#define LEGACY_KEY "map"

static char        _topics[ALIAS_SLOTS][ALIAS_TOPIC_MAX];
static char        _names[ALIAS_SLOTS][ALIAS_NAME_MAX];
static bool        _used[ALIAS_SLOTS] = {false};
static Preferences _prefs;
static bool        _open = false;

static int find(const char* topic) {
  for (uint8_t i = 0; i < ALIAS_SLOTS; i++) {
    if (_used[i] && strcmp(_topics[i], topic) == 0) {
      return i;
    }
  }
  return -1;
}

static int findFree() {
  for (uint8_t i = 0; i < ALIAS_SLOTS; i++) {
    if (!_used[i]) {
      return i;
    }
  }
  return -1;
}

static size_t serializeTable(char* out, size_t size) {
  JsonDocument doc;
  for (uint8_t i = 0; i < ALIAS_SLOTS; i++) {
    if (_used[i]) {
      doc[(const char*)_topics[i]] = (const char*)_names[i];
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
  JsonObject obj = doc.as<JsonObject>();
  if (obj.isNull()) {
    return;
  }
  uint8_t i = 0;
  for (JsonPair kv : obj) {
    if (i >= ALIAS_SLOTS) {
      break;
    }
    if (!kv.value().is<const char*>()) {
      continue;
    }
    copyTruncated(_topics[i], ALIAS_TOPIC_MAX, kv.key().c_str());
    copyTruncated(_names[i], ALIAS_NAME_MAX, kv.value().as<const char*>());
    _used[i] = true;
    i++;
  }
}

static bool persist() {
  char   blob[ALIAS_BLOB_MAX];
  size_t n = serializeTable(blob, sizeof(blob));
  if (n == 0) {
    return false;
  }
  if (!_open) {
    // A receiver whose NVS won't open should still let a viewer name a
    // device for the session rather than answer 503 to every rename.
    return true;
  }
  return _prefs.putBytes(BLOB_KEY, blob, n) > 0;
}

// Read the bytes key if present; otherwise adopt the legacy string key and
// write it back as bytes, removing the legacy key only once that write
// succeeds. Safe to call more than once: a device already on the bytes key
// takes the first branch every time, and a device with both keys present
// (bytes written, legacy remove not yet run) still prefers the bytes key
// rather than re-adopting the stale string.
static void load() {
  size_t n = _prefs.getBytesLength(BLOB_KEY);
  if (n > 0 && n < ALIAS_BLOB_MAX) {
    char blob[ALIAS_BLOB_MAX];
    _prefs.getBytes(BLOB_KEY, blob, n);
    blob[n] = '\0';
    loadTable(blob);
    // Retry the legacy key's removal in case a prior migration's write
    // succeeded but a crash before its own remove() left it behind;
    // harmless no-op once the legacy key is already gone.
    _prefs.remove(LEGACY_KEY);
    return;
  }
  String stored = _prefs.getString(LEGACY_KEY, "");
  if (stored.length() == 0) {
    return;
  }
  loadTable(stored.c_str());
  if (_prefs.putBytes(BLOB_KEY, stored.c_str(), stored.length()) > 0) {
    _prefs.remove(LEGACY_KEY);
  }
}

bool begin() {
  if (_open) {
    return true;
  }
  memset(_used, 0, sizeof(_used));
  _open = _prefs.begin("alias", false);
  if (!_open) {
    Log.warning(F("alias store: NVS unavailable, aliases will not persist" CR));
    return false;
  }
  load();
  Log.notice(F("alias store: %d aliases loaded (%d free NVS entries)" CR), (int)count(),
             (int)_prefs.freeEntries());
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
    i = findFree();
    if (i < 0) {
      return false;
    }
    copyTruncated(_topics[i], ALIAS_TOPIC_MAX, topic);
    previous[0] = '\0';
  } else {
    copyTruncated(previous, sizeof(previous), _names[i]);
    if (strcmp(previous, name) == 0) {
      return true;
    }
  }
  copyTruncated(_names[i], ALIAS_NAME_MAX, name);
  _used[i] = true;
  if (persist()) {
    return true;
  }
  if (added) {
    _used[i] = false;
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
  _used[i] = false;
  if (persist()) {
    return true;
  }
  _used[i] = true;
  return false;
}

uint8_t count() {
  uint8_t n = 0;
  for (uint8_t i = 0; i < ALIAS_SLOTS; i++) {
    if (_used[i]) {
      n++;
    }
  }
  return n;
}

const char* topicAt(uint8_t i) {
  return i < ALIAS_SLOTS && _used[i] ? _topics[i] : NULL;
}

const char* nameAt(uint8_t i) {
  return i < ALIAS_SLOTS && _used[i] ? _names[i] : NULL;
}

int indexOf(const char* topic) {
  return find(topic);
}

#ifdef FAKE_SIGNALS
#define CHECK(what, ok) selfTestCheck("alias", what, ok)

bool selfTest() {
  bool ok = true;
  char blob[ALIAS_BLOB_MAX];
  char topic[ALIAS_TOPIC_MAX];

  // Suppress NVS traffic across the dozens of set() calls below; persist()'s
  // blob-size check runs before its _open check, so the cap tests still work.
  // Snapshot the in-RAM table too, same as mqtt_publish_store::selfTest():
  // begin() has already loaded real aliases from NVS by the time this runs,
  // and leaving the table wiped or full of test data would make the next
  // alias read/write see it instead of the real ones.
  bool saved_open = _open;
  _open           = false;
  static char saved_topics[ALIAS_SLOTS][ALIAS_TOPIC_MAX];
  static char saved_names[ALIAS_SLOTS][ALIAS_NAME_MAX];
  static bool saved_used[ALIAS_SLOTS];
  memcpy(saved_topics, _topics, sizeof(_topics));
  memcpy(saved_names, _names, sizeof(_names));
  memcpy(saved_used, _used, sizeof(_used));

  memset(_used, 0, sizeof(_used));
  ok &= CHECK("an unset topic has no alias", get("s/M/1/$alias") == NULL);
  ok &= CHECK("set stores a name", set("s/M/1/$alias", "Back fence"));
  ok &= CHECK("get returns the name",
              get("s/M/1/$alias") != NULL && strcmp(get("s/M/1/$alias"), "Back fence") == 0);
  ok &= CHECK("set of the same topic replaces in place",
              set("s/M/1/$alias", "Front gate") && count() == 1 &&
                  strcmp(get("s/M/1/$alias"), "Front gate") == 0);
  ok &= CHECK("an empty name removes", set("s/M/1/$alias", "") && get("s/M/1/$alias") == NULL);
  ok &= CHECK("removing an unset topic reports false", !remove("s/M/1/$alias"));

  memset(_used, 0, sizeof(_used));
  set("s/M/1/$alias", "one");
  set("s/M/2/$alias", "two");
  set("s/M/3/$alias", "three");
  int idx1 = indexOf("s/M/1/$alias");
  int idx2 = indexOf("s/M/2/$alias");
  int idx3 = indexOf("s/M/3/$alias");
  ok &= CHECK("removing a set topic reports true", remove("s/M/2/$alias"));
  ok &= CHECK("removing an entry drops the count", count() == 2);
  ok &= CHECK("a removed entry's neighbours keep their indices",
              indexOf("s/M/1/$alias") == idx1 && indexOf("s/M/3/$alias") == idx3);
  ok &= CHECK("a removed entry reads as NULL", idx2 >= 0 && topicAt((uint8_t)idx2) == NULL &&
                                                    nameAt((uint8_t)idx2) == NULL);
  set("s/M/4/$alias", "four");
  ok &= CHECK("a later set reuses the freed entry", indexOf("s/M/4/$alias") == idx2);

  memset(_used, 0, sizeof(_used));
  bool capped = true;
  for (int i = 0; i < ALIAS_SLOTS; i++) {
    snprintf(topic, sizeof(topic), "s/M/%d/$alias", i);
    capped &= set(topic, "n");
  }
  ok &= CHECK("the table fills to ALIAS_SLOTS", capped && count() == ALIAS_SLOTS);
  ok &= CHECK("a set past the cap fails", !set("s/M/99/$alias", "n"));
  ok &= CHECK("a failed set leaves the table alone", count() == ALIAS_SLOTS);

  memset(_used, 0, sizeof(_used));
  set("s/M/1/$alias", "Back \"fence\"");
  set("s/$alias", "Garage");
  size_t n = serializeTable(blob, sizeof(blob));
  ok &= CHECK("the table serialises", n > 0);
  memset(_used, 0, sizeof(_used));
  loadTable(blob);
  ok &= CHECK("a serialised blob reloads", count() == 2);
  ok &= CHECK("a quoted name survives the round trip",
              get("s/M/1/$alias") != NULL && strcmp(get("s/M/1/$alias"), "Back \"fence\"") == 0);
  ok &= CHECK("a source level alias survives the round trip",
              get("s/$alias") != NULL && strcmp(get("s/$alias"), "Garage") == 0);

  memset(_used, 0, sizeof(_used));
  loadTable("not json at all");
  ok &= CHECK("an unparseable blob loads as empty", count() == 0);

  memset(_used, 0, sizeof(_used));
  char name[ALIAS_NAME_MAX];
  memset(name, 'n', sizeof(name) - 1);
  name[sizeof(name) - 1] = '\0';
  bool blobFailed = false;
  int  filled     = 0;
  for (int i = 0; i < ALIAS_SLOTS; i++) {
    int    prefixLen = snprintf(topic, sizeof(topic), "s/M/%d/", i);
    size_t padLen = sizeof(topic) - 1 - (size_t)prefixLen;
    memset(topic + prefixLen, 't', padLen);
    topic[sizeof(topic) - 1] = '\0';
    if (!set(topic, name)) {
      blobFailed = true;
      break;
    }
    filled++;
  }
  ok &= CHECK("a set that would overflow the blob fails", blobFailed);
  ok &= CHECK("a set that overflows the blob leaves the count unchanged",
              (int)count() == filled);
  char   lastTopic[ALIAS_TOPIC_MAX];
  int    prefixLen = snprintf(lastTopic, sizeof(lastTopic), "s/M/%d/", filled - 1);
  size_t padLen = sizeof(lastTopic) - 1 - (size_t)prefixLen;
  memset(lastTopic + prefixLen, 't', padLen);
  lastTopic[sizeof(lastTopic) - 1] = '\0';
  ok &= CHECK("the last name stored before the blob overflow is still readable",
              get(lastTopic) != NULL && strcmp(get(lastTopic), name) == 0);

  memset(_used, 0, sizeof(_used));
  set("s/M/1/$alias", "Same name");
  ok &= CHECK("re-setting an entry with the same name is a no-op",
              set("s/M/1/$alias", "Same name") && count() == 1);

  // The rest runs against NVS: the two-key migration off the string this
  // used to be written as, its idempotency, the half-migrated case, and the
  // dedup write skip.
  _open = _prefs.begin("alias", false);
  if (_open) {
    _prefs.remove(BLOB_KEY);
    _prefs.remove(LEGACY_KEY);

    memset(_used, 0, sizeof(_used));
    ok &= CHECK("a stored table survives a reload",
                set("s/M/1/$alias", "Reload me") &&
                    (memset(_used, 0, sizeof(_used)), load(), true) && count() == 1 &&
                    get("s/M/1/$alias") != NULL &&
                    strcmp(get("s/M/1/$alias"), "Reload me") == 0);

    _prefs.remove(BLOB_KEY);
    _prefs.putString(LEGACY_KEY, "{\"s/M/2/$alias\":\"Legacy name\"}");
    memset(_used, 0, sizeof(_used));
    load();
    ok &= CHECK("a table stored as a string is still read",
                count() == 1 && get("s/M/2/$alias") != NULL &&
                    strcmp(get("s/M/2/$alias"), "Legacy name") == 0);
    ok &= CHECK("reading one migrates it to a blob", _prefs.getBytesLength(BLOB_KEY) > 0);
    ok &= CHECK("and drops the string it came from",
                _prefs.getString(LEGACY_KEY, "").length() == 0);
    ok &= CHECK("running load() again after migrating changes nothing",
                (memset(_used, 0, sizeof(_used)), load(), true) && count() == 1 &&
                    get("s/M/2/$alias") != NULL &&
                    strcmp(get("s/M/2/$alias"), "Legacy name") == 0);

    // Half-migrated: the bytes write landed but a crash before remove() left
    // the legacy string key behind. load() must prefer the bytes key rather
    // than re-adopt or duplicate the stale string.
    _prefs.remove(BLOB_KEY);
    _prefs.remove(LEGACY_KEY);
    _prefs.putBytes(BLOB_KEY, "{\"s/M/3/$alias\":\"Bytes name\"}",
                     strlen("{\"s/M/3/$alias\":\"Bytes name\"}"));
    _prefs.putString(LEGACY_KEY, "{\"s/M/2/$alias\":\"Legacy name\"}");
    memset(_used, 0, sizeof(_used));
    load();
    ok &= CHECK("a half-migrated store reads the bytes key, not the stale string",
                count() == 1 && get("s/M/3/$alias") != NULL &&
                    strcmp(get("s/M/3/$alias"), "Bytes name") == 0);

    _prefs.remove(BLOB_KEY);
    _prefs.remove(LEGACY_KEY);

    memset(_used, 0, sizeof(_used));
    set("s/M/1/$alias", "Steady");
#ifdef PREFERENCES_TRACKS_CALLS
    // Call counts are only tracked by the host test shim's Preferences; see
    // location_store::selfTest() for why this is host-only.
    Preferences::resetCallCounts();
    ok &= CHECK("re-setting the same name does not write to NVS",
                set("s/M/1/$alias", "Steady") && Preferences::putBytesCallCount() == 0);
#endif

    _prefs.remove(BLOB_KEY);
    _prefs.remove(LEGACY_KEY);
  }

  memcpy(_topics, saved_topics, sizeof(_topics));
  memcpy(_names, saved_names, sizeof(_names));
  memcpy(_used, saved_used, sizeof(_used));
  _open  = saved_open;
  Log.notice(F("alias selfTest overall: %s" CR), ok ? "PASS" : "FAIL");
  return ok;
}
#endif

} // namespace alias_store
