#pragma once

#include <ArduinoLog.h>
#include <Preferences.h>
#include <string.h>

// Shared shape for a store that holds one opaque JSON blob under one NVS
// string key: location_store and units_store are line-for-line identical
// apart from capacity, namespace and log text. layout_store does not use
// this: it persists before adopting to avoid a second CAP-sized buffer on an
// HTTP handler's stack, and needs the putBytes/legacy-key migration besides.
template <size_t CAP>
class BlobStore {
 public:
  BlobStore(const char* nvsNamespace, const char* label) : _ns(nvsNamespace), _label(label) {}

  bool begin() {
    if (_open) {
      return true;
    }
    _blob[0] = '\0';
    _open = _prefs.begin(_ns, false);
    if (!_open) {
      Log.warning(F("%s store: NVS unavailable, %s will not persist" CR), _label, _label);
      return false;
    }
    String stored = _prefs.getString("blob", "");
    strncpy(_blob, stored.c_str(), sizeof(_blob) - 1);
    _blob[sizeof(_blob) - 1] = '\0';
    Log.notice(F("%s store: %s (%d free NVS entries)" CR), _label,
               _blob[0] ? "loaded" : "no stored value", (int)_prefs.freeEntries());
    return true;
  }

  const char* get() const { return _blob; }

  bool set(const char* json) {
    if (json == NULL || *json == '\0' || strlen(json) >= CAP) {
      return false;
    }
    if (strcmp(_blob, json) == 0) {
      return true;
    }
    char previous[CAP];
    strncpy(previous, _blob, sizeof(previous) - 1);
    previous[sizeof(previous) - 1] = '\0';
    strncpy(_blob, json, sizeof(_blob) - 1);
    _blob[sizeof(_blob) - 1] = '\0';
    if (!_open) {
      // A receiver whose NVS won't open should still let a viewer save a
      // value for the session rather than answer 503 to every save.
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
  bool& openForTest() { return _open; }
  char* blobForTest() { return _blob; }
  // Writes value straight to the "blob" key via putString(), bypassing
  // set()'s NULL/empty rejection and same-value skip. selfTest() flips
  // openForTest() to true to prove set()'s real-NVS write path, which
  // writes bogus test values into the store's real NVS entry on a live
  // device; this is how it puts back whatever was actually stored there
  // before, including "nothing stored" (value == "").
  void rawPersistForTest(const char* value) {
    if (_open) {
      if (value[0] == '\0') {
        _prefs.remove("blob");
      } else {
        _prefs.putString("blob", value);
      }
    }
  }
#endif

 private:
  const char* _ns;
  const char* _label;
  Preferences _prefs;
  bool        _open = false;
  char        _blob[CAP] = "";
};
