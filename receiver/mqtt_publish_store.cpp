#include "mqtt_publish_store.h"

#include <ArduinoJson.h>
#include <ArduinoLog.h>
#include <Preferences.h>

#include "str_util.h"

namespace mqtt_publish_store {

static char        _url[MQTT_PUBLISH_SLOTS][MQTT_PUBLISH_STORE_URL_MAX];
static char        _token[MQTT_PUBLISH_SLOTS][MQTT_PUBLISH_STORE_TOKEN_MAX];
static bool        _used[MQTT_PUBLISH_SLOTS] = {false};
static Preferences _prefs;
static bool        _open = false;

static int find(const char* url) {
  for (uint8_t i = 0; i < MQTT_PUBLISH_SLOTS; i++) {
    if (_used[i] && strcmp(_url[i], url) == 0) {
      return i;
    }
  }
  return -1;
}

static int findFree() {
  for (uint8_t i = 0; i < MQTT_PUBLISH_SLOTS; i++) {
    if (!_used[i]) {
      return i;
    }
  }
  return -1;
}

static bool validUrl(const char* url) {
  if (url == NULL || url[0] == '\0' || strlen(url) >= MQTT_PUBLISH_STORE_URL_MAX) {
    return false;
  }
  return strncmp(url, "mqtt://", 7) == 0 || strncmp(url, "mqtts://", 8) == 0;
}

static bool validToken(const char* token) {
  return token != NULL && strlen(token) < MQTT_PUBLISH_STORE_TOKEN_MAX;
}

static size_t serializeTable(char* out, size_t size) {
  JsonDocument doc;
  JsonArray    arr = doc.to<JsonArray>();
  for (uint8_t i = 0; i < MQTT_PUBLISH_SLOTS; i++) {
    if (_used[i]) {
      JsonObject o = arr.add<JsonObject>();
      o["url"] = (const char*)_url[i];
      o["token"] = (const char*)_token[i];
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
  JsonArray arr = doc.as<JsonArray>();
  if (arr.isNull()) {
    return;
  }
  uint8_t i = 0;
  for (JsonObject o : arr) {
    if (i >= MQTT_PUBLISH_SLOTS || !o["url"].is<const char*>() || !o["token"].is<const char*>()) {
      continue;
    }
    copyTruncated(_url[i], MQTT_PUBLISH_STORE_URL_MAX, o["url"].as<const char*>());
    copyTruncated(_token[i], MQTT_PUBLISH_STORE_TOKEN_MAX, o["token"].as<const char*>());
    _used[i] = true;
    i++;
  }
}

static bool persist() {
  char   blob[MQTT_PUBLISH_STORE_BLOB_MAX];
  size_t n = serializeTable(blob, sizeof(blob));
  if (n == 0) {
    return false;
  }
  if (!_open) {
    // A receiver whose NVS won't open should still let a session-only add
    // work rather than answer 503 to every POST /$mqtt.
    return true;
  }
  return _prefs.putString("table", blob) > 0;
}

uint8_t count() {
  uint8_t n = 0;
  for (uint8_t i = 0; i < MQTT_PUBLISH_SLOTS; i++) {
    if (_used[i]) {
      n++;
    }
  }
  return n;
}

const char* urlAt(uint8_t i) {
  return i < MQTT_PUBLISH_SLOTS && _used[i] ? _url[i] : NULL;
}

const char* tokenAt(uint8_t i) {
  return i < MQTT_PUBLISH_SLOTS && _used[i] ? _token[i] : NULL;
}

bool add(const char* url, const char* token) {
  if (!validUrl(url) || !validToken(token)) {
    return false;
  }
  int  i = find(url);
  bool inserting = (i < 0);
  if (inserting) {
    i = findFree();
    if (i < 0) {
      return false;
    }
  }
  char prevUrl[MQTT_PUBLISH_STORE_URL_MAX];
  char prevToken[MQTT_PUBLISH_STORE_TOKEN_MAX];
  if (!inserting) {
    copyTruncated(prevUrl, sizeof(prevUrl), _url[i]);
    copyTruncated(prevToken, sizeof(prevToken), _token[i]);
  }
  copyTruncated(_url[i], MQTT_PUBLISH_STORE_URL_MAX, url);
  copyTruncated(_token[i], MQTT_PUBLISH_STORE_TOKEN_MAX, token);
  _used[i] = true;
  if (persist()) {
    return true;
  }
  if (inserting) {
    _used[i] = false;
  } else {
    copyTruncated(_url[i], sizeof(_url[i]), prevUrl);
    copyTruncated(_token[i], sizeof(_token[i]), prevToken);
  }
  return false;
}

bool remove(const char* url) {
  int i = find(url);
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

int indexOf(const char* url) {
  return find(url);
}

// Reuses add()'s validation on the theory that a value the old set() already
// accepted still passes it; if it somehow doesn't, migration silently no-ops
// and the old keys are left in place rather than losing the setting.
static bool migrateLegacy(const char* legacyUrl, const char* legacyToken) {
  if (count() != 0 || legacyUrl == NULL || legacyUrl[0] == '\0') {
    return false;
  }
  return add(legacyUrl, legacyToken == NULL ? "" : legacyToken);
}

bool begin() {
  if (_open) {
    return true;
  }
  memset(_used, 0, sizeof(_used));
  _open = _prefs.begin("mqtt", false);
  if (!_open) {
    Log.warning(F("mqtt publish store: NVS unavailable, settings will not persist" CR));
    return false;
  }
  String stored = _prefs.getString("table", "");
  loadTable(stored.c_str());
  String oldUrl = _prefs.getString("url", "");
  if (migrateLegacy(oldUrl.c_str(), _prefs.getString("token", "").c_str())) {
    _prefs.remove("url");
    _prefs.remove("token");
    Log.notice(F("mqtt publish store: migrated legacy single-broker setting" CR));
  }
  Log.notice(F("mqtt publish store: %d bridge(s) configured" CR), (int)count());
  return true;
}

#ifdef FAKE_SIGNALS
static bool check(const char* what, bool ok) {
  Log.notice(F("mqtt_publish_store selfTest %s: %s" CR), what, ok ? "PASS" : "FAIL");
  return ok;
}

bool selfTest() {
  bool ok = true;

  // Suppress NVS traffic across the checks below, same as alias_store::selfTest();
  // add()/remove() still exercise their in-memory logic and persist()'s "NVS
  // closed still returns true" branch. Unlike alias_store::selfTest(), the
  // whole live table is snapshotted and restored below: begin() has already
  // loaded real bridges from NVS by the time this runs, and leaving the
  // table wiped would make the next POST /$mqtt persist() over them.
  bool saved_open = _open;
  _open           = false;
  char saved_url[MQTT_PUBLISH_SLOTS][MQTT_PUBLISH_STORE_URL_MAX];
  char saved_token[MQTT_PUBLISH_SLOTS][MQTT_PUBLISH_STORE_TOKEN_MAX];
  bool saved_used[MQTT_PUBLISH_SLOTS];
  memcpy(saved_url, _url, sizeof(_url));
  memcpy(saved_token, _token, sizeof(_token));
  memcpy(saved_used, _used, sizeof(_used));
  memset(_used, 0, sizeof(_used));

  ok &= check("an empty table has no entries", count() == 0);
  ok &= check("indexOf on an empty table is -1", indexOf("mqtt://broker.local:1883") < 0);
  ok &= check("validUrl rejects an empty url", !validUrl(""));
  ok &= check("validUrl rejects a scheme it does not recognize", !validUrl("http://broker.local"));
  ok &= check("validUrl accepts mqtt://", validUrl("mqtt://broker.local:1883"));
  ok &= check("validUrl accepts mqtts://", validUrl("mqtts://weather.rkroll.com:8883"));
  ok &= check("validToken accepts an empty token", validToken(""));

  char longUrl[MQTT_PUBLISH_STORE_URL_MAX + 1];
  memset(longUrl, 'a', sizeof(longUrl) - 1);
  longUrl[sizeof(longUrl) - 1] = '\0';
  ok &= check("validUrl rejects an over-length url", !validUrl(longUrl));

  char longToken[MQTT_PUBLISH_STORE_TOKEN_MAX + 1];
  memset(longToken, 'b', sizeof(longToken) - 1);
  longToken[sizeof(longToken) - 1] = '\0';
  ok &= check("validToken rejects an over-length token", !validToken(longToken));

  ok &= check("add stores a url/token pair", add("mqtt://broker.local:1883", "tok"));
  ok &= check("count reflects one entry", count() == 1);
  int i0 = indexOf("mqtt://broker.local:1883");
  ok &= check("indexOf finds it", i0 >= 0);
  ok &= check("urlAt/tokenAt round-trip",
              strcmp(urlAt((uint8_t)i0), "mqtt://broker.local:1883") == 0 &&
                  strcmp(tokenAt((uint8_t)i0), "tok") == 0);

  ok &= check("re-adding the same url updates the token in place",
              add("mqtt://broker.local:1883", "tok2") && count() == 1 &&
                  strcmp(tokenAt((uint8_t)i0), "tok2") == 0);

  ok &= check("add rejects an invalid url", !add("http://broker.local", "tok"));
  ok &= check("a rejected add leaves the table alone", count() == 1);

  ok &= check("add fills the remaining slots",
              add("mqtt://b2:1883", "") && add("mqtts://b3:8883", "t3") && count() == MQTT_PUBLISH_SLOTS);
  ok &= check("add past the cap fails, no matching url", !add("mqtt://b4:1883", ""));
  ok &= check("a failed add leaves the count unchanged", count() == MQTT_PUBLISH_SLOTS);

  ok &= check("remove drops the matching entry", remove("mqtt://b2:1883"));
  ok &= check("count drops with it", count() == MQTT_PUBLISH_SLOTS - 1);
  ok &= check("removing an absent url reports false", !remove("mqtt://b2:1883"));
  ok &= check("a freed slot is reusable", add("mqtt://b4:1883", "") && count() == MQTT_PUBLISH_SLOTS);

  memset(_used, 0, sizeof(_used));
  ok &= check("migrateLegacy copies a legacy value into slot 0",
              migrateLegacy("mqtts://weather.rkroll.com:8883", "legacy") && count() == 1 &&
                  strcmp(urlAt(0), "mqtts://weather.rkroll.com:8883") == 0 &&
                  strcmp(tokenAt(0), "legacy") == 0);
  ok &= check("migrateLegacy is a no-op once the table is non-empty",
              !migrateLegacy("mqtt://other:1883", "") && count() == 1);

  memset(_used, 0, sizeof(_used));
  ok &= check("migrateLegacy is a no-op with no legacy url", !migrateLegacy("", ""));
  ok &= check("migrateLegacy is a no-op with a null legacy url", !migrateLegacy(NULL, NULL));

  memset(_used, 0, sizeof(_used));
  add("mqtt://b1:1883", "t1");
  add("mqtts://b2:8883", "");
  char blob[MQTT_PUBLISH_STORE_BLOB_MAX];
  size_t n = serializeTable(blob, sizeof(blob));
  ok &= check("the table serialises", n > 0);
  memset(_used, 0, sizeof(_used));
  loadTable(blob);
  ok &= check("a serialised blob reloads", count() == 2);
  int ib2 = indexOf("mqtts://b2:8883");
  ok &= check("an empty stored token round-trips",
              ib2 >= 0 && strcmp(tokenAt((uint8_t)ib2), "") == 0);

  memset(_used, 0, sizeof(_used));
  loadTable("not json at all");
  ok &= check("an unparseable blob loads as empty", count() == 0);

  memcpy(_url, saved_url, sizeof(_url));
  memcpy(_token, saved_token, sizeof(_token));
  memcpy(_used, saved_used, sizeof(_used));
  _open = saved_open;
  Log.notice(F("mqtt_publish_store selfTest overall: %s" CR), ok ? "PASS" : "FAIL");
  return ok;
}
#endif

} // namespace mqtt_publish_store
