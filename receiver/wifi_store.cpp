#include "wifi_store.h"

#include <ArduinoLog.h>
#include <Preferences.h>

namespace wifi_store {

static Preferences _prefs;
static bool        _open = false;
static char        _ssid[WIFI_STORE_SSID_MAX] = "";
static char        _pass[WIFI_STORE_PASS_MAX] = "";

static void copyTruncated(char* dest, size_t destSize, const char* src) {
  strncpy(dest, src, destSize - 1);
  dest[destSize - 1] = '\0';
}

bool begin() {
  _open = _prefs.begin("wifi", false);
  if (!_open) {
    Log.warning(F("wifi store: NVS unavailable, credentials will not persist" CR));
    _ssid[0] = '\0';
    _pass[0] = '\0';
    return false;
  }
  String ssid = _prefs.getString("ssid", "");
  String pass = _prefs.getString("pass", "");
  copyTruncated(_ssid, sizeof(_ssid), ssid.c_str());
  copyTruncated(_pass, sizeof(_pass), pass.c_str());
  Log.notice(F("wifi store: %s" CR), hasCredentials() ? "credentials loaded" : "no stored credentials");
  return true;
}

bool hasCredentials() {
  return _ssid[0] != '\0';
}

const char* ssid() {
  return _ssid;
}

const char* password() {
  return _pass;
}

bool set(const char* ssid, const char* password) {
  if (ssid == NULL || password == NULL || ssid[0] == '\0' ||
      strlen(ssid) >= WIFI_STORE_SSID_MAX || strlen(password) >= WIFI_STORE_PASS_MAX) {
    return false;
  }
  if (!_open) {
    return false;
  }
  char prevSsid[WIFI_STORE_SSID_MAX];
  char prevPass[WIFI_STORE_PASS_MAX];
  copyTruncated(prevSsid, sizeof(prevSsid), _ssid);
  copyTruncated(prevPass, sizeof(prevPass), _pass);
  copyTruncated(_ssid, sizeof(_ssid), ssid);
  copyTruncated(_pass, sizeof(_pass), password);
  if (_prefs.putString("ssid", _ssid) > 0 &&
      (password[0] == '\0' || _prefs.putString("pass", _pass) > 0)) {
    return true;
  }
  copyTruncated(_ssid, sizeof(_ssid), prevSsid);
  copyTruncated(_pass, sizeof(_pass), prevPass);
  return false;
}

void clear() {
  _ssid[0] = '\0';
  _pass[0] = '\0';
  if (_open) {
    _prefs.remove("ssid");
    _prefs.remove("pass");
  }
}

#ifdef FAKE_SIGNALS
static bool check(const char* what, bool ok) {
  Log.notice(F("wifi_store selfTest %s: %s" CR), what, ok ? "PASS" : "FAIL");
  return ok;
}

bool selfTest() {
  bool ok = true;

  // Suppress NVS traffic across the checks below, same as alias_store::selfTest().
  bool saved_open = _open;
  _open           = false;

  _ssid[0] = '\0';
  _pass[0] = '\0';
  ok &= check("a cleared store reports no credentials", !hasCredentials());
  ok &= check("set fails while NVS is closed", !set("TestNet", "TestPass1"));

  _open = true;
  ok &= check("set stores ssid and password",
              set("TestNet", "TestPass1") && hasCredentials());
  ok &= check("ssid round-trips", strcmp(ssid(), "TestNet") == 0);
  ok &= check("password round-trips", strcmp(password(), "TestPass1") == 0);

  clear();
  ok &= check("clear removes credentials", !hasCredentials());
  ok &= check("ssid reads empty after clear", ssid()[0] == '\0');

  ok &= check("set rejects an empty ssid", !set("", "TestPass1"));

  char longSsid[WIFI_STORE_SSID_MAX + 1];
  memset(longSsid, 'a', sizeof(longSsid) - 1);
  longSsid[sizeof(longSsid) - 1] = '\0';
  ok &= check("set rejects an over-length ssid", !set(longSsid, "TestPass1"));

  char longPass[WIFI_STORE_PASS_MAX + 1];
  memset(longPass, 'b', sizeof(longPass) - 1);
  longPass[sizeof(longPass) - 1] = '\0';
  ok &= check("set rejects an over-length password", !set("TestNet", longPass));

  ok &= check("a rejected set leaves prior credentials in place", !hasCredentials());

  _ssid[0] = '\0';
  _pass[0] = '\0';
  _open    = saved_open;
  Log.notice(F("wifi_store selfTest overall: %s" CR), ok ? "PASS" : "FAIL");
  return ok;
}
#endif

} // namespace wifi_store
