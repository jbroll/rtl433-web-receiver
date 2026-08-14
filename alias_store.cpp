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
