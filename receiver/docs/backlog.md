# Backlog

Known gaps in the receiver, in rough priority order. None break it as it stands; each was
found during review or hardware testing and deliberately left.

## The provisioning portal is an open AP that hands out an OTA token

`WiFi.softAP(ap, nullptr)` in `provisioning.cpp` brings up an unencrypted network, and
`handleRoot()` generates a fresh token with `randomToken()` and renders it
into the form on every GET; `handleSave()` stores whatever the form returns.
Anyone in range of a board sitting in the portal can join, submit their own SSID and a token they chose,
and take the board onto their network with an OTA credential they control. `POST /$update`
then accepts arbitrary firmware.

The smallest fix is a WPA2 password on the SoftAP, derived from the chip ID so it is
reproducible without a label on the case. The AP name already uses the last two MAC bytes;
the password would use more of the MAC, or a hash of `esp_efuse_mac_get_default()`,
rendered as 8 to 10 hex characters and printed over serial at portal start alongside the
existing `provisioning: AP "%s" up at %s` line, which is how an operator learns it.
`install.md` and `quickstart.md` both currently tell the reader the AP takes no password,
so both change with it.

Deferred on lockout risk. A password derived wrongly, or printed in a format the AP does
not actually accept, leaves a board that cannot be provisioned at all except by reflashing
over USB, and the portal is the path back from a bad flash. It needs proving on a bench
board before it goes anywhere near a board that is not physically reachable.

## Build-time secrets are readable in the firmware image

`load_env.py` passes `WIFI_PASSWORD`, `OTA_TOKEN` and `MQTT_TOKEN` from `.env` to
`platformio.ini` as `-D` string macros, and `ota_token_store.cpp:35` and
`mqtt_publish.cpp`'s `begin()` (the `MQTT_BROKER_URL`/`MQTT_TOKEN` build-flag
default) return them as fallbacks, so the literals link into
`.rodata`. `.env` is gitignored and untracked, so nothing is in git history, but a `.bin`
shared for flashing or an `esptool.py read_flash` on a recovered board yields all three as
plain strings. Provisioning through the portal avoids it; the build-time path does not.

Removing the build-time path removes the dev and CI shortcut, so the answer for now is an
operational rule instead: never share a `.bin` built from a populated `.env`, and provision
through the portal for any board that leaves the bench. Revisit if CI ever publishes an
image.

## No path in for sensors that are not 433 MHz decodes

The receiver's own card proved the shape: anything recorded through
`signal_store::record()` becomes a device the page already knows how to draw,
alias, and lay out. The wired I2C half is done (see the BMP280 in
`architecture.md`); ingest from elsewhere is not.

An authenticated `POST /api/signal` taking the same rtl_433 JSON is about twenty lines
and no new dependency, but it is a feature rather than a defect and needs its own design
pass first: whether it authenticates with the OTA token or a second credential, what rate
limit it carries, and whether an ingested record counts toward `totalRecorded()`. An MQTT
subscription instead needs a broker and roughly 10 KB of flash, against 144 KB free.
ESP-NOW suits battery nodes but pins them to the station's WiFi channel.

Egress is done: see `mqtt_publish.h`/`mqtt_publish.cpp` in `architecture.md`
and "Publishing to a remote broker" in `user-manual.md`.

## A slow HTTP client can still stall the receive path

`ChunkedResponse::flush()` waits up to `CHUNK_WAIT_US` 150 ms per chunk with a
`CHUNK_BUDGET_MS` 1.5 s total budget (`web_ui.cpp:118-119`) before dropping the
client. That bound exists because aborting on the first not-ready probe
truncated the page and left the browser running no script at all. The cost is
that a genuinely slow reader can hold `loop()` for up to 1.5 s, and the
library's pulse-train ring is only two deep, so signals arriving during a stall
are overwritten. A healthy client never waits. Removing the risk entirely means
serving the page off a second task, which the single-task design deliberately
avoids.

## The firmware self-test has never been read on a live device

Eight `selfTest()` calls run at startup on real hardware, but only under
`FAKE_SIGNALS`, and nobody has read their PASS/FAIL lines from a board.
`WebReceiver.ino` already points `Log.begin()` at `Serial`, the S3's USB CDC
device, on a `FAKE_SIGNALS` build, so no UART adapter on the TX pin is needed
any more; a production build keeps `Serial0` at 921600, which is what
`monitor.py` expects. What is left is running a `FAKE_SIGNALS` build on a
board and reading it, which takes that board off the air for the duration.

The checks themselves run on every commit through `test/host/run.sh` (see
`architecture.md`): `signal_store` 87, `mqtt_publish_store` 43, `alias_store`
31, `layout_store` 18, `location_store` 12, `units_store` 12.

## An alias surviving a power cycle is unverified

`Preferences::putBytes()` is now known to land in NVS and read back on real
hardware: the deployed board reports `boot_count` 52 and
`last_reset_reason` 3 (`ESP_RST_SW`), and five aliases set through the
dashboard are still served by `GET .../$alias` after that reset cleared RAM.

