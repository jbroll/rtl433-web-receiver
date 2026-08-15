# Install

## Requirements

- Node 22 or later.
- One runtime dependency, `mqtt`, installed via `npm install`.
- An MQTT broker reachable from wherever the bridge runs. It does not have
  to be up when the bridge starts: the bridge listens immediately, answers
  `503` until the broker answers, and starts serving once it does.

## From a clone

```
git clone <repo> rtl433-web-receiver
cd rtl433-web-receiver/bridge
npm install
MQTT_URL=mqtt://broker.local:1883 node bin/mqtt-http-bridge.js
```

`npm install` also pulls `aedes`, a dev dependency used only by the test
suite. It is not needed to run the bridge.

## Environment variables

All are read once at startup, in `src/config.js`.

| Variable | Default | Notes |
|---|---|---|
| `MQTT_URL` | `mqtt://localhost:1883` | The broker to connect to. |
| `PORT` | `8080` | Must be an integer 0–65535. An empty string, a non-numeric value, or a value outside that range makes the bridge refuse to start rather than fall back to the default. |
| `HOST` | `0.0.0.0` | Interface the HTTP server binds to. |
| `MQTT_USERNAME` | unset | Passed to the broker if set. |
| `MQTT_PASSWORD` | unset | Passed to the broker if set. |

## As a runit service

The receiver's own host runs Void, where services are runit directories
under `/etc/sv`. A minimal one:

```
/etc/sv/mqtt-http-bridge/
  run
  env/
    MQTT_URL
    PORT
```

`run`:

```sh
#!/bin/sh
exec 2>&1
cd /opt/mqtt-http-bridge
exec chpst -e /etc/sv/mqtt-http-bridge/env -u mqtt-http-bridge \
  node bin/mqtt-http-bridge.js
```

Each file under `env/` holds one variable's value. `runsv` does not read the
directory itself, so `chpst -e` has to name it; without that the service runs
on the defaults, quietly talking to `mqtt://localhost:1883`. Enable with
`ln -s /etc/sv/mqtt-http-bridge /var/service/`.

The bridge exits 0 on `SIGTERM`, after closing every open SSE stream, the
HTTP server, and the broker connection in that order, so a plain `sv down`
is enough to stop it cleanly.
