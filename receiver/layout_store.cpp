#include "layout_store.h"

#include <ArduinoLog.h>
#include <Preferences.h>
#include <string.h>

namespace layout_store {

static Preferences _prefs;
static bool        _open = false;
static char        _blob[LAYOUT_STORE_MAX] = "";

bool begin() {
  _blob[0] = '\0';
  _open = _prefs.begin("layout", false);
  if (!_open) {
    Log.warning(F("layout store: NVS unavailable, layout will not persist" CR));
    return false;
  }
  String stored = _prefs.getString("blob", "");
  strncpy(_blob, stored.c_str(), sizeof(_blob) - 1);
  _blob[sizeof(_blob) - 1] = '\0';
  Log.notice(F("layout store: %s" CR), _blob[0] ? "layout loaded" : "no stored layout");
  return true;
}

const char* get() { return _blob; }

bool set(const char* json) {
  if (json == NULL || *json == '\0' || strlen(json) >= LAYOUT_STORE_MAX) {
    return false;
  }
  char previous[LAYOUT_STORE_MAX];
  strncpy(previous, _blob, sizeof(previous) - 1);
  previous[sizeof(previous) - 1] = '\0';
  strncpy(_blob, json, sizeof(_blob) - 1);
  _blob[sizeof(_blob) - 1] = '\0';
  if (!_open) {
    // A receiver whose NVS won't open should still let a viewer save a
    // layout for the session rather than answer 503 to every save.
    return true;
  }
  if (_prefs.putString("blob", _blob) > 0) {
    return true;
  }
  strncpy(_blob, previous, sizeof(_blob) - 1);
  _blob[sizeof(_blob) - 1] = '\0';
  return false;
}

#ifdef FAKE_SIGNALS
static bool check(const char* what, bool ok) {
  Log.notice(F("layout selfTest %s: %s" CR), what, ok ? "PASS" : "FAIL");
  return ok;
}

bool selfTest() {
  bool ok = true;

  bool saved_open = _open;

  _blob[0] = '\0';
  ok &= check("nothing stored reads as empty", strcmp(get(), "") == 0);

  ok &= check("set stores a blob", set("{\"grid\":{\"cols\":6,\"rows\":4}}"));
  ok &= check("get returns the stored blob",
              strcmp(get(), "{\"grid\":{\"cols\":6,\"rows\":4}}") == 0);

  ok &= check("set of a new blob replaces in place",
              set("{\"grid\":{\"cols\":4,\"rows\":3}}") &&
                  strcmp(get(), "{\"grid\":{\"cols\":4,\"rows\":3}}") == 0);

  ok &= check("a NULL blob is rejected", !set(NULL));
  ok &= check("an empty blob is rejected", !set(""));
  ok &= check("a rejected set leaves the stored blob alone",
              strcmp(get(), "{\"grid\":{\"cols\":4,\"rows\":3}}") == 0);

  char big[LAYOUT_STORE_MAX + 1];
  memset(big, '.', sizeof(big) - 1);
  big[sizeof(big) - 1] = '\0';
  ok &= check("a blob at or over the cap is rejected", !set(big));
  ok &= check("a rejected oversized set leaves the stored blob alone",
              strcmp(get(), "{\"grid\":{\"cols\":4,\"rows\":3}}") == 0);

  _blob[0] = '\0';
  _open    = saved_open;
  Log.notice(F("layout selfTest overall: %s" CR), ok ? "PASS" : "FAIL");
  return ok;
}
#endif

} // namespace layout_store
