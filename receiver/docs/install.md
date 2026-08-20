# Install

## Requirements

An ESP32-S3 and a HopeRF RFM69CW radio module, wired as below.

The library dependency is a fork,
[jbroll/rtl_433_ESP](https://github.com/jbroll/rtl_433_ESP) branch
`sx1231-support`, which adds SX1231/RF69 receive support upstream does not have.
`platformio.ini` points at it and PlatformIO fetches it on the first build.

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

The BMP280/AHT20 bus is on GPIO 21 (SCL) and GPIO 47 (SDA). Add 10k pull-ups
to 3V3 on both lines at the sensor header unless the breakout board already
provides them.

## Configure

    cp .env.example .env

Fill in `WIFI_SSID`, `WIFI_PASSWORD`, and `MDNS_PREFIX`. `.env` is bash
syntax, gitignored, and read by `load_env.py`, which turns each entry into a
`-D` build flag. The build stops with an `#error` if it is absent.

The radio pin map and OOK settings are in `platformio.ini`.

## Build and flash

    pio run -e esp32s3-generic
    pio run -e esp32s3-generic -t upload
