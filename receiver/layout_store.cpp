#include "layout_store.h"

#include <ArduinoLog.h>
#include <Preferences.h>
#include <string.h>

namespace layout_store {

// An NVS string has to fit one page's free run, which on a receiver whose
// nvs partition already holds the radio calibration meant about 2.7 KB in
// practice, not the 4000 nvs_set_str() documents. A blob is chunked across
// pages instead, so the only limit left is the store's own cap. LEGACY_KEY is
// the string this used to be written as.
#define BLOB_KEY   "json"
#define LEGACY_KEY "blob"

static Preferences _prefs;
static bool        _open = false;
static char        _blob[LAYOUT_STORE_MAX] = "";

static void load() {
  size_t n = _prefs.getBytesLength(BLOB_KEY);
  if (n > 0 && n < sizeof(_blob)) {
    _prefs.getBytes(BLOB_KEY, _blob, n);
    _blob[n] = '\0';
    return;
  }
  String stored = _prefs.getString(LEGACY_KEY, "");
  if (stored.length() == 0) {
    return;
  }
  strncpy(_blob, stored.c_str(), sizeof(_blob) - 1);
  _blob[sizeof(_blob) - 1] = '\0';
  if (_prefs.putBytes(BLOB_KEY, _blob, strlen(_blob)) > 0) {
    _prefs.remove(LEGACY_KEY);
  }
}

bool begin() {
  _blob[0] = '\0';
  _open = _prefs.begin("layout", false);
  if (!_open) {
    Log.warning(F("layout store: NVS unavailable, layout will not persist" CR));
    return false;
  }
  load();
  Log.notice(F("layout store: %s" CR), _blob[0] ? "layout loaded" : "no stored layout");
  return true;
}

const char* get() { return _blob; }

bool set(const char* json) {
  if (json == NULL || *json == '\0' || strlen(json) >= LAYOUT_STORE_MAX) {
    return false;
  }
  // Persist first, then adopt: a failed write leaves the stored blob alone
  // without needing a second LAYOUT_STORE_MAX buffer on the caller's stack.
  size_t len = strlen(json);
  if (_open && _prefs.putBytes(BLOB_KEY, json, len) != len) {
    return false;
  }
  // A receiver whose NVS won't open should still let a viewer save a layout
  // for the session rather than answer 503 to every save.
  strncpy(_blob, json, sizeof(_blob) - 1);
  _blob[sizeof(_blob) - 1] = '\0';
  return true;
}

#ifdef FAKE_SIGNALS
static bool check(const char* what, bool ok) {
  Log.notice(F("layout selfTest %s: %s" CR), what, ok ? "PASS" : "FAIL");
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

  static char big[LAYOUT_STORE_MAX + 1];
  memset(big, '.', sizeof(big) - 1);
  big[sizeof(big) - 1] = '\0';
  ok &= check("a blob at or over the cap is rejected", !set(big));
  ok &= check("a rejected oversized set leaves the stored blob alone",
              strcmp(get(), "{\"grid\":{\"cols\":4,\"rows\":3}}") == 0);

  // The rest runs against NVS, so it covers the blob round trip and the
  // migration off the string this used to be written as.
  _open = _prefs.begin("layout", false);
  if (_open) {
    _prefs.remove(BLOB_KEY);
    _prefs.remove(LEGACY_KEY);

    ok &= check("a stored blob survives a reload",
                set("{\"grid\":{\"cols\":5,\"rows\":2}}") &&
                    (_blob[0] = '\0', load(), true) &&
                    strcmp(get(), "{\"grid\":{\"cols\":5,\"rows\":2}}") == 0);

    _prefs.remove(BLOB_KEY);
    _prefs.putString(LEGACY_KEY, "{\"grid\":{\"cols\":9,\"rows\":9}}");
    _blob[0] = '\0';
    load();
    ok &= check("a layout stored as a string is still read",
                strcmp(get(), "{\"grid\":{\"cols\":9,\"rows\":9}}") == 0);
    ok &= check("reading one migrates it to a blob",
                _prefs.getBytesLength(BLOB_KEY) == strlen(get()));
    ok &= check("and drops the string it came from",
                _prefs.getString(LEGACY_KEY, "").length() == 0);

    _prefs.remove(BLOB_KEY);
    _prefs.remove(LEGACY_KEY);
  }

  _blob[0] = '\0';
  _open    = saved_open;
  Log.notice(F("layout selfTest overall: %s" CR), ok ? "PASS" : "FAIL");
  return ok;
}
#endif

} // namespace layout_store
