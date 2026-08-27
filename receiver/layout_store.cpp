#include "layout_store.h"

#include <ArduinoLog.h>
#include <Preferences.h>
#include <string.h>

#include "selftest_check.h"

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
  strncpy(_blob, stored.c_str(), sizeof(_blob) - 1);
  _blob[sizeof(_blob) - 1] = '\0';
  if (_prefs.putBytes(BLOB_KEY, _blob, strlen(_blob)) > 0) {
    _prefs.remove(LEGACY_KEY);
  }
}

bool begin() {
  if (_open) {
    return true;
  }
  _blob[0] = '\0';
  _open = _prefs.begin("layout", false);
  if (!_open) {
    Log.warning(F("layout store: NVS unavailable, layout will not persist" CR));
    return false;
  }
  load();
  Log.notice(F("layout store: %s (%d free NVS entries)" CR),
             _blob[0] ? "layout loaded" : "no stored layout", (int)_prefs.freeEntries());
  return true;
}

const char* get() { return _blob; }

bool set(const char* json) {
  if (json == NULL || *json == '\0' || strlen(json) >= LAYOUT_STORE_MAX) {
    return false;
  }
  if (strcmp(_blob, json) == 0) {
    return true;
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
#define CHECK(what, ok) selfTestCheck("layout", what, ok)

bool selfTest() {
  bool ok = true;

  // Suppress NVS traffic across the set() calls below; set() checks the
  // size cap before its _open check, so the cap tests still work.
  // Snapshot the in-RAM blob too, same as location_store/units_store::selfTest():
  // begin() has already loaded the real layout from NVS by the time this
  // runs, and leaving _blob wiped or full of test data would make the next
  // GET /$layout see it instead of the real one.
  bool saved_open = _open;
  _open           = false;
  static char saved_blob[LAYOUT_STORE_MAX];
  strncpy(saved_blob, _blob, sizeof(saved_blob) - 1);
  saved_blob[sizeof(saved_blob) - 1] = '\0';

  _blob[0] = '\0';
  ok &= CHECK("nothing stored reads as empty", strcmp(get(), "") == 0);

  ok &= CHECK("set stores a blob", set("{\"grid\":{\"cols\":6,\"rows\":4}}"));
  ok &= CHECK("get returns the stored blob",
              strcmp(get(), "{\"grid\":{\"cols\":6,\"rows\":4}}") == 0);

  ok &= CHECK("set of a new blob replaces in place",
              set("{\"grid\":{\"cols\":4,\"rows\":3}}") &&
                  strcmp(get(), "{\"grid\":{\"cols\":4,\"rows\":3}}") == 0);

  ok &= CHECK("a NULL blob is rejected", !set(NULL));
  ok &= CHECK("an empty blob is rejected", !set(""));
  ok &= CHECK("a rejected set leaves the stored blob alone",
              strcmp(get(), "{\"grid\":{\"cols\":4,\"rows\":3}}") == 0);

  static char big[LAYOUT_STORE_MAX + 1];
  memset(big, '.', sizeof(big) - 1);
  big[sizeof(big) - 1] = '\0';
  ok &= CHECK("a blob at or over the cap is rejected", !set(big));
  ok &= CHECK("a rejected oversized set leaves the stored blob alone",
              strcmp(get(), "{\"grid\":{\"cols\":4,\"rows\":3}}") == 0);

  // The rest runs against NVS, so it covers the blob round trip and the
  // migration off the string this used to be written as.
  _open = _prefs.begin("layout", false);
  if (_open) {
    _prefs.remove(BLOB_KEY);
    _prefs.remove(LEGACY_KEY);

    ok &= CHECK("a stored blob survives a reload",
                set("{\"grid\":{\"cols\":5,\"rows\":2}}") &&
                    (_blob[0] = '\0', load(), true) &&
                    strcmp(get(), "{\"grid\":{\"cols\":5,\"rows\":2}}") == 0);

    _prefs.remove(BLOB_KEY);
    _prefs.putString(LEGACY_KEY, "{\"grid\":{\"cols\":9,\"rows\":9}}");
    _blob[0] = '\0';
    load();
    ok &= CHECK("a layout stored as a string is still read",
                strcmp(get(), "{\"grid\":{\"cols\":9,\"rows\":9}}") == 0);
    ok &= CHECK("reading one migrates it to a blob",
                _prefs.getBytesLength(BLOB_KEY) == strlen(get()));
    ok &= CHECK("and drops the string it came from",
                _prefs.getString(LEGACY_KEY, "").length() == 0);
    ok &= CHECK("running load() again after migrating changes nothing",
                (load(), true) && strcmp(get(), "{\"grid\":{\"cols\":9,\"rows\":9}}") == 0 &&
                    _prefs.getBytesLength(BLOB_KEY) == strlen(get()));

    // Half-migrated: the bytes write landed but a crash before remove() left
    // the legacy string key behind. load() must prefer the bytes key rather
    // than re-adopt or duplicate the stale string.
    _prefs.remove(BLOB_KEY);
    _prefs.remove(LEGACY_KEY);
    _prefs.putBytes(BLOB_KEY, "{\"grid\":{\"cols\":1,\"rows\":1}}",
                     strlen("{\"grid\":{\"cols\":1,\"rows\":1}}"));
    _prefs.putString(LEGACY_KEY, "{\"grid\":{\"cols\":9,\"rows\":9}}");
    _blob[0] = '\0';
    load();
    ok &= CHECK("a half-migrated store reads the bytes key, not the stale string",
                strcmp(get(), "{\"grid\":{\"cols\":1,\"rows\":1}}") == 0);

    _prefs.remove(BLOB_KEY);
    _prefs.remove(LEGACY_KEY);

#ifdef PREFERENCES_TRACKS_CALLS
    // Call counts are only tracked by the host test shim's Preferences; see
    // location_store::selfTest() for why this is host-only.
    Preferences::resetCallCounts();
    ok &= CHECK("first set with NVS open writes once",
                set("{\"grid\":{\"cols\":7,\"rows\":7}}") && Preferences::putBytesCallCount() == 1);
    ok &= CHECK("setting the same value again does not write",
                set("{\"grid\":{\"cols\":7,\"rows\":7}}") && Preferences::putBytesCallCount() == 1);
#endif

    _prefs.remove(BLOB_KEY);
    _prefs.remove(LEGACY_KEY);
  }

  strncpy(_blob, saved_blob, sizeof(saved_blob) - 1);
  _blob[sizeof(saved_blob) - 1] = '\0';
  _open                         = saved_open;
  Log.notice(F("layout selfTest overall: %s" CR), ok ? "PASS" : "FAIL");
  return ok;
}
#endif

} // namespace layout_store
