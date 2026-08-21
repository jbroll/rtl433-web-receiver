# rtl433-web-receiver

A 433 MHz receiver, an HTTP surface over MQTT, and one dashboard that reads either.

Four sub-projects, each built and tested on its own:

- [`receiver/`](receiver/README.md) — an ESP32-S3 with an SX1231 radio. Decodes 433 MHz
  sensors, holds their last message, and serves the dashboard and an SSE stream.
- [`bridge/`](bridge/README.md) — the same HTTP surface over a real MQTT broker, as a
  node service.
- [`dashboard/`](dashboard/README.md) — the browser page, built to one self-contained
  file. Reads a list of receivers and bridges at once. The receiver embeds a build of it.
- [`app/`](app/README.md) — a Capacitor 7 shell around the dashboard for Android and iOS.

They share one protocol, the [HTTP binding for MQTT](bridge/docs/binding.md): stable
`<source>/<model>/<id>` topics, the rtl_433 JSON message as the payload, and an alias at
every level carried as a `$alias` topic.

    (cd dashboard && npm install && npm run build)
    (cd receiver && pio run -e esp32s3-generic -t upload)
    (cd bridge && npm install && MQTT_URL=mqtt://broker.local:1883 node bin/mqtt-http-bridge.js)
    (cd dashboard && npm start)

A freshly flashed receiver opens a SoftAP captive portal to collect WiFi
credentials; `cp receiver/.env.example receiver/.env` first is an optional
shortcut that skips it.

- [`docs/quickstart.md`](docs/quickstart.md) — shortest path to a signal on the page
- [`docs/architecture.md`](docs/architecture.md) — how the three fit together
- [`docs/backlog.md`](docs/backlog.md) — the roadmap and anything spanning sub-projects
