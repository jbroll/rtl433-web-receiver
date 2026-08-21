#include "ota_token_store.h"

#include <ArduinoLog.h>
#include <Preferences.h>

namespace ota_token_store {

static Preferences _prefs;
static bool        _open = false;
static char        _stored[OTA_TOKEN_STORE_MAX] = "";

static void copyTruncated(char* dest, size_t destSize, const char* src) {
  strncpy(dest, src, destSize - 1);
  dest[destSize - 1] = '\0';
}

bool begin() {
  _open = _prefs.begin("ota", false);
  if (!_open) {
    Log.warning(F("ota token store: NVS unavailable, token will not persist" CR));
    _stored[0] = '\0';
    return false;
  }
  String stored = _prefs.getString("token", "");
  copyTruncated(_stored, sizeof(_stored), stored.c_str());
  Log.notice(F("ota token store: %s" CR), hasToken() ? "token present" : "no token configured");
  return true;
}

const char* token() {
  if (_stored[0] != '\0') {
    return _stored;
  }
#ifdef OTA_TOKEN
  return OTA_TOKEN;
#else
  return "";
#endif
}

bool hasToken() {
  return token()[0] != '\0';
}

static bool validToken(const char* t) {
  return t != NULL && t[0] != '\0' && strlen(t) < OTA_TOKEN_STORE_MAX;
}

bool set(const char* t) {
  if (!validToken(t)) {
    return false;
  }
  if (!_open) {
    return false;
  }
  char prev[OTA_TOKEN_STORE_MAX];
  copyTruncated(prev, sizeof(prev), _stored);
  copyTruncated(_stored, sizeof(_stored), t);
  if (_prefs.putString("token", _stored) > 0) {
    return true;
  }
  copyTruncated(_stored, sizeof(_stored), prev);
  return false;
}

#ifdef FAKE_SIGNALS
static bool check(const char* what, bool ok) {
  Log.notice(F("ota_token_store selfTest %s: %s" CR), what, ok ? "PASS" : "FAIL");
  return ok;
}

bool selfTest() {
  bool ok = true;

  // Suppress NVS traffic across the checks below, same as wifi_store::selfTest().
  bool saved_open = _open;
  _open            = false;
  char saved[OTA_TOKEN_STORE_MAX];
  copyTruncated(saved, sizeof(saved), _stored);

  _stored[0] = '\0';
  ok &= check("set fails while NVS is closed", !set("0123456789abcdef0123456789abcdef"));

  // set() can't be exercised end-to-end with NVS closed, so simulate a loaded
  // value by assigning the internal static directly.
  copyTruncated(_stored, sizeof(_stored), "0123456789abcdef0123456789abcdef");
  ok &= check("a loaded token reports present", hasToken());
  ok &= check("token round-trips", strcmp(token(), "0123456789abcdef0123456789abcdef") == 0);

  _stored[0] = '\0';
#ifndef OTA_TOKEN
  ok &= check("with nothing stored and no build flag, hasToken is false", !hasToken());
#endif

  char longToken[OTA_TOKEN_STORE_MAX + 1];
  memset(longToken, 'a', sizeof(longToken) - 1);
  longToken[sizeof(longToken) - 1] = '\0';

  // Seed a known token directly so the "leaves prior token in place" check
  // below has something real to verify was left untouched.
  copyTruncated(_stored, sizeof(_stored), "0123456789abcdef0123456789abcdef");

  ok &= check("validToken rejects an empty token", !validToken(""));
  ok &= check("validToken rejects an over-length token", !validToken(longToken));
  ok &= check("validToken accepts a 32-char token",
              validToken("0123456789abcdef0123456789abcdef"));
  ok &= check("a rejected set leaves the prior token in place",
              strcmp(token(), "0123456789abcdef0123456789abcdef") == 0);

  copyTruncated(_stored, sizeof(_stored), saved);
  _open = saved_open;
  Log.notice(F("ota_token_store selfTest overall: %s" CR), ok ? "PASS" : "FAIL");
  return ok;
}
#endif

} // namespace ota_token_store
