#include "alias_store.h"

#include <ArduinoJson.h>
#include <ArduinoLog.h>
#include <Preferences.h>

namespace alias_store {

static char        _topics[ALIAS_SLOTS][ALIAS_TOPIC_MAX];
static char        _names[ALIAS_SLOTS][ALIAS_NAME_MAX];
static bool        _used[ALIAS_SLOTS] = {false};
static Preferences _prefs;
static bool        _open = false;

static void copyTruncated(char* dest, size_t destSize, const char* src) {
  strncpy(dest, src, destSize - 1);
  dest[destSize - 1] = '\0';
}

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
    if (i >= ALIAS_SLOTS || !kv.value().is<const char*>()) {
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
  return _prefs.putString("map", blob) > 0;
}

bool begin() {
  memset(_used, 0, sizeof(_used));
  _open = _prefs.begin("alias", false);
  if (!_open) {
    Log.warning(F("alias store: NVS unavailable, aliases will not persist" CR));
    return false;
  }
  String stored = _prefs.getString("map", "");
  loadTable(stored.c_str());
  Log.notice(F("alias store: %d aliases loaded" CR), (int)count());
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
static bool check(const char* what, bool ok) {
  Log.notice(F("alias selfTest %s: %s" CR), what, ok ? "PASS" : "FAIL");
  return ok;
}

bool selfTest() {
  bool ok = true;
  char blob[ALIAS_BLOB_MAX];
  char topic[ALIAS_TOPIC_MAX];

  // Suppress NVS traffic across the dozens of set() calls below; persist()'s
  // blob-size check runs before its _open check, so the cap tests still work.
  bool saved_open = _open;
  _open           = false;

  memset(_used, 0, sizeof(_used));
  ok &= check("an unset topic has no alias", get("s/M/1/$alias") == NULL);
  ok &= check("set stores a name", set("s/M/1/$alias", "Back fence"));
  ok &= check("get returns the name",
              get("s/M/1/$alias") != NULL && strcmp(get("s/M/1/$alias"), "Back fence") == 0);
  ok &= check("set of the same topic replaces in place",
              set("s/M/1/$alias", "Front gate") && count() == 1 &&
                  strcmp(get("s/M/1/$alias"), "Front gate") == 0);
  ok &= check("an empty name removes", set("s/M/1/$alias", "") && get("s/M/1/$alias") == NULL);
  ok &= check("removing an unset topic reports false", !remove("s/M/1/$alias"));

  memset(_used, 0, sizeof(_used));
  set("s/M/1/$alias", "one");
  set("s/M/2/$alias", "two");
  set("s/M/3/$alias", "three");
  int idx1 = indexOf("s/M/1/$alias");
  int idx2 = indexOf("s/M/2/$alias");
  int idx3 = indexOf("s/M/3/$alias");
  ok &= check("removing a set topic reports true", remove("s/M/2/$alias"));
  ok &= check("removing an entry drops the count", count() == 2);
  ok &= check("a removed entry's neighbours keep their indices",
              indexOf("s/M/1/$alias") == idx1 && indexOf("s/M/3/$alias") == idx3);
  ok &= check("a removed entry reads as NULL", topicAt((uint8_t)idx2) == NULL &&
                                                    nameAt((uint8_t)idx2) == NULL);
  set("s/M/4/$alias", "four");
  ok &= check("a later set reuses the freed entry", indexOf("s/M/4/$alias") == idx2);

  memset(_used, 0, sizeof(_used));
  bool capped = true;
  for (int i = 0; i < ALIAS_SLOTS; i++) {
    snprintf(topic, sizeof(topic), "s/M/%d/$alias", i);
    capped &= set(topic, "n");
  }
  ok &= check("the table fills to ALIAS_SLOTS", capped && count() == ALIAS_SLOTS);
  ok &= check("a set past the cap fails", !set("s/M/99/$alias", "n"));
  ok &= check("a failed set leaves the table alone", count() == ALIAS_SLOTS);

  memset(_used, 0, sizeof(_used));
  set("s/M/1/$alias", "Back \"fence\"");
  set("s/$alias", "Garage");
  size_t n = serializeTable(blob, sizeof(blob));
  ok &= check("the table serialises", n > 0);
  memset(_used, 0, sizeof(_used));
  loadTable(blob);
  ok &= check("a serialised blob reloads", count() == 2);
  ok &= check("a quoted name survives the round trip",
              get("s/M/1/$alias") != NULL && strcmp(get("s/M/1/$alias"), "Back \"fence\"") == 0);
  ok &= check("a source level alias survives the round trip",
              get("s/$alias") != NULL && strcmp(get("s/$alias"), "Garage") == 0);

  memset(_used, 0, sizeof(_used));
  loadTable("not json at all");
  ok &= check("an unparseable blob loads as empty", count() == 0);

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
  ok &= check("a set that would overflow the blob fails", blobFailed);
  ok &= check("a set that overflows the blob leaves the count unchanged",
              (int)count() == filled);
  char   lastTopic[ALIAS_TOPIC_MAX];
  int    prefixLen = snprintf(lastTopic, sizeof(lastTopic), "s/M/%d/", filled - 1);
  size_t padLen = sizeof(lastTopic) - 1 - (size_t)prefixLen;
  memset(lastTopic + prefixLen, 't', padLen);
  lastTopic[sizeof(lastTopic) - 1] = '\0';
  ok &= check("the last name stored before the blob overflow is still readable",
              get(lastTopic) != NULL && strcmp(get(lastTopic), name) == 0);

  memset(_used, 0, sizeof(_used));
  _open  = saved_open;
  Log.notice(F("alias selfTest overall: %s" CR), ok ? "PASS" : "FAIL");
  return ok;
}
#endif

} // namespace alias_store
