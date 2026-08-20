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

## Environment variables

All are read once at startup, in `src/config.js`. Every field below except
`PORT`, `HOST`, `MQTT_USERNAME`, and `MQTT_PASSWORD` also has a CLI flag; a flag
takes precedence over its environment variable, which takes precedence over
the default.

| Variable | CLI flag | Default | Notes |
|---|---|---|---|
| `MQTT_URL` | `--broker-url` | `mqtt://localhost:1883` | Only consulted when `EMBED_BROKER` is `false`. |
| `PORT` | — | `8080` | Must be an integer 0–65535. An empty string, a non-numeric value, or a value outside that range makes the bridge refuse to start rather than fall back to the default. |
| `HOST` | — | `0.0.0.0` | Interface the HTTP server binds to. |
| `MQTT_USERNAME` | — | unset | Passed to the broker if set. |
| `MQTT_PASSWORD` | — | unset | Passed to the broker if set. |
| `EMBED_BROKER` | `--no-embed-broker` | `true` | `false` (or the flag) disables the embedded broker and dials `MQTT_URL`/`--broker-url` instead, like every version of the bridge before this. |
| `MQTT_PORT` | `--mqtt-port` | `1883` | The embedded broker's plaintext loopback port, used when no TLS cert/key is configured. |
| `MQTTS_PORT` | `--mqtts-port` | `8883` | The embedded broker's public TLS port, used when a cert/key is configured. |
| `TLS_CERT` | `--tls-cert` | unset | PEM certificate file. Presence (with `TLS_KEY`) switches the embedded broker from the loopback-plaintext listener to the public-MQTTS one. |
| `TLS_KEY` | `--tls-key` | unset | PEM key file. |
| `AUTH_TOKEN` | `--auth-token` | unset | Shared secret gating HTTP `POST` (`401` without it) and, when embedding with TLS, MQTT `CONNECT` (refused without it). Required if `TLS_CERT`/`TLS_KEY` are set — the bridge refuses to start otherwise. |

## The embedded broker

By default (`EMBED_BROKER` unset or `true`), the bridge starts its own
`aedes` MQTT broker in-process rather than dialing out to one — nothing
external has to be running first. Without `TLS_CERT`/`TLS_KEY`, it binds
plain MQTT to `127.0.0.1:<MQTT_PORT>`, loopback only. With them, it binds
MQTTS to `0.0.0.0:<MQTTS_PORT>`, publicly reachable, and requires
`AUTH_TOKEN` on every `CONNECT`. Only one of these two ever runs.

`npm install` also pulls `aedes`, now a runtime dependency (it always did
pull it as a dev dependency for the test suite; embedding needs it at
runtime too).

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
HTTP server, the broker connection, and the embedded broker (if running) in
that order, so a plain `sv down` is enough to stop it cleanly.

## Deploying to weather.rkroll.com

`bridge/deploy.conf` and `bridge/secrets.env.example` in this repo are set up
for that deploy, using the `deploy.sh` system. Copy `secrets.env.example` to
`secrets.env` (gitignored) and fill in `AUTH_TOKEN` — generate one with
`openssl rand -hex 24` — before running `deploy init`.

TCP 8883 opens automatically during `deploy init` via the firewall module,
set in `DEPLOY_TYPES` and `NODE_APP_PUBLIC_PORTS="8883"`. The module runs
on Debian only and requires `ufw` to already be installed and active; it
warns and skips if `ufw` is inactive. Your deployed `deploy.sh` checkout
must include the firewall module; without it, `DEPLOY_TYPES` resolution
fails loudly.
