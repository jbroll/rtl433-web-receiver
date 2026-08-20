# SoftAP WiFi provisioning — design

Goal 2 (Firmware 1.0) item: "Implement SoftAP provisioning: first boot or a
long press clears NVS credentials, a captive portal stores them, and `.env`
becomes optional." (`ROADMAP.md`)

## Problem

`receiver/WebReceiver.ino` currently requires `WIFI_SSID`/`WIFI_PASSWORD`
build-time flags, loaded from `.env` via `load_env.py`. Every device needs a
firmware image baked with its own credentials before it can join a network.

## Design

### `wifi_store` module

New `receiver/wifi_store.{h,cpp}`, following the `Preferences`-backed module
pattern used by `tz_store` and `alias_store`: an NVS namespace (`wifi`) with
`ssid` and `pass` keys.

```
namespace wifi_store {
bool begin();                                  // opens the "wifi" NVS namespace
bool hasCredentials();
const char* ssid();
const char* password();
bool set(const char* ssid, const char* password);
void clear();
bool selfTest();                               // gated behind FAKE_SIGNALS, mirrors alias_store::selfTest()
}
```

Buffer sizes: SSID max 32 bytes (802.11 limit), password max 64 bytes (WPA2
limit), both plus a null terminator.

### `provisioning` module

New `receiver/provisioning.{h,cpp}`. Owns `WiFi.softAP()`, a `DNSServer`, and
a `WebServer` instance dedicated to the captive portal. This server is
separate from `web_ui.cpp`'s `WebServer` and is only alive during
provisioning, so there is no port-80 conflict — provisioning runs to
completion (a reboot) before `web_ui`'s server ever starts.

```
namespace provisioning {
void run();   // blocks until credentials are saved and the device reboots
}
```

`run()`:
1. `WiFi.softAP("rtl433-receiver-XXXX", nullptr)` — open AP, no password;
   `XXXX` is the last 4 hex digits of the STA MAC for uniqueness across
   multiple receivers.
2. Start a `DNSServer` that answers every query with the AP's own IP
   (`192.168.4.1`), so most OSes auto-open the captive portal.
3. Start a `WebServer` on port 80:
   - `GET /` — runs `WiFi.scanNetworks()`, renders a page with a dropdown of
     found SSIDs (by descending RSSI, deduplicated) plus a manual-entry text
     field as fallback, and a password field.
   - `POST /save` — reads `ssid`/`pass` form fields, calls
     `wifi_store::set()`, responds with a short "restarting" page, then
     `ESP.restart()`.
4. Loop: `dnsServer.processNextRequest()` + `server.handleClient()`, no
   timeout — the device stays in provisioning mode until configured.

### Boot flow

In `WebReceiver.ino::setup()`, replacing the current unconditional
`connectWiFi()` call:

1. `wifi_store::begin()`.
2. Read GPIO0 (BOOT button, present on the Freenove ESP32-S3 board) at boot.
   If held low continuously for ~3 seconds (debounced, blocking read at the
   very start of `setup()` before anything else initializes), call
   `wifi_store::clear()`.
3. If `wifi_store::hasCredentials()`, connect STA using those credentials
   (existing `connectWiFi()` logic, retargeted from the `WIFI_SSID`/
   `WIFI_PASSWORD` macros to `wifi_store::ssid()`/`wifi_store::password()`).
4. Else if `WIFI_SSID`/`WIFI_PASSWORD` build flags are defined (the `.env`
   path, now an optional dev/CI shortcut): connect STA using those macros,
   and on a successful connection persist them into `wifi_store` so the next
   boot skips straight to step 3.
5. Else: call `provisioning::run()`. This never returns during normal
   operation — it ends in `ESP.restart()` once credentials are saved, and
   the next boot re-enters `setup()` at step 1, now with stored credentials.

If STA connect fails after fresh credentials are saved via the portal (step
5's reboot lands back in step 3 and that fails), the device reboots into
provisioning again rather than sitting on a dead STA connection with no way
to reach it over HTTP.

### Partition fit

Not re-verified as part of this design (confirmed already fits per prior
review). `wifi_store` adds two small NVS entries (SSID ≤32B, password ≤64B)
to the existing 0x5000 `nvs` partition alongside `alias_store`, `tz_store`,
and `health_store`.

## Testing

- `wifi_store::selfTest()`, gated behind `FAKE_SIGNALS` like
  `alias_store::selfTest()`, called from `setup()` alongside the existing
  `signal_store::selfTest()` / `alias_store::selfTest()` calls. Covers
  `set`/`clear`/`hasCredentials`/round-trip of stored values, following
  `alias_store::selfTest()`'s pattern of suppressing NVS writes mid-test.
- No host test: this repo's `Preferences`-backed stores don't have host
  tests yet (see ROADMAP's separate "move `signal_store` and `alias_store`
  self-tests to a PlatformIO `native` environment" item, which is unstarted
  and out of scope here).
- The SoftAP/DNS/captive-portal path itself isn't host-testable (needs a
  real WiFi radio). Verify on hardware: join the AP, confirm the portal
  loads, save credentials, confirm the device reboots and joins the target
  network, confirm a long BOOT-button press clears credentials and
  re-enters provisioning. Add this as a manual verification note in
  `receiver/docs/install.md`.

## Out of scope

- WPA2-Enterprise or open-network (no password) target networks.
- A provisioning timeout / auto-fallback to STA retry.
- Changing `web_ui.cpp`'s existing `WebServer` usage.