Two gaps remain, both needing a board in hand. A software reset is not a
power cycle, so nothing yet proves the write survives power actually being
removed. And the migration off the `putString`-based storage this store used
before is covered only host-side, against `arduino_shim`'s `Preferences`
fake; proving it means starting from a board still running the pre-`putBytes`
firmware with aliases already set, then flashing this one.

## `MDNS_PREFIX` has no runtime equivalent

`.env`'s `MDNS_PREFIX` only takes effect at build time. The captive portal has
no field for it, so a device provisioned entirely through SoftAP always uses
the `rtl433` mDNS prefix default.

A portal field for it needs a small NVS-backed store and `mdnsHostname()` preferring the
stored value over the macro. The catch is that the prefix also feeds
`signal_store::source()`, the first segment of every topic key, so changing it renames
every device on the dashboard and orphans the stored `$layout` and every alias, both of
which key on the full topic. The form has to say so, or the portal has to warn.

## A `POST /$update` upload blocks `loop()` for the whole transfer

`handleUpdateUpload()` runs synchronously inside `_server.handleClient()`
for every chunk of the multipart body, so `loop()` — and with it `rf.loop()`
— doesn't run until the upload finishes. The rtl_433 library's pulse-train
ring is only two deep (see the slow-HTTP-client entry above), so signals
arriving during the transfer can be dropped, and SSE keepalives stall for
the duration. Worse than the `CHUNK_BUDGET_MS` 1.5 s stall above, which is
about a slow *reader*; this is about a slow or large *upload*, likely
several seconds for a ~1.2 MB image over WiFi.

## `POST /$mqtt/remove` returns 204 for a url it never removed

`handleMqttRemovePost()` in `web_ui.cpp` calls `mqtt_publish_store::remove(url)` and
unconditionally answers `204`, on the stated basis that "a url that was never present is
not an error." That collapses two different outcomes into one response: a bridge that was
actually dropped, and one baked into the firmware build (or otherwise never in the runtime
store) that a client cannot remove at runtime. A caller reading only the status code cannot
tell them apart, so the dashboard has to re-fetch `GET /$mqtt` after a `204` and check
whether the url is still listed to know whether anything happened.

## `mqtt_publish_store` leaks a stale `url`/`token` pair when a legacy table string co-exists

`begin()`'s `migrateLegacy()` only removes the pre-existing single-broker `url`/`token` NVS
keys when it does the migrating itself (`count() == 0` at the time it runs). A device
holding both a legacy `table` string (which `load()` migrates first, populating the table
and making `migrateLegacy()` a no-op) and a leftover single `url`/`token` pair from before
the table existed keeps that stale pair in NVS forever — harmless, since nothing reads it
once the table is populated, but it never gets cleaned up. Fixing it means restructuring
`begin()`'s migration logic (tracking "did load() already populate a table" separately from
"did migrateLegacy() do anything"), more than the one-line retry `load()` got for the
half-migrated legacy-key case.

## The 4 KB record() arena is not sufficient for every shape under SIGNAL_PAYLOAD_MAX

`SIGNAL_JSON_POOL_BYTES` (`signal_store.cpp`) was sized against a payload shaped
as one string field filling `SIGNAL_PAYLOAD_MAX`. Arena cost is per-slot plus
per-string, and ArduinoJson inlines keys of about three characters or less, so
the worst density is short-but-not-inline keys: a 595-byte object of 54
four-character keys with float values needs a 5632-byte arena and returns
`NoMemory` at 4096. Realistic rtl_433 field names parse to 758 bytes, well
under that. Every `record()` call site is internal — the decoder queue, the
two BMP280 paths, and fake signals — so this worst-case shape does not come
off the radio. Not raising the arena again on this basis; noted here in case a
future call site changes that assumption.

## Smaller items

- Every `mqtts://` bridge is pinned to the ISRG Root X1 CA with no way to
  configure another; a broker not chained to Let's Encrypt (a commercial cloud
  broker, a self-signed LAN broker) will fail its handshake silently, showing
  only a dot that never turns green. A configurable CA needs a form field, a
  multi-KB NVS entry on a partition already tight for blobs, and a decision
  about whether to allow no verification at all, so it waits until someone has
  a broker that needs it. The cheap mitigation is to log the
  `WiFiClientSecure` handshake error rather than only PubSubClient's
  `state()`, so the reason reaches the serial log. That has not been done.
- Each record is serialised twice: `mqtt_publish::onRecord` writes the doc into a
  601-byte stack buffer and `signal_store::record()` writes the identical doc into
  `sub.payload` a few lines later. Serialising once into `sub.payload` and publishing
  from there means changing the hook contract from "gets the doc" to "gets the
  serialised payload", so it is worth doing only if the decode path measures hot.
- No test exercises `web_ui.cpp`'s `/$mqtt` HTTP dispatch directly, and there
  is no host-testable seam for `web_ui.cpp` routes at all.
- `test/binding-server.js`, the model of the firmware's wire format, checks alias name
  length with JavaScript's `value.length` (UTF-16 code units), while `web_ui.cpp`'s
  `handleAliasPost` checks `strlen(name)` (bytes). The two agree for ASCII but disagree for
  any multi-byte alias: a name the model accepts as under `ALIAS_NAME_MAX` can be over the
  firmware's byte limit, and vice versa. Not fixed here; noted as a model-versus-firmware
  divergence.
