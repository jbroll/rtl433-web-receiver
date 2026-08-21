# OTA update module — design

Part of [ROADMAP.md](../../../ROADMAP.md) Goal 2, "Firmware 1.0". The
partition table already gives `receiver/` `app0`, `app1`, and `otadata`
slots (see `receiver/docs/architecture.md`); nothing writes to them yet, so
every firmware update today is a serial reflash.

## Trigger

A single authenticated push endpoint, `POST /$update`. No periodic polling,
no remote version manifest, no update server. You push a binary when you're
ready, over WiFi instead of a serial cable — the same shape as
`pio run -t upload`, just over HTTP.

This is a deliberate scope cut from the manifest-and-poll design the
ROADMAP's ordered-actions list originally sketched: there is no firmware CI
or release pipeline in this repo to hang a manifest host off of, and a
push model needs neither.

## Auth

A shared bearer token, checked against `Authorization: Bearer <token>` on
every `/$update` request. Missing or wrong token gets `401` before any byte
reaches flash.

### Token storage

New `ota_token_store.h`/`.cpp`, mirroring `wifi_store`: a fixed buffer
(32 hex chars + null) persisted to `Preferences` namespace `"ota"`. Boot
order matches WiFi's own: a stored NVS token first, the `.env`-supplied
`OTA_TOKEN` build flag as fallback if nothing is stored. If neither exists,
OTA is disabled — `/$update` always answers `404`.

### Setting the token

The SoftAP captive portal (`provisioning.cpp`) gets a third field, "Update
token", alongside SSID and password, shown on every provisioning pass:

- The page generates a fresh random token server-side on each `GET`, using
  `esp_random()` (ESP-IDF hardware RNG) for 16 bytes, hex-encoded to 32
  characters, and pre-fills the field's `value` with it.
- A "Copy" button next to the field calls `navigator.clipboard.writeText()`;
  if that throws (expected on a plain-HTTP captive-portal page in some
  browsers), it falls back to selecting the input's text via `el.select()` +
  `document.execCommand('copy')` so the user can copy it manually. This is
  the page's first inline `<script>`; today's page is plain HTML.
- Submitting the form with the field as-generated stores that token via
  `ota_token_store::set()`, persisting to NVS and overriding any `.env`
  value from then on.
- Clearing the field before submit leaves the existing token (stored, or
  `.env` if nothing was ever stored) untouched.

## Upload path

`web_ui.cpp` registers `/$update` as its own `WebServer::on()` route — not
routed through `handleTopic`'s topic parser, since `$update` isn't a topic —
using the two-callback form: `on(path, HTTP_POST, completeHandler,
uploadHandler)`.

The request must be `multipart/form-data` (`curl -F firmware=@build/firmware.bin`),
not a raw `--data-binary` body. Arduino `WebServer` only streams a POST body
through the upload callback for multipart requests; a raw body is buffered
whole into a `String` via `arg("plain")`, the same path `handleAliasPost`
and `handleTzPost` use for their few-byte JSON bodies today. A ~1.2 MB
firmware image won't fit that path against the heap this firmware runs
with.

Upload handler, called incrementally by `WebServer` as multipart chunks
arrive:

1. `UPLOAD_FILE_START` — check the bearer token; call
   `Update.begin(UPDATE_SIZE_UNKNOWN, U_FLASH)`. The Arduino `Update`
   library reads `otadata` and targets the inactive `app0`/`app1` slot
   itself; no partition offset math in this module.
2. `UPLOAD_FILE_WRITE` — `Update.write(buf, len)` per chunk.
3. `UPLOAD_FILE_END` — `Update.end(true)` (verifies size and checksum).

Complete handler (runs after the upload handler finishes): responds `200`
on success, `500` with `Update.errorString()` on failure. On success only,
`ESP.restart()`.

A bad token, a write failure, or a failed `Update.end()` all abort without
`otadata` ever being updated, so the currently-running firmware keeps
running and the next boot uses it — a failed push is a no-op, not a bricked
device.

## Not building

- No periodic check-in or remote manifest.
- No rollback-on-boot-failure logic. The existing boot flow already depends
  on WiFi coming up; firmware that can't join WiFi falls through to the
  SoftAP portal same as any other bad flash, and recovery is the same
  serial/SoftAP path that exists today.
- No change to `partitions.csv` — `app0`/`app1`/`otadata` are already sized
  and offset correctly for this.

## Docs

- `receiver/docs/architecture.md` — new module entry for `ota_token_store`
  and the `/$update` upload path, next to the `wifi_store` and
  `provisioning` entries it mirrors.
- `receiver/docs/install.md` — `OTA_TOKEN` in the `.env` field list, next to
  `WIFI_SSID`/`WIFI_PASSWORD`.
- `receiver/docs/user-manual.md` — the `curl -F` invocation for pushing an
  update.
