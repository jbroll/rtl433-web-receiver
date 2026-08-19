# Install

## Requirements

An ESP32-S3 and an SX1231/RFM69 radio module, wired as below.

The library dependency is a fork,
[jbroll/rtl_433_ESP](https://github.com/jbroll/rtl_433_ESP) branch
`sx1231-support`, which adds SX1231/RF69 receive support upstream does not have.
`platformio.ini` points at it and PlatformIO fetches it on the first build.

Node 22 or newer. `pio run` runs `dashboard/build.js` to generate the page it serves,
so run `npm install` in `../dashboard` before the first `pio run` — its `build.js`
imports `esbuild` from `dashboard/node_modules`.

## Wiring

| Signal | GPIO |
|---|---|
| MISO | 1 |
| MOSI | 42 |
| SCK | 41 |
| CS (NSS) | 40 |
| RST | 39 |
| DIO0 (IRQ) | 38 |
| DIO1 | 47 |
| DIO2 (data) | 21 |

DIO2 carries the demodulated data and is the pin the decoder reads. Change the
`RF_MODULE_*` values in `platformio.ini` to match your board.

## Configure

    cp .env.example .env

Fill in `WIFI_SSID`, `WIFI_PASSWORD`, and `MDNS_PREFIX`. `.env` is bash
syntax, gitignored, and read by `load_env.py`, which turns each entry into a
`-D` build flag. The build stops with an `#error` if it is absent.

The radio pin map and OOK settings are in `platformio.ini`.

## Build and flash

    pio run -e esp32s3-generic
    pio run -e esp32s3-generic -t upload
