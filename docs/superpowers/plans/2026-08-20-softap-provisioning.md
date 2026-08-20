# SoftAP WiFi Provisioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a receiver join WiFi without baked-in credentials: a SoftAP captive
portal stores SSID/password in NVS on first boot (or after a long BOOT-button
press), and the `.env` build-time flags become an optional dev/CI shortcut.

**Architecture:** Two new `Preferences`-backed/network modules follow existing
patterns in `receiver/`: `wifi_store` (credential persistence, modeled on
`alias_store`/`tz_store`) and `provisioning` (SoftAP + DNS + captive-portal
`WebServer`, a second, short-lived `WebServer` instance separate from
`web_ui.cpp`'s). `WebReceiver.ino::setup()` is rewired to try stored
credentials, then `.env` macros, then provisioning, in that order.

**Tech Stack:** Arduino/ESP32 (PlatformIO, `espressif32@6.1.0`), `WiFi.h`,
`DNSServer.h`, `WebServer.h`, `Preferences.h` — all already available via the
Arduino-ESP32 core, no new `lib_deps`.

## Global Constraints

- Full design source: `docs/superpowers/specs/2026-08-20-softap-provisioning-design.md`.
- `wifi_store` follows the `Preferences`-backed module pattern used by
  `tz_store`/`alias_store`: NVS namespace `"wifi"`, keys `ssid`/`pass`.
- SSID buffer: 32 bytes (802.11 limit) + null terminator = 33. Password
  buffer: 64 bytes (WPA2 limit) + null terminator = 65.
- `provisioning::run()` blocks until credentials are saved, then
  `ESP.restart()`. It never returns during normal operation.
- No host tests for either module: this repo's `Preferences`-backed stores
  and anything touching a real WiFi radio have no host test target yet (see
  `receiver/docs/development.md`'s "Testing without a radio" section and
  ROADMAP's unstarted "move `signal_store`/`alias_store` self-tests to a
  PlatformIO `native` environment" item). Verification is `wifi_store::selfTest()`
  gated behind `FAKE_SIGNALS` (compiled and reasoned about, same as
  `alias_store::selfTest()` today) plus `pio run -e esp32s3-generic` compiling
  clean, plus a manual hardware checklist added to `receiver/docs/install.md`.
- Out of scope (do not implement): WPA2-Enterprise/open-network targets, a
  provisioning timeout/auto-fallback, or any change to `web_ui.cpp`'s existing
  `WebServer` usage.

---

## File Structure

- `receiver/wifi_store.h` / `.cpp` — new. Credential persistence.
- `receiver/provisioning.h` / `.cpp` — new. SoftAP + captive portal.
- `receiver/WebReceiver.ino` — modified. Boot flow rewiring, `connectWiFi`/
  `serviceWiFi` retargeted from `WIFI_SSID`/`WIFI_PASSWORD` macros to runtime
  values.
- `receiver/docs/install.md` — modified. `.env` becomes optional; add SoftAP
  configure path and hardware verification checklist.
- `receiver/docs/user-manual.md` — modified. Document the provisioning portal
  and the long-press-to-reset behavior.
- `receiver/docs/architecture.md` — modified. Note the new `wifi` NVS
  namespace alongside the existing `nvs.net80211`/`alias`/`tz` entries.
- `receiver/docs/backlog.md` — modified. Remove the "WiFi credentials are
  compiled into the image" section (this plan closes it).
- `ROADMAP.md` — modified. Remove the SoftAP provisioning bullet under Goal 2
  and the "WiFi credentials baked into the image" open gap under Baseline.

---

## Task 1: `wifi_store` module

**Files:**
- Create: `receiver/wifi_store.h`
- Create: `receiver/wifi_store.cpp`

**Model:** `sonnet` — new module from prose spec, follows an existing pattern but needs judgment on edge cases (buffer limits, NVS-closed handling).

**Interfaces:**
- Produces (used by Task 2 and Task 3):
  - `bool wifi_store::begin()`
  - `bool wifi_store::hasCredentials()`
  - `const char* wifi_store::ssid()`
  - `const char* wifi_store::password()`
  - `bool wifi_store::set(const char* ssid, const char* password)`
  - `void wifi_store::clear()`
  - `#define WIFI_STORE_SSID_MAX 33` (32 + null)
  - `#define WIFI_STORE_PASS_MAX 65` (64 + null)
  - `#ifdef FAKE_SIGNALS bool wifi_store::selfTest();`

- [ ] **Step 1: Write `receiver/wifi_store.h`**

```cpp
#pragma once

#include <Arduino.h>

// 802.11 SSID limit is 32 bytes; WPA2 password limit is 64 bytes. Both plus a
// null terminator.
#define WIFI_STORE_SSID_MAX 33
#define WIFI_STORE_PASS_MAX 65

namespace wifi_store {
bool        begin();          // opens the "wifi" NVS namespace
bool        hasCredentials();
const char* ssid();
const char* password();
bool        set(const char* ssid, const char* password);
void        clear();
#ifdef FAKE_SIGNALS
bool selfTest();
#endif
} // namespace wifi_store
```

- [ ] **Step 2: Write `receiver/wifi_store.cpp`**

```cpp
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
```

- [ ] **Step 3: Compile check**

Run: `cd receiver && pio run -e esp32s3-generic 2>&1 | tail -40`

`wifi_store.cpp` is picked up automatically by `src_filter = +<*>` in
`platformio.ini` even though nothing includes it yet — it just needs to
compile standalone. Expected: `SUCCESS` (or a normal firmware build with no
errors referencing `wifi_store`).

- [ ] **Step 4: Commit**

```bash
git add receiver/wifi_store.h receiver/wifi_store.cpp
git commit -m "feat(receiver): add wifi_store NVS credential module"
```

---

## Task 2: `provisioning` module

**Files:**
- Create: `receiver/provisioning.h`
- Create: `receiver/provisioning.cpp`

**Model:** `sonnet` — SoftAP/DNS/WebServer wiring from prose, judgment needed on HTML generation and dedup/sort logic.

**Interfaces:**
- Consumes (from Task 1): `wifi_store::set(const char*, const char*)`,
  `WIFI_STORE_SSID_MAX`, `WIFI_STORE_PASS_MAX`.
- Produces (used by Task 3): `void provisioning::run();`

- [ ] **Step 1: Write `receiver/provisioning.h`**

```cpp
#pragma once

namespace provisioning {
// Blocks until credentials are saved via the captive portal, then reboots.
// Never returns during normal operation.
void run();
} // namespace provisioning
```

- [ ] **Step 2: Write `receiver/provisioning.cpp`**

```cpp
#include "provisioning.h"

#include <ArduinoLog.h>
#include <DNSServer.h>
#include <WebServer.h>
#include <WiFi.h>

#include "wifi_store.h"

namespace provisioning {

// Separate from web_ui.cpp's WebServer: this one only runs during
// provisioning, which always ends in a reboot before web_ui's server starts,
// so there is no port-80 conflict.
static DNSServer _dns;
static WebServer _server(80);

#define PROVISIONING_SCAN_MAX 16

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
  String   ssids[PROVISIONING_SCAN_MAX];
  int32_t  rssis[PROVISIONING_SCAN_MAX];
  int      count = scanSorted(ssids, rssis, PROVISIONING_SCAN_MAX);

  String page =
      "<!DOCTYPE html><html><head><meta charset=\"utf-8\">"
      "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
      "<title>rtl433 receiver setup</title></head><body>"
      "<h1>WiFi setup</h1>"
      "<form method=\"POST\" action=\"/save\">"
      "<label>Network<br><select name=\"ssid\">"
      "<option value=\"\">(choose or type below)</option>";
  for (int i = 0; i < count; i++) {
    page += "<option value=\"";
    writeHtmlEscaped(page, ssids[i].c_str());
    page += "\">";
    writeHtmlEscaped(page, ssids[i].c_str());
    page += " (" + String(rssis[i]) + " dBm)</option>";
  }
  page +=
      "</select></label><br><br>"
      "<label>Or type a network name<br>"
      "<input type=\"text\" name=\"ssid_manual\" maxlength=\"32\"></label><br><br>"
      "<label>Password<br>"
      "<input type=\"password\" name=\"pass\" maxlength=\"64\"></label><br><br>"
      "<button type=\"submit\">Save and connect</button>"
      "</form></body></html>";

  _server.send(200, "text/html", page);
}

static void handleSave() {
  String manual = _server.arg("ssid_manual");
  String ssid   = manual.length() > 0 ? manual : _server.arg("ssid");
  String pass   = _server.arg("pass");

  if (ssid.length() == 0 || ssid.length() >= WIFI_STORE_SSID_MAX ||
      pass.length() >= WIFI_STORE_PASS_MAX) {
    _server.send(400, "text/plain", "Choose a network and a password that fits.");
    return;
  }

  if (!wifi_store::set(ssid.c_str(), pass.c_str())) {
    _server.send(500, "text/plain", "Could not save credentials, try again.");
    return;
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

  for (;;) {
    _dns.processNextRequest();
    _server.handleClient();
  }
}

} // namespace provisioning
```

- [ ] **Step 3: Compile check**

Run: `cd receiver && pio run -e esp32s3-generic 2>&1 | tail -40`

Expected: `SUCCESS`. `provisioning.cpp` is not yet called from `WebReceiver.ino`
(that's Task 3), so this only confirms it compiles standalone against
`wifi_store.h` and the ESP32 WiFi/DNSServer/WebServer headers.

- [ ] **Step 4: Commit**

```bash
git add receiver/provisioning.h receiver/provisioning.cpp
git commit -m "feat(receiver): add SoftAP captive-portal provisioning module"
```

---

## Task 3: Boot flow integration

**Files:**
- Modify: `receiver/WebReceiver.ino`

**Model:** `sonnet` — rewires an existing hot path (WiFi connect/reconnect) across multiple functions; needs care not to break `serviceWiFi()`'s reconnect loop.

**Interfaces:**
- Consumes (from Task 1 and Task 2): `wifi_store::begin()`,
  `wifi_store::hasCredentials()`, `wifi_store::ssid()`,
  `wifi_store::password()`, `wifi_store::set()`, `wifi_store::clear()`,
  `WIFI_STORE_SSID_MAX`, `WIFI_STORE_PASS_MAX`, `provisioning::run()`.

- [ ] **Step 1: Add includes and drop the `.env`-required error**

In `receiver/WebReceiver.ino`, replace:

```cpp
#include "alias_store.h"
#include "device_hooks.h"
#include "health_store.h"
#include "radio_health.h"
#include "signal_store.h"
#include "tz_store.h"
#include "web_ui.h"
#include "esp_core_dump.h"  // esp_core_dump_image_check()
#include "esp_system.h"     // esp_reset_reason()

#if !defined(WIFI_SSID) || !defined(WIFI_PASSWORD)
#  error ".env is missing or incomplete - copy .env.example to .env and fill it in"
#endif
```

with:

```cpp
#include "alias_store.h"
#include "device_hooks.h"
#include "health_store.h"
#include "provisioning.h"
#include "radio_health.h"
#include "signal_store.h"
#include "tz_store.h"
#include "web_ui.h"
#include "wifi_store.h"
#include "esp_core_dump.h"  // esp_core_dump_image_check()
#include "esp_system.h"     // esp_reset_reason()
```

Also update the file's top comment (currently `Copy .env.example to .env and
fill it in before building.`) to:

```
 rtl_433_ESP receiver with a live web page.

 First boot (or after a long BOOT-button press) opens a SoftAP captive
 portal to collect WiFi credentials; see receiver/docs/install.md. Copying
 .env.example to .env is an optional dev/CI shortcut instead.
*/
```

- [ ] **Step 2: Retarget `connectWiFi`/`serviceWiFi` to runtime credentials**

Replace:

```cpp
static void connectWiFi() {
  Log.notice(F("WiFi connecting to %s" CR), WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < WIFI_CONNECT_MS) {
    delay(200);
  }
  if (wifiReady()) {
    Log.notice(F("WiFi connected: %s" CR), WiFi.localIP().toString().c_str());
    startMDNS();
    startTime();
    signal_store::setSource(mdnsHostname());
    wifiWasConnected = true;
  } else {
    Log.warning(F("WiFi connect failed, decoding continues" CR));
  }
}

static void serviceWiFi() {
  static unsigned long lastAttempt = 0;
  if (wifiReady()) {
    if (!wifiWasConnected) {
      wifiWasConnected = true;
      Log.notice(F("WiFi up: %s" CR), WiFi.localIP().toString().c_str());
      startMDNS();
      startTime();
      signal_store::setSource(mdnsHostname());
    }
    return;
  }
  if (wifiWasConnected) {
    wifiWasConnected = false;
    Log.warning(F("WiFi dropped" CR));
  }
  if (millis() - lastAttempt < WIFI_RETRY_MS) {
    return;
  }
  lastAttempt = millis();
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}
```

with:

```cpp
// Set by connectWiFi() and re-used by serviceWiFi()'s reconnect loop, since
// the active credentials can come from wifi_store or the .env macros.
static char _activeSsid[WIFI_STORE_SSID_MAX] = "";
static char _activePass[WIFI_STORE_PASS_MAX] = "";

static void connectWiFi(const char* ssid, const char* pass) {
  strncpy(_activeSsid, ssid, sizeof(_activeSsid) - 1);
  _activeSsid[sizeof(_activeSsid) - 1] = '\0';
  strncpy(_activePass, pass, sizeof(_activePass) - 1);
  _activePass[sizeof(_activePass) - 1] = '\0';

  Log.notice(F("WiFi connecting to %s" CR), _activeSsid);
  WiFi.mode(WIFI_STA);
  WiFi.begin(_activeSsid, _activePass);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < WIFI_CONNECT_MS) {
    delay(200);
  }
  if (wifiReady()) {
    Log.notice(F("WiFi connected: %s" CR), WiFi.localIP().toString().c_str());
    startMDNS();
    startTime();
    signal_store::setSource(mdnsHostname());
    wifiWasConnected = true;
  } else {
    Log.warning(F("WiFi connect failed" CR));
  }
}

static void serviceWiFi() {
  static unsigned long lastAttempt = 0;
  if (wifiReady()) {
    if (!wifiWasConnected) {
      wifiWasConnected = true;
      Log.notice(F("WiFi up: %s" CR), WiFi.localIP().toString().c_str());
      startMDNS();
      startTime();
      signal_store::setSource(mdnsHostname());
    }
    return;
  }
  if (wifiWasConnected) {
    wifiWasConnected = false;
    Log.warning(F("WiFi dropped" CR));
  }
  if (millis() - lastAttempt < WIFI_RETRY_MS) {
    return;
  }
  lastAttempt = millis();
  WiFi.disconnect();
  WiFi.begin(_activeSsid, _activePass);
}
```

- [ ] **Step 3: Rewire `setup()`'s boot sequence**

Replace this line in `setup()`:

```cpp
  connectWiFi();
```

(it currently sits right after the boot log line and before
`signal_store::setSource(mdnsHostname());`) with:

```cpp
  wifi_store::begin();
  if (bootButtonHeld()) {
    Log.notice(F("BOOT button held: clearing stored WiFi credentials" CR));
    wifi_store::clear();
  }

  if (wifi_store::hasCredentials()) {
    connectWiFi(wifi_store::ssid(), wifi_store::password());
  }
#ifdef WIFI_SSID
  else {
    connectWiFi(WIFI_SSID, WIFI_PASSWORD);
    if (wifiReady()) {
      wifi_store::set(WIFI_SSID, WIFI_PASSWORD);
    }
  }
#endif
  if (!wifiReady()) {
    provisioning::run(); // blocks; ends in ESP.restart() once configured
  }
```

Add the `bootButtonHeld()` helper above `setup()` (near `connectWiFi`/
`serviceWiFi`):

```cpp
#define BOOT_BUTTON_GPIO 0
#define BOOT_HOLD_MS     3000

// GPIO0 is the Freenove ESP32-S3 board's BOOT button, pulled up on-board.
// Held low continuously for BOOT_HOLD_MS at boot clears stored WiFi
// credentials so the device re-enters provisioning. Returns immediately
// (no delay) if the button is not held at boot.
static bool bootButtonHeld() {
  pinMode(BOOT_BUTTON_GPIO, INPUT_PULLUP);
  if (digitalRead(BOOT_BUTTON_GPIO) != LOW) {
    return false;
  }
  unsigned long start = millis();
  while (digitalRead(BOOT_BUTTON_GPIO) == LOW) {
    if (millis() - start >= BOOT_HOLD_MS) {
      return true;
    }
    delay(20);
  }
  return false;
}
```

This check must run before anything else in `setup()` that touches shared
hardware, but after `wifi_store::begin()` (which is what `clear()` acts on)
and after `Log.begin()` (so the notice above is visible). Since
`wifi_store::begin()` only opens an NVS namespace and doesn't touch GPIO or
I2C, placing the whole block (the new lines above) immediately before the
existing `Wire.begin(47, 21);` call satisfies both orderings — move it there
if it isn't already ahead of `Wire.begin`.

- [ ] **Step 4: Add `wifi_store::selfTest()` to the `FAKE_SIGNALS` block**

Replace:

```cpp
#ifdef FAKE_SIGNALS
  signal_store::selfTest();
  alias_store::selfTest();
#endif
```

with:

```cpp
#ifdef FAKE_SIGNALS
  signal_store::selfTest();
  alias_store::selfTest();
  wifi_store::selfTest();
#endif
```

- [ ] **Step 5: Compile check, both with and without `.env`**

Run: `cd receiver && pio run -e esp32s3-generic 2>&1 | tail -40`

Expected: `SUCCESS` (this build has whatever `.env`/no-`.env` state is
currently on disk; don't touch `.env` if one already exists locally).

Then confirm the no-`.env` path compiles too — temporarily rename any local
`.env` out of the way if one exists, matching a fresh clone:

```bash
cd receiver
[ -f .env ] && mv .env .env.bak
pio run -e esp32s3-generic 2>&1 | tail -40
[ -f .env.bak ] && mv .env.bak .env
```

Expected: `SUCCESS` in both cases — the build no longer `#error`s without
`.env`.

- [ ] **Step 6: Commit**

```bash
git add receiver/WebReceiver.ino
git commit -m "feat(receiver): wire SoftAP provisioning into the boot flow"
```

---

## Task 4: Documentation

**Files:**
- Modify: `receiver/docs/install.md`
- Modify: `receiver/docs/user-manual.md`
- Modify: `receiver/docs/architecture.md`
- Modify: `receiver/docs/backlog.md`
- Modify: `ROADMAP.md`

**Model:** `sonnet` — prose edits across five files that must stay consistent with each other and with the landed code.

**Interfaces:** None (docs only).

- [ ] **Step 1: `receiver/docs/install.md` — make `.env` optional, document SoftAP**

Replace the `## Configure` section:

```markdown
## Configure

    cp .env.example .env

Fill in `WIFI_SSID`, `WIFI_PASSWORD`, and `MDNS_PREFIX`. `.env` is bash
syntax, gitignored, and read by `load_env.py`, which turns each entry into a
`-D` build flag. The build stops with an `#error` if it is absent.

The radio pin map and OOK settings are in `platformio.ini`.
```

with:

```markdown
## Configure

WiFi credentials no longer need to be baked into the firmware. On first boot
(or after holding the BOOT button ~3 seconds to clear stored credentials) the
device opens a SoftAP named `rtl433-receiver-XXXX` (no password) with a
captive-portal page at `192.168.4.1`: join it, pick or type a network,
enter its password, and the device reboots onto that network.

`.env` is an optional dev/CI shortcut: `cp .env.example .env`, fill in
`WIFI_SSID`, `WIFI_PASSWORD`, and `MDNS_PREFIX`, and a build with `.env`
present connects with those credentials on first boot, then stores them so
later boots skip straight to connecting (no portal). `MDNS_PREFIX` has no
runtime equivalent yet, so a device provisioned entirely through the portal
uses the `rtl433` default. `.env` is bash syntax, gitignored, and read by
`load_env.py`, which turns each entry into a `-D` build flag.

The radio pin map and OOK settings are in `platformio.ini`.
```

- [ ] **Step 2: `receiver/docs/install.md` — add a manual verification note**

Add this section after `## Build and flash` (at the end of the file):

```markdown

## Verifying WiFi provisioning on hardware

The SoftAP/DNS/captive-portal path needs a real WiFi radio and isn't
host-testable. After flashing a board with no stored credentials (or after a
long BOOT-button press):

1. Join the `rtl433-receiver-XXXX` AP from a phone or laptop.
2. Confirm the captive portal opens automatically, or browse to
   `192.168.4.1` if it doesn't.
3. Pick a network from the dropdown (or type one manually) and enter its
   password. Confirm the device reboots.
4. Confirm the device joins the target network — check `monitor.py` for
   `WiFi connected: ...` or look it up on the router.
5. Hold the BOOT button for ~3 seconds, then release. Confirm the device
   reboots into provisioning mode again (re-check step 1).
```

- [ ] **Step 3: `receiver/docs/user-manual.md` — document the portal**

In the `## Use` section, after the existing WiFi paragraph (`WiFi is not
required to decode. ... though the first connect attempt times out after 20
seconds before the receiver starts.`), add:

```markdown

A device with no stored WiFi credentials opens a `rtl433-receiver-XXXX`
SoftAP with a captive-portal setup page instead of decoding. Holding the
BOOT button ~3 seconds at boot clears stored credentials and returns to this
state. See `docs/install.md` for the full flow.
```

- [ ] **Step 4: `receiver/docs/architecture.md` — note the new NVS namespace**

In the paragraph starting `20 KB of \`nvs\` is about three times what the
firmware can put there. Radio calibration under \`phy/cal_data\` is the
largest entry at ~1,950 bytes; the WiFi credentials in \`nvs.net80211\` are a
few hundred; the alias map is capped at \`ALIAS_BLOB_MAX\`, 2 KB.`, change the
last sentence to:

```markdown
20 KB of `nvs` is about three times what the firmware can put there. Radio
calibration under `phy/cal_data` is the largest entry at ~1,950 bytes; the
WiFi driver's own credentials in `nvs.net80211` are a few hundred; the
`wifi_store` module's copy of those same credentials (namespace `wifi`) is
under 100 bytes; the alias map is capped at `ALIAS_BLOB_MAX`, 2 KB.
```

- [ ] **Step 5: `receiver/docs/backlog.md` — remove the closed item**

Delete the entire `## WiFi credentials are compiled into the image` section
(the four-paragraph block starting `\`load_env.py\` turns \`.env\` into \`-D\`
build flags...` through `...The 1 MB \`nvs\` above leaves room for it.`),
including its heading.

- [ ] **Step 6: `ROADMAP.md` — remove the closed bullet and open gap**

In the `## Baseline` section's `receiver/` bullet, change:

```markdown
- **`receiver/`** — ESP32-S3 + SX1231 firmware. Decodes 433 MHz, serves the
  binding's source-only subset, SSE, and an embedded build of the dashboard.
  Open gaps: WiFi credentials baked into the image, `rtl_433_ESP` pinned to a
  branch not a commit, and `signal_store` and `alias_store` self-tests never
  read on a device.
```

to:

```markdown
- **`receiver/`** — ESP32-S3 + SX1231 firmware. Decodes 433 MHz, serves the
  binding's source-only subset, SSE, and an embedded build of the dashboard.
  Open gaps: `rtl_433_ESP` pinned to a branch not a commit, and
  `signal_store` and `alias_store` self-tests never read on a device.
```

Under `### Goal 2 — Firmware 1.0`, delete this bullet entirely:

```markdown
- Implement SoftAP provisioning: first boot or a long press clears NVS
  credentials, a captive portal stores them, and `.env` becomes optional.
  `receiver/partitions.csv` notes that growing `nvs` is blocked on a platform
  hardcoded-offset issue; the current 0x5000 slot must be checked for fit
  before this lands.
```

- [ ] **Step 7: Commit**

```bash
git add receiver/docs/install.md receiver/docs/user-manual.md \
        receiver/docs/architecture.md receiver/docs/backlog.md ROADMAP.md
git commit -m "docs(receiver): document SoftAP WiFi provisioning"
```

---

## Task 5: Spec cleanup

**Files:**
- Delete: `docs/superpowers/specs/2026-08-20-softap-provisioning-design.md`

**Model:** `haiku` — single-file deletion, no judgment required.

**Interfaces:** None.

- [ ] **Step 1: Confirm the design is fully folded into permanent docs**

Everything in the spec now has a home: the module shapes are in
`receiver/wifi_store.h`/`receiver/provisioning.h`, the boot flow is in
`WebReceiver.ino`, the NVS sizing note is in `receiver/docs/architecture.md`,
and the manual test procedure is in `receiver/docs/install.md`. Nothing else
to carry over.

- [ ] **Step 2: Delete the spec and commit**

```bash
git rm docs/superpowers/specs/2026-08-20-softap-provisioning-design.md
git commit -m "docs: drop landed SoftAP provisioning spec"
```
