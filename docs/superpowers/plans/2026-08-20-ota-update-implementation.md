# OTA update module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a single authenticated `POST /$update` endpoint that flashes a firmware binary pushed over WiFi to the inactive OTA partition, per `docs/superpowers/specs/2026-08-20-ota-update-design.md`.

**Architecture:** Three additions to `receiver/`, each mirroring an existing module: a new `ota_token_store` (mirrors `wifi_store`, persists a bearer token to NVS with a `.env` fallback), a third field on the existing SoftAP provisioning page (`provisioning.cpp`) that generates and stores that token, and a new `/$update` route in `web_ui.cpp` that streams a multipart upload straight into Arduino's `Update` library.

**Tech Stack:** Arduino ESP32 framework (`WebServer`, `Update`, `Preferences`, `esp_random()`), PlatformIO, `ArduinoLog`.

## Global Constraints

- Bearer token: `Authorization: Bearer <token>` checked on every `/$update` request. Missing/wrong token: `401`, and flash is never touched.
- No stored token and no `.env` `OTA_TOKEN`: `/$update` always answers `404` — OTA is disabled, not just unauthenticated.
- Token storage mirrors `wifi_store`: fixed 33-byte buffer (32 hex chars + null), `Preferences` namespace `"ota"`. Boot order: stored NVS token first, `.env` `OTA_TOKEN` build flag as fallback.
- Token field lives on the SoftAP captive portal (`provisioning.cpp`), alongside SSID/password, generated server-side each `GET` via `esp_random()` (16 bytes, hex-encoded to 32 chars).
- `/$update` requires `multipart/form-data` (the two-callback `WebServer::on()` form) — a raw body would buffer the ~1.2 MB image into a `String`, which doesn't fit the available heap.
- `Update.begin(UPDATE_SIZE_UNKNOWN, U_FLASH)` targets the inactive slot itself — no partition offset math in this module, no `partitions.csv` change.
- A bad token, a write failure, or a failed `Update.end()` all abort without touching `otadata` — the running firmware keeps running.
- `ESP.restart()` only on a confirmed-successful `Update.end(true)`.
- No periodic check-in, no remote manifest, no rollback-on-boot-failure logic.

---

## File Structure

- Create `receiver/ota_token_store.h` / `receiver/ota_token_store.cpp` — token persistence, mirrors `wifi_store.h`/`.cpp`.
- Modify `receiver/WebReceiver.ino` — wire `ota_token_store::begin()` into `setup()`, add its `selfTest()` call under `FAKE_SIGNALS`.
- Modify `receiver/.env.example` — add `OTA_TOKEN`.
- Modify `receiver/provisioning.cpp` — third form field, `esp_random()` token generation, copy-to-clipboard script, `handleSave()` stores it.
- Modify `receiver/web_ui.cpp` — register `/$update`, upload/complete handlers using `Update`.
- Modify `receiver/docs/architecture.md`, `receiver/docs/install.md`, `receiver/docs/user-manual.md`.

