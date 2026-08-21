# rtl433-web-receiver

An ESP32-S3 with an SX1231/RFM69 radio at 433.92 MHz. It decodes 433 MHz sensors
with [rtl_433_ESP](https://github.com/NorthernMan54/rtl_433_ESP), joins WiFi, and
serves a page listing every signal it hears, updating as they arrive.

- [`docs/quickstart.md`](docs/quickstart.md) — build, flash, and see a signal
- [`docs/install.md`](docs/install.md) — wiring, WiFi setup, build and flash
- [`docs/user-manual.md`](docs/user-manual.md) — every route, status, topic, and limit
- [`docs/architecture.md`](docs/architecture.md) — module boundaries and the tradeoffs
- [`docs/development.md`](docs/development.md) — repo layout, the serial monitor, and testing without a radio
