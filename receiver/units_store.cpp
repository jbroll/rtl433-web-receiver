#include "units_store.h"

#include <ArduinoLog.h>
#include <Preferences.h>
#include <string.h>

namespace units_store {

static Preferences _prefs;
static bool        _open = false;
static char        _blob[UNITS_STORE_MAX] = "";

bool begin() {
  if (_open) {
    return true;
  }
  _blob[0] = '\0';
  _open = _prefs.begin("units", false);
  if (!_open) {
    Log.warning(F("units store: NVS unavailable, units will not persist" CR));
    return false;
  }
  String stored = _prefs.getString("blob", "");
  strncpy(_blob, stored.c_str(), sizeof(_blob) - 1);
  _blob[sizeof(_blob) - 1] = '\0';
  Log.notice(F("units store: %s" CR), _blob[0] ? "units loaded" : "no stored units");
  return true;
}

const char* get() { return _blob; }

bool set(const char* json) {
  if (json == NULL || *json == '\0' || strlen(json) >= UNITS_STORE_MAX) {
    return false;
  }
  char previous[UNITS_STORE_MAX];
  strncpy(previous, _blob, sizeof(previous) - 1);
  previous[sizeof(previous) - 1] = '\0';
  strncpy(_blob, json, sizeof(_blob) - 1);
  _blob[sizeof(_blob) - 1] = '\0';
  if (!_open) {
    // A receiver whose NVS won't open should still let a viewer save units
    // for the session rather than answer 503 to every save.
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
  Log.notice(F("units selfTest %s: %s" CR), what, ok ? "PASS" : "FAIL");
  return ok;
}

bool selfTest() {
  bool ok = true;

  // Suppress NVS traffic across the set() calls below; set() checks the
  // size cap before its _open check, so the cap tests still work.
  bool saved_open = _open;
  _open           = false;

  _blob[0] = '\0';
  ok &= check("nothing stored reads as empty", strcmp(get(), "") == 0);

  ok &= check("set stores a blob",
              set("{\"units\":\"metric\",\"decimals\":1,\"custom\":{\"temp\":\"C\",\"rain\":\"mm\",\"wind\":\"km/h\",\"pressure\":\"hPa\"}}"));
  ok &= check("get returns the stored blob",
              strcmp(get(), "{\"units\":\"metric\",\"decimals\":1,\"custom\":{\"temp\":\"C\",\"rain\":\"mm\",\"wind\":\"km/h\",\"pressure\":\"hPa\"}}") == 0);

  ok &= check("set of a new blob replaces in place",
              set("{\"units\":\"imperial\",\"decimals\":0,\"custom\":{}}") &&
                  strcmp(get(), "{\"units\":\"imperial\",\"decimals\":0,\"custom\":{}}") == 0);

  ok &= check("a NULL blob is rejected", !set(NULL));
  ok &= check("an empty blob is rejected", !set(""));
  ok &= check("a rejected set leaves the stored blob alone",
              strcmp(get(), "{\"units\":\"imperial\",\"decimals\":0,\"custom\":{}}") == 0);

  char big[UNITS_STORE_MAX + 1];
  memset(big, '.', sizeof(big) - 1);
  big[sizeof(big) - 1] = '\0';
  ok &= check("a blob at or over the cap is rejected", !set(big));
  ok &= check("a rejected oversized set leaves the stored blob alone",
              strcmp(get(), "{\"units\":\"imperial\",\"decimals\":0,\"custom\":{}}") == 0);

  _blob[0] = '\0';
  _open    = saved_open;
  Log.notice(F("units selfTest overall: %s" CR), ok ? "PASS" : "FAIL");
  return ok;
}
#endif

} // namespace units_store