No task here is host-testable: `Preferences`, `WebServer`, and `Update` all need real hardware or at least the Arduino core, same as `wifi_store` and `provisioning` today (see `receiver/docs/install.md`'s "isn't host-testable" note). Verification is `pio run -e esp32s3-generic` compiling clean, plus each module's `FAKE_SIGNALS`-gated `selfTest()` where one exists, same pattern `wifi_store::selfTest()` already uses.

---

### Task 1: `ota_token_store` module

**Files:**
- Create: `receiver/ota_token_store.h`
- Create: `receiver/ota_token_store.cpp`
- Modify: `receiver/WebReceiver.ino:22-30` (includes), `:480` (`setup()`, after `wifi_store::begin()`), `:526-528` (`FAKE_SIGNALS` selfTest block)
- Modify: `receiver/.env.example`
- Modify: `receiver/docs/architecture.md:92-98` (after the `wifi_store` entry), `receiver/docs/install.md:54-60` (the `.env` paragraph under "Configure")

**Model:** `sonnet` — closely mirrors `wifi_store.cpp`'s existing pattern but needs judgment on the `.env`-fallback precedence and the `selfTest` harness.

**Interfaces:**
- Produces: `ota_token_store::begin()` (bool), `ota_token_store::hasToken()` (bool), `ota_token_store::token()` (`const char*`, stored value or `.env` `OTA_TOKEN` fallback or `""`), `ota_token_store::set(const char*)` (bool), `OTA_TOKEN_STORE_MAX` (33), `ota_token_store::selfTest()` (bool, `FAKE_SIGNALS` only). Tasks 2 and 3 call `set()`, `hasToken()`, and `token()`.

- [ ] **Step 1: Create `receiver/ota_token_store.h`**

```cpp
#pragma once

#include <Arduino.h>

// 16 random bytes hex-encoded is 32 chars, plus a null terminator.
#define OTA_TOKEN_STORE_MAX 33

namespace ota_token_store {
bool        begin();          // opens the "ota" NVS namespace
bool        hasToken();
const char* token();          // stored token, else the OTA_TOKEN build flag, else ""
bool        set(const char* token);
#ifdef FAKE_SIGNALS
bool selfTest();
#endif
} // namespace ota_token_store
```

- [ ] **Step 2: Create `receiver/ota_token_store.cpp`**

```cpp
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
```

- [ ] **Step 3: Wire it into `receiver/WebReceiver.ino`**

Add the include next to `health_store.h` (alphabetical order with the other module includes, `receiver/WebReceiver.ino:22-30`):

```cpp
#include "alias_store.h"
#include "device_hooks.h"
#include "health_store.h"
#include "ota_token_store.h"
#include "provisioning.h"
#include "radio_health.h"
#include "signal_store.h"
#include "tz_store.h"
#include "web_ui.h"
#include "wifi_store.h"
```

In `setup()`, right after `wifi_store::begin();` (`receiver/WebReceiver.ino:480`):

```cpp
  wifi_store::begin();
  ota_token_store::begin();
```

In the `FAKE_SIGNALS` selfTest block (`receiver/WebReceiver.ino:526-528`), add the new call after `wifi_store::selfTest();`:

```cpp
  signal_store::selfTest();
  alias_store::selfTest();
  wifi_store::selfTest();
  ota_token_store::selfTest();
```

- [ ] **Step 4: Add `OTA_TOKEN` to `receiver/.env.example`**

```
# Copy to .env and fill in. .env is gitignored and never reaches the build
# output; load_env.py turns each line into a -D build flag.
WIFI_SSID="your-ssid"
WIFI_PASSWORD="your-password"
MDNS_PREFIX="rtl433"
OTA_TOKEN="0123456789abcdef0123456789abcdef"
```

- [ ] **Step 5: Build to verify it compiles**

Run: `cd receiver && pio run -e esp32s3-generic`
Expected: `SUCCESS`, no undefined-reference or redefinition errors for `ota_token_store`.

- [ ] **Step 6: Update `receiver/docs/architecture.md`**

Insert a new entry right after the `wifi_store.h` / `wifi_store.cpp` entry (`receiver/docs/architecture.md:92-98`), before `provisioning.h` / `provisioning.cpp`:

```markdown
**`ota_token_store.h` / `ota_token_store.cpp`** — persists the `/$update`
bearer token to `Preferences` namespace `"ota"`, in a fixed 33-byte buffer
(`OTA_TOKEN_STORE_MAX`). Mirrors `wifi_store`'s fixed-buffer/NVS shape.
`token()` returns the stored value if one exists, else the `.env`-supplied
`OTA_TOKEN` build flag, else an empty string — `hasToken()` is false only in
that last case, which is what makes `/$update` answer `404` instead of `401`
when OTA has never been configured.
```

- [ ] **Step 7: Update `receiver/docs/install.md`**

In the "Configure" section's `.env` paragraph (`receiver/docs/install.md:54-60`), extend the fill-in list:

```markdown
`.env` is an optional dev/CI shortcut: `cp .env.example .env`, fill in
`WIFI_SSID`, `WIFI_PASSWORD`, `MDNS_PREFIX`, and optionally `OTA_TOKEN`, and a
build with `.env` present connects with those credentials on first boot, then
stores them so later boots skip straight to connecting (no portal).
`MDNS_PREFIX` has no runtime equivalent yet, so a device provisioned entirely
through the portal uses the `rtl433` default. `OTA_TOKEN` seeds the bearer
token `/$update` checks (see `docs/user-manual.md`) if the portal has never
been used to set one; it's overridden the moment a token is saved through the
portal. `.env` is bash syntax, gitignored, and read by `load_env.py`, which
turns each entry into a `-D` build flag.
```

- [ ] **Step 8: Commit**

```bash
git add receiver/ota_token_store.h receiver/ota_token_store.cpp \
        receiver/WebReceiver.ino receiver/.env.example \
        receiver/docs/architecture.md receiver/docs/install.md
git commit -m "feat(receiver): add ota_token_store for the /\$update bearer token"
```

---

### Task 2: Provisioning portal token field

**Files:**
- Modify: `receiver/provisioning.cpp`
- Modify: `receiver/docs/architecture.md:100-110` (the `provisioning.h`/`.cpp` entry)

**Model:** `sonnet` — small HTML/JS addition plus C++ wiring against Task 1's `ota_token_store` API; judgment on where the copy-fallback script goes.

**Interfaces:**
- Consumes: `ota_token_store::set(const char*)` (bool) from Task 1.
- Produces: nothing new consumed elsewhere — this task only changes the page `handleRoot()` renders and what `handleSave()` does with the extra field.

- [ ] **Step 1: Add the include**

In `receiver/provisioning.cpp`, alongside the existing includes (`receiver/provisioning.cpp:1-8`):

```cpp
#include "provisioning.h"

#include <ArduinoLog.h>
#include <DNSServer.h>
#include <WebServer.h>
#include <WiFi.h>
#include <esp_random.h>

#include "ota_token_store.h"
#include "wifi_store.h"
```

- [ ] **Step 2: Add a token generator**

Add this near the other static helpers, after `writeHtmlEscaped()` (`receiver/provisioning.cpp:32-42`):

```cpp
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
```

- [ ] **Step 3: Render the field in `handleRoot()`**

In `receiver/provisioning.cpp:88-114`, insert a token field and its script before the closing `</form>`, and generate the token at the top of the function:

```cpp
static void handleRoot() {
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
      "<input type=\"text\" id=\"ota_token\" name=\"token\" maxlength=\"32\" value=\"";
  page += token;
  page +=
      "\"><button type=\"button\" onclick=\"copyToken()\">Copy</button></label><br><br>"
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
```

- [ ] **Step 4: Store the token in `handleSave()`**

In `receiver/provisioning.cpp:116-145`, add the token handling after the existing SSID/password validation and before the success response (right after the `wifi_store::set()` failure check):

```cpp
  if (!wifi_store::set(ssid.c_str(), pass.c_str())) {
    _server.send(500, "text/plain", "Could not save credentials, try again.");
    return;
  }

  String token = _server.arg("token");
  token.trim();
  if (token.length() > 0 && !ota_token_store::set(token.c_str())) {
    // Non-fatal: WiFi is the essential part of this form. A failed token
    // save just leaves OTA on its prior token (stored, or .env), same as
    // leaving the field blank.
    Log.warning(F("provisioning: could not store update token" CR));
  }

  _server.send(200, "text/html",
```

(the rest of `handleSave()` — the success-page `send()` call and `ESP.restart()` — is unchanged.)

- [ ] **Step 5: Build to verify it compiles**

Run: `cd receiver && pio run -e esp32s3-generic`
Expected: `SUCCESS`.

- [ ] **Step 6: Update `receiver/docs/architecture.md`**

In the `provisioning.h` / `provisioning.cpp` entry (`receiver/docs/architecture.md:100-110`), add a sentence after the existing description:

```markdown
**`provisioning.h` / `provisioning.cpp`** — the SoftAP captive portal used
when no stored or `.env` credentials connect. It runs its own `WebServer` on
port 80, separate from `web_ui.cpp`'s: `provisioning::run()` always ends in a
reboot before `web_ui::begin()` ever runs, so there is no port conflict
between the two. `run()` scans for nearby networks in STA mode before
`WiFi.softAP()` brings the AP up, because `WiFi.scanNetworks()` forces the
radio through STA-mode channel-hopping that would otherwise briefly
destabilize an already-joined client. The scanned list, deduplicated and
sorted by RSSI, is cached and rendered into the setup page rather than
rescanned per request. A DNS server answering every query with the AP's own
IP is what makes a phone or laptop auto-open the captive portal. The page's
third field, the OTA update token, is regenerated with `esp_random()` on
every `GET` and stored via `ota_token_store::set()` only if submitted
non-empty, so leaving it blank on a re-provisioning pass keeps whatever
token was already set.
```

- [ ] **Step 7: Commit**

```bash
git add receiver/provisioning.cpp receiver/docs/architecture.md
git commit -m "feat(receiver): generate and store the OTA token from the SoftAP portal"
```

---

### Task 3: `/$update` upload route

**Files:**
- Modify: `receiver/web_ui.cpp`
- Modify: `receiver/docs/architecture.md:84-90` (the `web_ui.h`/`.cpp` entry)
- Modify: `receiver/docs/user-manual.md:25-36` (Routes table) and a new subsection

**Model:** `sonnet` — integrates two Arduino APIs (`WebServer` upload callbacks, `Update`) against Task 1's token store; the auth-before-flash ordering needs care but is fully specified below.

**Interfaces:**
- Consumes: `ota_token_store::hasToken()` (bool) and `ota_token_store::token()` (`const char*`) from Task 1.

- [ ] **Step 1: Add the includes**

In `receiver/web_ui.cpp:1-14`:

```cpp
#include "web_ui.h"

#include <ArduinoJson.h>
#include <ArduinoLog.h>
#include <Update.h>
#include <WebServer.h>
#include <WiFi.h>
#include <errno.h>
#include <lwip/sockets.h>

#include "alias_store.h"
#include "dashboard_html.h"
#include "ota_token_store.h"
#include "signal_store.h"
#include "topic.h"
#include "tz_store.h"
```

- [ ] **Step 2: Add upload state and handlers**

Add this after `handleTzPost()` and before `handleTopic()` (`receiver/web_ui.cpp:364-366`):

```cpp
// Set at UPLOAD_FILE_START, read by handleUpdateComplete() once the whole
// multipart body has been parsed — WebServer's two-callback on() only calls
// the complete handler after the upload handler has seen every chunk.
static bool _otaDisabled   = false;
static bool _otaAuthorized = false;
static bool _otaStarted    = false;

static void handleUpdateUpload() {
  HTTPUpload& upload = _server.upload();
  if (upload.status == UPLOAD_FILE_START) {
    _otaStarted = false;
    if (!ota_token_store::hasToken()) {
      _otaDisabled   = true;
      _otaAuthorized = false;
      return;
    }
    _otaDisabled = false;
    String expected = String("Bearer ") + ota_token_store::token();
    _otaAuthorized  = _server.header("Authorization") == expected;
    if (!_otaAuthorized) {
      Log.warning(F("OTA update: rejected, bad or missing token" CR));
      return;
    }
    Log.notice(F("OTA update: starting, filename=%s" CR), upload.filename.c_str());
    _otaStarted = Update.begin(UPDATE_SIZE_UNKNOWN, U_FLASH);
    if (!_otaStarted) {
      Log.warning(F("OTA update: Update.begin failed: %s" CR), Update.errorString());
    }
  } else if (upload.status == UPLOAD_FILE_WRITE) {
    if (_otaStarted && Update.write(upload.buf, upload.currentSize) != upload.currentSize) {
      Log.warning(F("OTA update: write failed: %s" CR), Update.errorString());
    }
  } else if (upload.status == UPLOAD_FILE_END) {
    if (_otaStarted && !Update.end(true)) {
      Log.warning(F("OTA update: Update.end failed: %s" CR), Update.errorString());
    }
  } else if (upload.status == UPLOAD_FILE_ABORTED) {
    if (_otaStarted) {
      Update.abort();
      _otaStarted = false;
    }
  }
}

static void handleUpdateComplete() {
  if (_otaDisabled) {
    sendStatus(404, "not found");
    return;
  }
  if (!_otaAuthorized) {
    sendStatus(401, "unauthorized");
    return;
  }
  if (!_otaStarted || Update.hasError()) {
    sendStatus(500, Update.errorString());
    return;
  }
  sendStatus(200, "ok");
  delay(500); // let the response flush before the restart drops the socket
  ESP.restart();
}
```

- [ ] **Step 3: Register the route**

In `begin()` (`receiver/web_ui.cpp:535-543`), register `/$update` ahead of `onNotFound`:

```cpp
void begin() {
  _server.on("/", HTTP_GET, handleRoot);
  _server.on("/events", HTTP_GET, handleEvents);
  _server.on("/$update", HTTP_POST, handleUpdateComplete, handleUpdateUpload);
  // Topics are arbitrary paths, so every other request is dispatched here.
  _server.onNotFound(handleTopic);
  _server.begin();
  _started = true;
  Log.notice(F("web server listening on port 80" CR));
}
```

- [ ] **Step 4: Build to verify it compiles**

Run: `cd receiver && pio run -e esp32s3-generic`
Expected: `SUCCESS`.

- [ ] **Step 5: Update `receiver/docs/architecture.md`**

In the `web_ui.h` / `web_ui.cpp` entry (`receiver/docs/architecture.md:84-90`), update the routes sentence:

```markdown
**`web_ui.h` / `web_ui.cpp`** — the HTTP and SSE surface. `/`, `/events`, and
`/$update` are the only registered routes; every topic is an arbitrary path,
so `GET` and `POST` of a topic are both dispatched from
`WebServer::onNotFound`, which does its own topic validation rather than
relying on route matching. `/$update` is registered directly rather than
routed through the topic parser, since `$update` isn't a topic, and uses
`WebServer::on()`'s two-callback form so the ~1.2 MB firmware image streams
through `Update::write()` in chunks instead of buffering whole. Four SSE
client slots (`WEB_UI_SSE_CLIENTS`), each a `WiFiClient` plus up to four
filters and one replay cursor, are fixed arrays sized at compile time — there
is no dynamic connection list.
```

- [ ] **Step 6: Update `receiver/docs/user-manual.md`**

Add a row to the Routes table (`receiver/docs/user-manual.md:25-36`):

```markdown
| Method and path | Behaviour |
|---|---|
| `GET /` | The live page. `200`, `text/html` |
| `GET /<topic>` | The stored message. `200`, `application/json`, `Cache-Control: no-store`. `404` if there is none |
| `POST /<topic>` | Set an alias. Body is a JSON string. `204` on success |
| `POST /$tz` | Store the GMT offset. Body is a JSON number, signed minutes. `204`; `405` unless the topic is `$tz` or under this receiver's source |
| `GET /events?f=<filter>&f=<filter>` | Subscribe. `200`, `text/event-stream` |
| `POST /$update` | Push a firmware image. `multipart/form-data`, bearer token required. `200` and reboots on success |
```

Add a new subsection after `### POST /$tz` (`receiver/docs/user-manual.md:92-108`), before `### GET /events`:

```markdown
### `POST /$update`

Pushes a new firmware image over WiFi — the same shape as `pio run -t
upload`, without the serial cable. The body must be `multipart/form-data`
with the image in a field named `firmware`; a raw `--data-binary` body is
rejected the same as any other malformed request to this route, since the
firmware only streams the multipart form through incrementally, not a raw
POST body.

    curl -F firmware=@build/firmware.bin \
         -H "Authorization: Bearer 0123456789abcdef0123456789abcdef" \
         'http://rtl433-a1b2c3.local/$update'

    200 ok

The bearer token is set from the SoftAP captive portal's "Update token"
field (see `docs/install.md`) or from the `.env` `OTA_TOKEN` build flag if
none has been set through the portal yet. A missing or wrong
`Authorization` header is `401`; no token configured at all — neither
stored nor `.env` — is `404`, same as any other unrecognized route. A write
failure or a failed integrity check on the uploaded image is `500` with the
underlying error as the body, and the currently-running firmware is left in
place either way: `otadata` is only updated once the whole image has
verified, so a rejected or failed push is a no-op, not a bricked device. The
device reboots on the new firmware only after a `200`.

Quote the URL (or escape the `$`) — an unquoted `/$update` is a shell
variable expansion, not a literal path.
```

Note: the `$update` in the shell-quoting caution above is single-quoted deliberately in the example command; don't "fix" it to double quotes.

- [ ] **Step 7: Commit**

```bash
git add receiver/web_ui.cpp receiver/docs/architecture.md receiver/docs/user-manual.md
git commit -m "feat(receiver): add the /\$update OTA upload route"
```

---

## Final check

- [ ] Run `cd receiver && pio run -e esp32s3-generic` once more from a clean tree (all three tasks committed) to confirm the whole thing still links.
- [ ] Run `receiver/test/host/run.sh` to confirm the unrelated host tests (`topic`, `radio_health`, `device_hooks`) still pass — none of this plan's code touches them, but they're cheap to check.
- [ ] Re-read `docs/superpowers/specs/2026-08-20-ota-update-design.md` against the three commits: trigger, auth, token storage, upload path, "not building" list, and the docs list should all be covered.
- [ ] Delete `docs/superpowers/specs/2026-08-20-ota-update-design.md` and this plan file in the final commit before merge (per the repo's spec/plan-are-working-documents convention) — their content is now in `receiver/docs/architecture.md`, `install.md`, and `user-manual.md`.
