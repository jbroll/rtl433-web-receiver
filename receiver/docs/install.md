# Install

## Requirements

An ESP32-S3 and a HopeRF RFM69CW radio module, wired as below.

The library dependency is a fork,
[jbroll/rtl_433_ESP](https://github.com/jbroll/rtl_433_ESP) branch
`sx1231-support`, which adds SX1231/RF69 receive support upstream does not have.
`platformio.ini` points at it and PlatformIO fetches it on the first build.
`platformio.ini:13` pins that dependency to a commit sha on that branch, not
the branch itself; to move the pin forward, resolve the branch's current head
with `git ls-remote https://github.com/jbroll/rtl_433_ESP.git sx1231-support`,
edit the sha in `platformio.ini:13`, then
`rm -rf .pio/libdeps/esp32s3-generic/rtl_433_ESP` and rebuild to force
PlatformIO to re-resolve it.

Node 22 or newer. `pio run` runs `dashboard/build.js` to generate the page it serves,
so run `npm install` in `../dashboard` before the first `pio run` — its `build.js`
imports `esbuild` from `dashboard/node_modules`.

## Wiring

| Signal | GPIO | Freenove header | RFM69CW pin | Note |
|---|---|---|---|---|
| MISO | 1 | right 3 | 8 | SPI |
| MOSI | 42 | right 5 | 5 | SPI |
| SCK | 41 | right 6 | 6 | SPI |
| CS (NSS) | 39 | right 8 | 7 | idle high; 10k pull-up to 3V3 |
| RST | 38 | right 9 | 13 | 10k pull-down to GND |
| DIO2 (data) | 40 | right 7 | 10 | continuous data output; GPIO 40 already pulled up |
| DIO0 | NC | — | 9 | unused |
| DIO1 | NC | — | 11 | unused |
| DIO3 | NC | — | 4 | unused |
| DIO5 | NC | — | 12 | unused |

DIO2 carries the demodulated data and is the pin the decoder reads. Change the
`RF_MODULE_*` values in `platformio.ini` to match your board.

## I2C header

The BMP280/AHT20 bus is on GPIO 47 (SCL) and GPIO 21 (SDA). Add 10k pull-ups
to 3V3 on both lines at the sensor header unless the breakout board already
provides them.

## Configure

WiFi credentials no longer need to be baked into the firmware. On first boot
(or after holding the BOOT button ~3 seconds to clear stored credentials) the
device opens a SoftAP named `rtl433-receiver-XXXX` (no password) with a
captive-portal page at `192.168.4.1`: join it, pick or type a network,
enter its password, and the device reboots onto that network.

`.env` is an optional dev/CI shortcut: `cp .env.example .env`, fill in
`WIFI_SSID`, `WIFI_PASSWORD`, `MDNS_PREFIX`, and optionally `OTA_TOKEN`, and a
build with `.env` present connects with those credentials on first boot, then
stores them so later boots skip straight to connecting (no portal).
`MDNS_PREFIX` has no runtime equivalent yet, so a device provisioned entirely
through the portal uses the `rtl433` default. `OTA_TOKEN` seeds the bearer
token `/$update` checks (see `docs/user-manual.md`) if the portal has never
been used to set one; it's overridden the moment a token is saved through the
portal, and the portal's "Clear stored update token" checkbox reverts to it
(or to OTA disabled, on a build with no `OTA_TOKEN`). Generate a random value
yourself (e.g. `openssl rand -hex 16`) rather than leaving the
`.env.example` placeholder in place. `.env` is bash syntax,
gitignored, and read by `load_env.py`, which turns each entry into a `-D`
build flag.

A receiver built with a custom `MDNS_PREFIX` won't be found by the app's
mDNS scan, which filters on the default `rtl433-` prefix; add it manually
by URL instead.

`MQTT_BROKER_URL` and `MQTT_TOKEN` are optional and off by default: setting
neither leaves the device publishing nothing through this build-flag path.
Set `MQTT_BROKER_URL` to publish every record, retained, to a remote broker
— `mqtt://host:port` for a plaintext LAN broker (Mosquitto, Home Assistant),
`mqtts://host:port` for a public one, like `weather.rkroll.com`'s embedded
bridge broker (see `../../bridge/docs/install.md`'s `AUTH_TOKEN`), which
requires `MQTT_TOKEN` to match. Unlike `OTA_TOKEN`, these aren't settable
through the provisioning portal — the portal is WiFi credentials and the OTA
token only. Add, change, or remove up to three more bridges from the
dashboard's Settings tab once the device is on the network (see
`docs/user-manual.md`'s "Publishing to a remote broker"); the build-flag
broker keeps running alongside them and can't be removed from the
dashboard.

A build with `.env` present reconnects with its compiled-in credentials on
every boot, including after a BOOT-button credential clear (see below) — to
verify the portal path itself, build with no `.env` present, or one with
deliberately wrong credentials.

The radio pin map and OOK settings are in `platformio.ini`.

## Build and flash

    pio run -e esp32s3-generic
    pio run -e esp32s3-generic -t upload

## Verifying WiFi provisioning on hardware

The SoftAP/DNS/captive-portal path needs a real WiFi radio and isn't
host-testable. Build with no `.env` present (see the note under Configure —
otherwise step 5 just reconnects with compiled-in credentials and never
reaches the portal). After flashing a board with no stored credentials (or
after a BOOT-button credential clear, step 5):

1. Join the `rtl433-receiver-XXXX` AP from a phone or laptop.
2. Confirm the captive portal opens automatically, or browse to
   `192.168.4.1` if it doesn't.
3. Pick a network from the dropdown (or type one manually) and enter its
   password. Confirm the device reboots.
4. Confirm the device joins the target network — check `monitor.py` for
   `WiFi connected: ...` or look it up on the router.
5. `bootButtonHeld()` samples GPIO0 about one second after reset and returns
   immediately if it isn't already held low at that moment, so reset the
   board (power cycle or the reset button), then press and hold BOOT within
   about a second of the reset — not before, since holding BOOT through
   power-on/reset instead puts the S3 into its ROM download mode — and keep
   holding for the full ~3 seconds. Confirm the device reboots into
   provisioning mode again (re-check step 1).
