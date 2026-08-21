# Quickstart

```
cd bridge && npm install
MQTT_URL=mqtt://broker.local:1883 node bin/mqtt-http-bridge.js
```

No broker to hand? Leave `MQTT_URL` unset — the bridge embeds its own
`aedes` broker on loopback by default:

```
cd bridge && npm install
node bin/mqtt-http-bridge.js
```

Either way it listens on `:8080`:

```
curl localhost:8080/rtl433-a1b2c3/Acurite-5n1/1234
curl -N 'localhost:8080/events?f=rtl433-a1b2c3/%23'
```

See [`docs/install.md`](install.md) for environment variables, TLS, and
running as a service, and [`docs/binding.md`](binding.md) for the protocol.
