# User manual

The bridge exposes three HTTP operations over an MQTT-shaped topic
namespace. The protocol itself — topic naming, aliases, payload shape — is
specified in [`docs/binding.md`](binding.md); this document covers running
the bridge and what each HTTP call does.

## Configuration

Set as environment variables before starting the process (see
[`docs/install.md`](install.md) for defaults):

| Variable | Purpose |
|---|---|
| `MQTT_URL` | Broker to connect to, e.g. `mqtt://broker.local:1883`. |
| `PORT` | HTTP port to listen on. |
| `HOST` | Interface to bind. |
| `MQTT_USERNAME` | Broker username, if the broker requires one. |
| `MQTT_PASSWORD` | Broker password, if the broker requires one. |

## GET a topic

Returns the last message published to that topic.

```
curl -i localhost:8080/rtl433-a1b2c3/Acurite-5n1/1234
```

- `200`, `Content-Type: application/json`, body is the retained message
  verbatim.
- `404` if nothing has been published to that topic.
- `400` if the topic is malformed (empty, contains a space, or contains an
  MQTT wildcard `+` or `#`).
- `503` if the bridge is not currently connected to the broker.

## POST to a topic

Publishes a message. The body becomes the new retained message for that
topic.

```
curl -i -X POST localhost:8080/rtl433-a1b2c3/Acurite-5n1/1234 \
  -d '{"temperature_C":21.5}'
```

- `204` on success, empty body.
- `400` if the body is not valid JSON, or the topic is malformed.
- `503` if the bridge is not currently connected to the broker, or the
  publish itself fails.

A `204` means the message is readable: a `GET` of the same topic immediately
after returns the body byte for byte, without waiting for the broker to echo
the publish back.

Publishing to a `$alias` topic works the same way; see
[`docs/binding.md`](binding.md#aliases).

## GET /events — subscribe

Opens a Server-Sent Events stream. Each `f` parameter is one MQTT-style
filter (`+` for one segment, `#` for the rest); repeat `f` to subscribe to
several filters on one connection. Omitting `f` subscribes to `#`, every
topic.

```
curl -N 'localhost:8080/events?f=rtl433-a1b2c3/%23'
```

An unescaped `#` is a URL fragment and is stripped by the client before the
request is sent, so it must be percent-encoded as `%23`.

- `200`, `Content-Type: text/event-stream`. On connect, the current retained
  message for every topic matching a filter is sent first, then each
  message as it is published. Each event's `data` is a JSON object:
  `{"topic": "...", "payload": {...}}`.
- `400` if any filter is malformed.
- `503` if the bridge is not currently connected to the broker.

Filters are fixed for the life of the connection. To change what a client
watches, it reconnects with new `f` parameters.

## Other status codes

- `405` — a method other than GET/POST on a topic path, or anything but GET
  on `/events`.

`400`, `404`, `405`, and `503` are the only statuses the binding defines. A
`500` means an unforeseen error inside the bridge, which is a bug.
