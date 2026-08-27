#include "location_store.h"

#include "blob_store.h"
#include "selftest_check.h"

namespace location_store {

static BlobStore<LOCATION_STORE_MAX> _store("location", "location");

bool        begin() { return _store.begin(); }
const char* get() { return _store.get(); }
bool        set(const char* json) { return _store.set(json); }

#ifdef FAKE_SIGNALS
#define CHECK(what, ok) selfTestCheck("location", what, ok)

bool selfTest() {
  bool ok = true;

  // Suppress NVS traffic across the set() calls below; set() checks the
  // size cap before its open check, so the cap tests still work. Snapshot
  // the in-RAM blob too: this runs against the receiver's own
  // already-loaded $location, and the "first set with NVS open writes
  // once" block below flips NVS back open to prove the real putString()
  // path, which would otherwise leave bogus test values in the device's
  // real "location" NVS entry.
  bool saved_open      = _store.openForTest();
  char saved_blob[LOCATION_STORE_MAX];
  strncpy(saved_blob, _store.blobForTest(), sizeof(saved_blob) - 1);
  saved_blob[sizeof(saved_blob) - 1] = '\0';
  _store.openForTest() = false;

  _store.blobForTest()[0] = '\0';
  ok &= CHECK("nothing stored reads as empty", strcmp(get(), "") == 0);

  ok &= CHECK("set stores a blob",
              set("{\"lat\":40.015,\"lon\":-105.2705,\"label\":\"Boulder\",\"zone\":\"America/Denver\",\"zoom\":12}"));
  ok &= CHECK("get returns the stored blob",
              strcmp(get(), "{\"lat\":40.015,\"lon\":-105.2705,\"label\":\"Boulder\",\"zone\":\"America/Denver\",\"zoom\":12}") == 0);

  ok &= CHECK("set of a new blob replaces in place",
              set("{\"lat\":0,\"lon\":0,\"label\":\"\",\"zone\":\"\",\"zoom\":11}") &&
                  strcmp(get(), "{\"lat\":0,\"lon\":0,\"label\":\"\",\"zone\":\"\",\"zoom\":11}") == 0);

  ok &= CHECK("a NULL blob is rejected", !set(NULL));
  ok &= CHECK("an empty blob is rejected", !set(""));
  ok &= CHECK("a rejected set leaves the stored blob alone",
              strcmp(get(), "{\"lat\":0,\"lon\":0,\"label\":\"\",\"zone\":\"\",\"zoom\":11}") == 0);

  char big[LOCATION_STORE_MAX + 1];
  memset(big, '.', sizeof(big) - 1);
  big[sizeof(big) - 1] = '\0';
  ok &= CHECK("a blob at or over the cap is rejected", !set(big));
  ok &= CHECK("a rejected oversized set leaves the stored blob alone",
              strcmp(get(), "{\"lat\":0,\"lon\":0,\"label\":\"\",\"zone\":\"\",\"zoom\":11}") == 0);

  // set() checks strcmp before checking open, so the dedup skip is testable
  // without opening real NVS.
  _store.openForTest() = true;
#ifdef PREFERENCES_TRACKS_CALLS
  // Call counts are only tracked by the host test shim's Preferences; the
  // real ESP32 library has no equivalent, so the dedup write-skip itself is
  // asserted here and its NVS-write-count proof stays host-only below.
  Preferences::resetCallCounts();
  ok &= CHECK("first set with NVS open writes once",
              set("{\"lat\":1,\"lon\":1,\"label\":\"x\",\"zone\":\"\",\"zoom\":1}") &&
                  Preferences::putStringCallCount() == 1);
  ok &= CHECK("setting the same value again does not write",
              set("{\"lat\":1,\"lon\":1,\"label\":\"x\",\"zone\":\"\",\"zoom\":1}") &&
                  Preferences::putStringCallCount() == 1);
#endif
  _store.openForTest() = false;

  strncpy(_store.blobForTest(), saved_blob, sizeof(saved_blob) - 1);
  _store.blobForTest()[sizeof(saved_blob) - 1] = '\0';
  _store.openForTest()                         = saved_open;
  _store.rawPersistForTest(saved_blob);
  Log.notice(F("location selfTest overall: %s" CR), ok ? "PASS" : "FAIL");
  return ok;
}
#endif

} // namespace location_store
