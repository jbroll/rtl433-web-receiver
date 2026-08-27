#include "provisioning.h"

#include <ArduinoLog.h>
#include <DNSServer.h>
#include <WebServer.h>
#include <WiFi.h>
#include <esp_random.h>

#include "ota_token_store.h"
#include "wifi_store.h"

namespace provisioning {

// Separate from web_ui.cpp's WebServer: this one only runs during
// provisioning, which always ends in a reboot before web_ui's server starts,
// so there is no port-80 conflict.
static DNSServer _dns;
static WebServer _server(80);

#define PROVISIONING_SCAN_MAX 16
#define PROVISIONING_IDLE_MS (10UL * 60UL * 1000UL)

static unsigned long _lastRequestAt = 0;

// Populated once by run(), before _server.begin(); handleRoot() renders from
// this cache instead of scanning on every request (see scanSorted()).
static String  _scanSsid[PROVISIONING_SCAN_MAX];
static int32_t _scanRssi[PROVISIONING_SCAN_MAX];
static int     _scanCount = 0;

static void apName(char* out, size_t outSize) {
  uint8_t mac[6];
  WiFi.macAddress(mac);
  snprintf(out, outSize, "rtl433-receiver-%02x%02x", mac[4], mac[5]);
}

static void writeHtmlEscaped(String& out, const char* s) {
  for (const char* p = s; *p; p++) {
    switch (*p) {
      case '&': out += "&amp;"; break;
      case '<': out += "&lt;"; break;
      case '>': out += "&gt;"; break;
      case '"': out += "&quot;"; break;
      default:  out += *p; break;
    }
  }
}

// Fills out with a fresh 32-char hex token from the hardware RNG. outSize
// must be at least OTA_TOKEN_STORE_MAX.
static void randomToken(char* out, size_t outSize) {
  uint8_t bytes[16];
  for (size_t i = 0; i < sizeof(bytes); i += 4) {
    uint32_t r = esp_random();
    memcpy(bytes + i, &r, sizeof(r));
  }
  static const char hex[] = "0123456789abcdef";
  size_t pos = 0;
  for (size_t i = 0; i < sizeof(bytes) && pos + 2 < outSize; i++) {
    out[pos++] = hex[bytes[i] >> 4];
    out[pos++] = hex[bytes[i] & 0x0f];
  }
  out[pos] = '\0';
}

// Scans and returns SSIDs by descending RSSI, deduplicated by name (the
// strongest instance of a repeated SSID across APs/channels wins).
static int scanSorted(String outSsid[], int32_t outRssi[], int maxOut) {
  int found = WiFi.scanNetworks();
  int count = 0;
  for (int i = 0; i < found && count < maxOut; i++) {
    String ssid = WiFi.SSID(i);
    if (ssid.length() == 0) {
      continue;
    }
    int existing = -1;
    for (int j = 0; j < count; j++) {
      if (outSsid[j] == ssid) {
        existing = j;
        break;
      }
    }
    if (existing >= 0) {
      if (WiFi.RSSI(i) > outRssi[existing]) {
        outRssi[existing] = WiFi.RSSI(i);
      }
      continue;
    }
    outSsid[count] = ssid;
    outRssi[count] = WiFi.RSSI(i);
    count++;
  }
  // Simple insertion sort by descending RSSI; PROVISIONING_SCAN_MAX is small.
  for (int i = 1; i < count; i++) {
    String  ssid = outSsid[i];
    int32_t rssi = outRssi[i];
    int     j    = i - 1;
    while (j >= 0 && outRssi[j] < rssi) {
      outSsid[j + 1] = outSsid[j];
      outRssi[j + 1] = outRssi[j];
      j--;
    }
    outSsid[j + 1] = ssid;
    outRssi[j + 1] = rssi;
  }
  WiFi.scanDelete();
  return count;
}

static void handleRoot() {
  _lastRequestAt = millis();
  char token[OTA_TOKEN_STORE_MAX];
  randomToken(token, sizeof(token));

  String page =
      "<!DOCTYPE html><html><head><meta charset=\"utf-8\">"
      "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
      "<title>rtl433 receiver setup</title></head><body>"
      "<h1>WiFi setup</h1>"
      "<form method=\"POST\" action=\"/save\">"
      "<label>Network<br><select name=\"ssid\">"
      "<option value=\"\">(choose or type below)</option>";
  for (int i = 0; i < _scanCount; i++) {
    page += "<option value=\"";
    writeHtmlEscaped(page, _scanSsid[i].c_str());
    page += "\">";
    writeHtmlEscaped(page, _scanSsid[i].c_str());
    page += " (" + String(_scanRssi[i]) + " dBm)</option>";
  }
  page +=
      "</select></label><br><br>"
      "<label>Or type a network name<br>"
      "<input type=\"text\" name=\"ssid_manual\" maxlength=\"32\"></label><br><br>"
      "<label>Password<br>"
      "<input type=\"password\" name=\"pass\" maxlength=\"64\"></label><br><br>"
      "<label>Update token<br>"
      "<input type=\"text\" id=\"ota_token\" name=\"token\" maxlength=\"64\" value=\"";
  page += token;
  page +=
      "\"><button type=\"button\" onclick=\"copyToken()\">Copy</button></label><br><br>"
      "<label><input type=\"checkbox\" name=\"clear_token\" value=\"1\"> Clear stored "
      "update token"
#ifdef OTA_TOKEN
      " (falls back to the build's compiled-in token, not disabled)"
#else
      " (disables OTA until a new one is set)"
#endif
      "</label><br><br>"
      "<button type=\"submit\">Save and connect</button>"
      "</form>"
      "<script>"
      "function copyToken(){"
      "var el=document.getElementById('ota_token');"
      "if(navigator.clipboard&&navigator.clipboard.writeText){"
      "navigator.clipboard.writeText(el.value).catch(function(){fallbackCopy(el);});"
      "}else{fallbackCopy(el);}"
      "}"
      "function fallbackCopy(el){el.select();document.execCommand('copy');}"
      "</script>"
      "</body></html>";

  _server.send(200, "text/html", page);
}

static void handleSave() {
  _lastRequestAt = millis();
  String manual = _server.arg("ssid_manual");
  manual.trim();
  String ssid = manual.length() > 0 ? manual : _server.arg("ssid");
  String pass = _server.arg("pass");
  String token = _server.arg("token");
  token.trim();
  bool clearToken = _server.arg("clear_token") == "1";

  if (ssid.length() == 0 || ssid.length() >= WIFI_STORE_SSID_MAX) {
    _server.send(400, "text/plain", "Choose a network and a password that fits.");
    return;
  }
  if (pass.length() == 0) {
    _server.send(400, "text/plain", "A password is required; open networks aren't supported.");
    return;
  }
  if (pass.length() >= WIFI_STORE_PASS_MAX) {
    _server.send(400, "text/plain", "Choose a network and a password that fits.");
    return;
  }
  if (token.length() >= OTA_TOKEN_STORE_MAX) {
    _server.send(400, "text/plain", "Update token is too long.");
    return;
  }

  if (!wifi_store::set(ssid.c_str(), pass.c_str())) {
    _server.send(500, "text/plain", "Could not save credentials, try again.");
    return;
  }

  if (clearToken) {
    ota_token_store::clear();
  } else if (token.length() > 0 && !ota_token_store::set(token.c_str())) {
    // Non-fatal: WiFi is the essential part of this form. A failed token
    // save just leaves OTA on its prior token (stored, or .env), same as
    // leaving the field blank.
    Log.warning(F("provisioning: could not store update token" CR));
  }

  _server.send(200, "text/html",
               "<!DOCTYPE html><html><body><h1>Saved</h1>"
               "<p>Restarting and joining the network...</p></body></html>");
  delay(500); // let the response flush before the socket goes away
  ESP.restart();
}

void run() {
  char ap[32];
  apName(ap, sizeof(ap));

  // Scan before the AP comes up: scanNetworks() forces the radio through
  // STA-mode channel-hopping, which would otherwise briefly destabilize an
  // already-joined client. STA mode here is scan-only, dropped once the scan
  // completes; WIFI_AP is set fresh afterward before softAP() brings the AP up.
  WiFi.mode(WIFI_STA);
  _scanCount = scanSorted(_scanSsid, _scanRssi, PROVISIONING_SCAN_MAX);

  WiFi.mode(WIFI_AP);
  WiFi.softAP(ap, nullptr);
  IPAddress apIP = WiFi.softAPIP();
  Log.notice(F("provisioning: AP \"%s\" up at %s" CR), ap, apIP.toString().c_str());

  _dns.start(53, "*", apIP);

  _server.on("/", HTTP_GET, handleRoot);
  _server.on("/save", HTTP_POST, handleSave);
  // Most OSes probe an arbitrary URL to detect a captive portal; answering
  // with the same page there is what makes them auto-open it.
  _server.onNotFound(handleRoot);
  _server.begin();

  // A board with stored credentials most likely landed here because the
  // network was slow to come up; a never-provisioned board has nowhere else
  // to go and stays.
  bool  restartWhenIdle = wifi_store::hasCredentials();
  _lastRequestAt = millis();
  for (;;) {
    _dns.processNextRequest();
    _server.handleClient();
    if (restartWhenIdle && millis() - _lastRequestAt > PROVISIONING_IDLE_MS) {
      Log.notice(F("provisioning: idle, restarting to retry stored WiFi" CR));
      ESP.restart();
    }
  }
}

} // namespace provisioning
