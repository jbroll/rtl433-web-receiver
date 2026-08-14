# mqtt-http-bridge

An HTTP surface over an MQTT broker: GET a topic's last retained message,
POST to publish one, or open an SSE stream to subscribe. For a service or
script that needs MQTT but would rather speak HTTP.

    MQTT_URL=mqtt://broker.local:1883 npx mqtt-http-bridge

    curl localhost:8080/rtl433-a1b2c3/Acurite-5n1/1234
    curl -N 'localhost:8080/events?f=rtl433-a1b2c3/%23'

The `%23` matters: an unescaped `#` in a URL is a fragment and never reaches
the server.

- [`docs/install.md`](docs/install.md) — running it, environment variables, a runit service
- [`docs/user-manual.md`](docs/user-manual.md) — every operation and status code
- [`docs/binding.md`](docs/binding.md) — the protocol this implements
- [`docs/architecture.md`](docs/architecture.md) — module boundaries and the tradeoffs
- [`docs/development.md`](docs/development.md) — repo layout and tests
- [`docs/backlog.md`](docs/backlog.md) — what's deliberately left undone
