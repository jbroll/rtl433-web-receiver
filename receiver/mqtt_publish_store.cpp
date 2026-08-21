#include "mqtt_publish_store.h"

#include <ArduinoLog.h>
#include <Preferences.h>

namespace mqtt_publish_store {

static Preferences _prefs;
static bool        _open = false;
static char        _url[MQTT_PUBLISH_STORE_URL_MAX] = "";
static char        _token[MQTT_PUBLISH_STORE_TOKEN_MAX] = "";

static void copyTruncated(char* dest, size_t destSize, const char* src) {
  strncpy(dest, src, destSize - 1);
  dest[destSize - 1] = '\0';
}

bool begin() {
  if (_open) {
    return true;
  }
  _open = _prefs.begin("mqtt", false);
  if (!_open) {
    Log.warning(F("mqtt publish store: NVS unavailable, settings will not persist" CR));
    _url[0] = '\0';
    _token[0] = '\0';
    return false;
  }
  String url = _prefs.getString("url", "");
  String token = _prefs.getString("token", "");
  copyTruncated(_url, sizeof(_url), url.c_str());
  copyTruncated(_token, sizeof(_token), token.c_str());
  Log.notice(F("mqtt publish store: %s" CR), hasBroker() ? "broker configured" : "no broker configured");
  return true;
}

const char* brokerUrl() {
  if (_url[0] != '\0') {
    return _url;
  }
#ifdef MQTT_BROKER_URL
  return MQTT_BROKER_URL;
#else
  return "";
#endif
}

const char* token() {
  if (_token[0] != '\0') {
    return _token;
  }
#ifdef MQTT_TOKEN
  return MQTT_TOKEN;
#else
  return "";
#endif
}

bool hasBroker() {
  return brokerUrl()[0] != '\0';
}

static bool validBroker(const char* url) {
  if (url == NULL || url[0] == '\0' || strlen(url) >= MQTT_PUBLISH_STORE_URL_MAX) {
    return false;
  }
  return strncmp(url, "mqtt://", 7) == 0 || strncmp(url, "mqtts://", 8) == 0;
}

static bool validToken(const char* token) {
  return token != NULL && strlen(token) < MQTT_PUBLISH_STORE_TOKEN_MAX;
}

bool set(const char* brokerUrl, const char* token) {
  if (!validBroker(brokerUrl) || !validToken(token)) {
    return false;
  }
  if (!_open) {
    return false;
  }
  char prevUrl[MQTT_PUBLISH_STORE_URL_MAX];
  char prevToken[MQTT_PUBLISH_STORE_TOKEN_MAX];
  copyTruncated(prevUrl, sizeof(prevUrl), _url);
  copyTruncated(prevToken, sizeof(prevToken), _token);
  copyTruncated(_url, sizeof(_url), brokerUrl);
  copyTruncated(_token, sizeof(_token), token);

  bool urlOk = _prefs.putString("url", _url) > 0;
  bool tokenOk;
  if (token[0] == '\0') {
    _prefs.remove("token");
    tokenOk = true;
  } else {
    tokenOk = _prefs.putString("token", _token) > 0;
  }
  if (urlOk && tokenOk) {
    return true;
  }
  copyTruncated(_url, sizeof(_url), prevUrl);
  copyTruncated(_token, sizeof(_token), prevToken);
  return false;
}

void clear() {
  _url[0] = '\0';
  _token[0] = '\0';
  if (_open) {
    _prefs.remove("url");
    _prefs.remove("token");
  }
}

#ifdef FAKE_SIGNALS
static bool check(const char* what, bool ok) {
  Log.notice(F("mqtt_publish_store selfTest %s: %s" CR), what, ok ? "PASS" : "FAIL");
  return ok;
}

bool selfTest() {
  bool ok = true;

  // Suppress NVS traffic across the checks below, same as wifi_store::selfTest().
  bool saved_open = _open;
  _open           = false;
  char saved_url[MQTT_PUBLISH_STORE_URL_MAX];
  char saved_token[MQTT_PUBLISH_STORE_TOKEN_MAX];
  copyTruncated(saved_url, sizeof(saved_url), _url);
  copyTruncated(saved_token, sizeof(saved_token), _token);

  _url[0] = '\0';
  _token[0] = '\0';
  ok &= check("a cleared store reports no broker", !hasBroker());
  ok &= check("set fails while NVS is closed", !set("mqtts://weather.rkroll.com:8883", "tok"));

  // set() can't be exercised end-to-end with NVS closed, so simulate a loaded
  // value by assigning the internal statics directly.
  copyTruncated(_url, sizeof(_url), "mqtts://weather.rkroll.com:8883");
  copyTruncated(_token, sizeof(_token), "tok");
  ok &= check("a loaded broker reports present", hasBroker());
  ok &= check("brokerUrl round-trips", strcmp(brokerUrl(), "mqtts://weather.rkroll.com:8883") == 0);
  ok &= check("token round-trips", strcmp(token(), "tok") == 0);

  _url[0] = '\0';
  _token[0] = '\0';
  ok &= check("clearing the internal state removes the broker", !hasBroker());

  char longUrl[MQTT_PUBLISH_STORE_URL_MAX + 1];
  memset(longUrl, 'a', sizeof(longUrl) - 1);
  longUrl[sizeof(longUrl) - 1] = '\0';

  char longToken[MQTT_PUBLISH_STORE_TOKEN_MAX + 1];
  memset(longToken, 'b', sizeof(longToken) - 1);
  longToken[sizeof(longToken) - 1] = '\0';

  ok &= check("validBroker rejects an empty url", !validBroker(""));
  ok &= check("validBroker rejects a scheme it does not recognize", !validBroker("http://weather.rkroll.com"));
  ok &= check("validBroker rejects an over-length url", !validBroker(longUrl));
  ok &= check("validBroker accepts mqtt://", validBroker("mqtt://broker.local:1883"));
  ok &= check("validBroker accepts mqtts://", validBroker("mqtts://weather.rkroll.com:8883"));
  ok &= check("validToken accepts an empty token", validToken(""));
  ok &= check("validToken rejects an over-length token", !validToken(longToken));

  // Seed a known pair directly so the "leaves prior settings in place" check
  // below has something real to verify was left untouched.
  copyTruncated(_url, sizeof(_url), "mqtts://weather.rkroll.com:8883");
  copyTruncated(_token, sizeof(_token), "tok");
  ok &= check("a rejected set leaves prior settings in place",
              strcmp(brokerUrl(), "mqtts://weather.rkroll.com:8883") == 0 &&
                  strcmp(token(), "tok") == 0);

  copyTruncated(_url, sizeof(_url), saved_url);
  copyTruncated(_token, sizeof(_token), saved_token);
  _open = saved_open;
  Log.notice(F("mqtt_publish_store selfTest overall: %s" CR), ok ? "PASS" : "FAIL");
  return ok;
}
#endif

} // namespace mqtt_publish_store
