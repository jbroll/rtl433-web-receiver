#include "mqtt_publish_store.h"

#include <ArduinoJson.h>
#include <ArduinoLog.h>
#include <Preferences.h>

#include "selftest_check.h"
#include "str_util.h"

namespace mqtt_publish_store {

// NVS keys are typed: a getBytesLength on a key still holding the old
// putString value reads as absent, which is what makes the two-key
// migration below safe to run on every begin(). LEGACY_KEY is the string
// this used to be written as.
#define BLOB_KEY   "tbl"
#define LEGACY_KEY "table"

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
    if (i >= MQTT_PUBLISH_SLOTS) {
      break;
    }
    if (!o["url"].is<const char*>() || !o["token"].is<const char*>()) {
      continue;
    }
#ifdef MQTT_BROKER_URL
    // A row equal to the build-flag broker, persisted before add()'s dedupe
    // existed (or by some other path), would otherwise reopen the duplicate-
    // session flap add() was made to stop. Drop it rather than load it.
    if (strcmp(o["url"].as<const char*>(), MQTT_BROKER_URL) == 0) {
      continue;
    }
#endif
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
  return _prefs.putBytes(BLOB_KEY, blob, n) > 0;
}

// Read the bytes key if present; otherwise adopt the legacy string key and
// write it back as bytes, removing the legacy key only once that write
// succeeds. Safe to call more than once, same as alias_store::load().
static void load() {
  size_t n = _prefs.getBytesLength(BLOB_KEY);
  if (n > 0 && n < MQTT_PUBLISH_STORE_BLOB_MAX) {
    char blob[MQTT_PUBLISH_STORE_BLOB_MAX];
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
#ifdef MQTT_BROKER_URL
  // The build-flag broker connects unconditionally; adding it again from the
  // dashboard would open a second session under the same client ID, which
  // most brokers resolve by kicking one, producing a connect/disconnect flap.
  if (strcmp(url, MQTT_BROKER_URL) == 0) {
    return false;
  }
#endif
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
  // load() first, migrateLegacy() second: migrateLegacy only fires when the
  // table is still empty, so a table already migrated from the string key
  // (which load() just did) correctly makes it a no-op. selfTest()'s "State
  // 4" below is a regression test for this ordering: reversed, it fails.
  load();
  // A table load()ed from the legacy `table` string makes migrateLegacy() a
  // no-op (count() != 0), but a stale single-broker url/token pair can still
  // be sitting alongside it; drop the pair whichever path populated the table.
  bool   tableLoaded = count() != 0;
  String oldUrl      = _prefs.getString("url", "");
  bool   migrated    = migrateLegacy(oldUrl.c_str(), _prefs.getString("token", "").c_str());
  if (tableLoaded || migrated) {
    _prefs.remove("url");
    _prefs.remove("token");
  }
  if (migrated) {
    Log.notice(F("mqtt publish store: migrated legacy single-broker setting" CR));
  }
  Log.notice(F("mqtt publish store: %d bridge(s) configured (%d free NVS entries)" CR),
             (int)count(), (int)_prefs.freeEntries());
  return true;
}

#ifdef FAKE_SIGNALS
#define CHECK(what, ok) selfTestCheck("mqtt_publish_store", what, ok)

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
  static char saved_url[MQTT_PUBLISH_SLOTS][MQTT_PUBLISH_STORE_URL_MAX];
  static char saved_token[MQTT_PUBLISH_SLOTS][MQTT_PUBLISH_STORE_TOKEN_MAX];
  static bool saved_used[MQTT_PUBLISH_SLOTS];
  memcpy(saved_url, _url, sizeof(_url));
  memcpy(saved_token, _token, sizeof(_token));
  memcpy(saved_used, _used, sizeof(_used));
  memset(_used, 0, sizeof(_used));

  ok &= CHECK("an empty table has no entries", count() == 0);
  ok &= CHECK("indexOf on an empty table is -1", indexOf("mqtt://broker.local:1883") < 0);
  ok &= CHECK("validUrl rejects an empty url", !validUrl(""));
  ok &= CHECK("validUrl rejects a scheme it does not recognize", !validUrl("http://broker.local"));
  ok &= CHECK("validUrl accepts mqtt://", validUrl("mqtt://broker.local:1883"));
  ok &= CHECK("validUrl accepts mqtts://", validUrl("mqtts://weather.rkroll.com:8883"));
  ok &= CHECK("validToken accepts an empty token", validToken(""));

  char longUrl[MQTT_PUBLISH_STORE_URL_MAX + 1];
  memset(longUrl, 'a', sizeof(longUrl) - 1);
  longUrl[sizeof(longUrl) - 1] = '\0';
  ok &= CHECK("validUrl rejects an over-length url", !validUrl(longUrl));

  char longToken[MQTT_PUBLISH_STORE_TOKEN_MAX + 1];
  memset(longToken, 'b', sizeof(longToken) - 1);
  longToken[sizeof(longToken) - 1] = '\0';
  ok &= CHECK("validToken rejects an over-length token", !validToken(longToken));

  ok &= CHECK("add stores a url/token pair", add("mqtt://broker.local:1883", "tok"));
  ok &= CHECK("count reflects one entry", count() == 1);
  int i0 = indexOf("mqtt://broker.local:1883");
  ok &= CHECK("indexOf finds it", i0 >= 0);
  ok &= CHECK("urlAt/tokenAt round-trip",
              i0 >= 0 && strcmp(urlAt((uint8_t)i0), "mqtt://broker.local:1883") == 0 &&
                  strcmp(tokenAt((uint8_t)i0), "tok") == 0);

  ok &= CHECK("re-adding the same url updates the token in place",
              add("mqtt://broker.local:1883", "tok2") && count() == 1 &&
                  i0 >= 0 && strcmp(tokenAt((uint8_t)i0), "tok2") == 0);

  ok &= CHECK("add rejects an invalid url", !add("http://broker.local", "tok"));
  ok &= CHECK("a rejected add leaves the table alone", count() == 1);

  ok &= CHECK("add fills the remaining slots",
              add("mqtt://b2:1883", "") && add("mqtts://b3:8883", "t3") && count() == MQTT_PUBLISH_SLOTS);
  ok &= CHECK("add past the cap fails, no matching url", !add("mqtt://b4:1883", ""));
  ok &= CHECK("a failed add leaves the count unchanged", count() == MQTT_PUBLISH_SLOTS);

  ok &= CHECK("remove drops the matching entry", remove("mqtt://b2:1883"));
  ok &= CHECK("count drops with it", count() == MQTT_PUBLISH_SLOTS - 1);
  ok &= CHECK("removing an absent url reports false", !remove("mqtt://b2:1883"));
  ok &= CHECK("a freed slot is reusable", add("mqtt://b4:1883", "") && count() == MQTT_PUBLISH_SLOTS);

  memset(_used, 0, sizeof(_used));
  ok &= CHECK("migrateLegacy copies a legacy value into slot 0",
              migrateLegacy("mqtts://weather.rkroll.com:8883", "legacy") && count() == 1 &&
                  strcmp(urlAt(0), "mqtts://weather.rkroll.com:8883") == 0 &&
                  strcmp(tokenAt(0), "legacy") == 0);
  ok &= CHECK("migrateLegacy is a no-op once the table is non-empty",
              !migrateLegacy("mqtt://other:1883", "") && count() == 1);

  memset(_used, 0, sizeof(_used));
  ok &= CHECK("migrateLegacy is a no-op with no legacy url", !migrateLegacy("", ""));
  ok &= CHECK("migrateLegacy is a no-op with a null legacy url", !migrateLegacy(NULL, NULL));

  memset(_used, 0, sizeof(_used));
  add("mqtt://b1:1883", "t1");
  add("mqtts://b2:8883", "");
  char blob[MQTT_PUBLISH_STORE_BLOB_MAX];
  size_t n = serializeTable(blob, sizeof(blob));
  ok &= CHECK("the table serialises", n > 0);
  memset(_used, 0, sizeof(_used));
  loadTable(blob);
  ok &= CHECK("a serialised blob reloads", count() == 2);
  int ib2 = indexOf("mqtts://b2:8883");
  ok &= CHECK("an empty stored token round-trips",
              ib2 >= 0 && strcmp(tokenAt((uint8_t)ib2), "") == 0);

  memset(_used, 0, sizeof(_used));
  loadTable("not json at all");
  ok &= CHECK("an unparseable blob loads as empty", count() == 0);

#ifdef MQTT_BROKER_URL
  memset(_used, 0, sizeof(_used));
  ok &= CHECK("add rejects the build-flag broker url",
              !add(MQTT_BROKER_URL, "tok") && count() == 0);
#endif

  // The rest runs against NVS, and against begin() itself rather than a
  // hand-rolled load()/migrateLegacy() call pair: begin() is what ships, and
  // it is the *order* of the two migrations that matters (see begin()'s own
  // comment), so a test that calls them separately in whatever order it
  // likes proves nothing about the order the firmware actually runs.
  // Tracked apart from _open (repeatedly toggled below, then restored to
  // saved_open) so the real NVS content can be put back afterward
  // regardless of what _open ends up holding.
  _open          = _prefs.begin("mqtt", false);
  bool nvsOpened = _open;
  if (_open) {
    _prefs.remove(BLOB_KEY);
    _prefs.remove(LEGACY_KEY);
    _prefs.remove("url");
    _prefs.remove("token");

    // State 1: a legacy single-broker url/token, no table key at all.
    _prefs.putString("url", "mqtt://legacy-single:1883");
    _prefs.putString("token", "singletok");
    _open = false;
    begin();
    ok &= CHECK("begin migrates a legacy single-broker value with no table into slot 0",
                count() == 1 && strcmp(urlAt(0), "mqtt://legacy-single:1883") == 0 &&
                    strcmp(tokenAt(0), "singletok") == 0);
    ok &= CHECK("begin writes the migrated table as bytes", _prefs.getBytesLength(BLOB_KEY) > 0);
    ok &= CHECK("begin removes the migrated legacy url/token keys",
                _prefs.getString("url", "").length() == 0 &&
                    _prefs.getString("token", "").length() == 0);

    _prefs.remove(BLOB_KEY);
    _prefs.remove(LEGACY_KEY);
    _prefs.remove("url");
    _prefs.remove("token");

    // State 2: the table already stored as a string (pre-putBytes firmware),
    // no legacy single-broker value.
    _prefs.putString(LEGACY_KEY, "[{\"url\":\"mqtt://b1:1883\",\"token\":\"t1\"}]");
    _open = false;
    begin();
    ok &= CHECK("begin still reads a table stored as a string",
                count() == 1 && strcmp(urlAt(0), "mqtt://b1:1883") == 0);
    ok &= CHECK("begin migrates it to a blob", _prefs.getBytesLength(BLOB_KEY) > 0);
    ok &= CHECK("begin drops the string it came from",
                _prefs.getString(LEGACY_KEY, "").length() == 0);
    _open = false;
    begin();
    ok &= CHECK("calling begin again after migrating changes nothing",
                count() == 1 && strcmp(urlAt(0), "mqtt://b1:1883") == 0);

    // State 3: half-migrated. The bytes write landed but a crash before
    // remove() left the legacy string key behind; begin() must prefer the
    // bytes key rather than re-adopt or duplicate the stale string.
    _prefs.remove(BLOB_KEY);
    _prefs.remove(LEGACY_KEY);
    const char* bytesTable = "[{\"url\":\"mqtt://b2:1883\",\"token\":\"t2\"}]";
    _prefs.putBytes(BLOB_KEY, bytesTable, strlen(bytesTable));
    _prefs.putString(LEGACY_KEY, "[{\"url\":\"mqtt://b1:1883\",\"token\":\"t1\"}]");
    _open = false;
    begin();
    ok &= CHECK("a half-migrated store reads the bytes key, not the stale string",
                count() == 1 && strcmp(urlAt(0), "mqtt://b2:1883") == 0);

    _prefs.remove(BLOB_KEY);
    _prefs.remove(LEGACY_KEY);
    _prefs.remove("url");
    _prefs.remove("token");

    // State 4: the headline risk. A legacy `table` string holding multiple
    // bridges, plus a stale single url/token left behind from before the
    // table existed. This is what makes the load()-then-migrateLegacy()
    // order load-bearing: reversed, migrateLegacy() would persist() the
    // single reconstructed broker to the bytes key first, then load() would
    // read that back and loadTable()'s memset(_used) would overwrite the
    // whole in-RAM table with it -- losing the string table's other
    // bridge(s) for good, not duplicating anything.
    _prefs.putString(LEGACY_KEY,
                      "[{\"url\":\"mqtt://b1:1883\",\"token\":\"t1\"},"
                      "{\"url\":\"mqtt://b2:1883\",\"token\":\"t2\"}]");
    _prefs.putString("url", "mqtt://stale-single:1883");
    _prefs.putString("token", "staletok");
    _open = false;
    begin();
    ok &= CHECK("begin on a multi-bridge legacy table with a stale single value keeps both bridges",
                count() == 2 && indexOf("mqtt://b1:1883") >= 0 && indexOf("mqtt://b2:1883") >= 0);
    ok &= CHECK("and does not let the stale single value clobber them",
                indexOf("mqtt://stale-single:1883") < 0);
    ok &= CHECK("and removes the stale legacy url/token pair rather than leaking it forever",
                _prefs.getString("url", "").length() == 0 &&
                    _prefs.getString("token", "").length() == 0);

    _prefs.remove(BLOB_KEY);
    _prefs.remove(LEGACY_KEY);
    _prefs.remove("url");
    _prefs.remove("token");
  }

  memcpy(_url, saved_url, sizeof(_url));
  memcpy(_token, saved_token, sizeof(_token));
  memcpy(_used, saved_used, sizeof(_used));
  // The migrations above erased the real NVS entries (BLOB_KEY, LEGACY_KEY,
  // the legacy url/token) and wrote test tables in their place; put the
  // real bridges back so they survive past the next reboot rather than only
  // until it, same as location_store/units_store's rawPersistForTest().
  // persist() reads the now-restored _url/_token/_used and needs _open
  // still true to write.
  if (nvsOpened) {
    _open = true;
    persist();
    _prefs.remove(LEGACY_KEY);
    _prefs.remove("url");
    _prefs.remove("token");
  }
  _open = saved_open;
  Log.notice(F("mqtt_publish_store selfTest overall: %s" CR), ok ? "PASS" : "FAIL");
  return ok;
}
#endif

} // namespace mqtt_publish_store
