# User manual

The bridge exposes three HTTP operations over an MQTT-shaped topic
namespace. The protocol itself — topic naming, aliases, payload shape — is
specified in [`docs/binding.md`](binding.md); this document covers running
the bridge and what each HTTP call does.

## Configuration

Set as environment variables (or the matching CLI flag) before starting the
process (see [`docs/install.md`](install.md) for the full table and
defaults):

| Variable | Purpose |
|---|---|
| `MQTT_URL` | Broker to dial when `EMBED_BROKER=false`, e.g. `mqtt://broker.local:1883`. |
| `PORT` | HTTP port to listen on. |
| `HOST` | Interface to bind. |
| `MQTT_USERNAME` | Broker username, if the broker requires one. |
| `MQTT_PASSWORD` | Broker password, if the broker requires one. |
| `EMBED_BROKER` | `false` to dial `MQTT_URL` instead of starting an embedded broker (default: embed). |
| `TLS_CERT` / `TLS_KEY` | Configuring both switches the embedded broker to public MQTTS and requires `AUTH_TOKEN`. |
| `AUTH_TOKEN` | Shared secret for `POST` (HTTP) and `CONNECT` (MQTT, TLS mode only). Unset disables both checks. |
| `AUTH_TOKEN_PATH` | File the current token is persisted to; see [Rotating the token](#post-authrotate--rotate-the-token) below. |
| `MAX_SSE_CLIENTS` | Concurrent `/events` streams allowed before a new one is refused. |
| `MAX_SSE_FILTERS` | `f` parameters allowed on one `/events` subscription before it is refused. |

## GET a topic

Returns the last message published to that topic.

```
curl -i localhost:8080/rtl433-a1b2c3/Acurite-5n1/1234
```

- `200`, `Content-Type: application/json`, body is the retained message
  verbatim, byte for byte, including bytes that are not valid UTF-8.
- `404` if nothing has been published to that topic, if its retained message
  was deleted by a zero-length publish on the broker, or if the last message
  on it is empty. A deletion the bridge sees live is cached as an empty
  message, because the broker clears the retain flag on what it forwards, and
  its SSE event carries `deleted: true` (see
  [GET /events](#get-events--subscribe)); one the bridge sees at reconnect
  removes the topic from the cache entirely. Both answer `404` here.
- `400` if the topic is malformed (empty, contains a space, contains an
  MQTT wildcard `+` or `#`, or has an empty segment).
- `503` if the bridge is not `ready` (see
  [GET /status](#get-status--bridge-and-broker-state)): not connected to the
  broker, or connected but without its `#` subscription in place yet.

## POST to a topic

Publishes a message. The body becomes the new retained message for that
topic. A zero-length body deletes the topic instead.

```
curl -i -X POST localhost:8080/rtl433-a1b2c3/Acurite-5n1/1234 \
  -d '{"temperature_C":21.5}'
```

With `AUTH_TOKEN` set:

```
curl -i -X POST localhost:8080/rtl433-a1b2c3/Acurite-5n1/1234 \
  -H 'Authorization: Bearer <AUTH_TOKEN>' \
  -d '{"temperature_C":21.5}'
```

Deleting a topic:

```
curl -i -X POST localhost:8080/rtl433-a1b2c3/Acurite-5n1/1234 -d ''
```

- `204` on success, empty body.
- `400` if the body is non-empty and not valid JSON, is not valid UTF-8, or
  the topic is malformed. A zero-length body skips JSON validation entirely.
- `413` if the body exceeds 64 KiB.
- `408` if the body stalls for 30 seconds without a new byte arriving.
- `503` if the bridge is not `ready` (not connected to the broker, or
  connected but without its `#` subscription in place yet), or the broker did
  not take the publish within 5 seconds.
- `401` if `AUTH_TOKEN` is configured and the request's `Authorization: Bearer <token>`
  header is missing or wrong.

A `204` means the broker has taken the message and sent it back over the
bridge's own subscription: a `GET` of the same topic immediately after
returns the body byte for byte, and a subscriber already connected has
received it. The `POST` is held for the round trip that takes.

Deleting a topic follows the same round trip: a `GET` afterward is `404`, and
a subscriber connecting after the delete is not replayed it. A subscriber
already connected receives an event for it with `deleted: true` (see
[GET /events](#get-events--subscribe) below).

Publishing to a `$alias` topic works the same way; see
[`docs/binding.md`](binding.md#aliases). `$layout`, the site-default
dashboard arrangement, is documented at
[`docs/binding.md`](binding.md#layout).

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
  `{"topic": "...", "payload": {...}}`. A topic the bridge is deleting
  carries `deleted: true` alongside `topic` and `payload`; a deleted topic is
  not replayed to a subscriber connecting afterward.
- `400` if any filter is malformed, or if more than `MAX_SSE_FILTERS` `f`
  parameters are given.
- `503` if the bridge is not `ready` (not connected to the broker, or
  connected but without its `#` subscription in place yet), or if
  `MAX_SSE_CLIENTS` streams are already open.

A stream that falls a megabyte behind on reading its events is dropped: the
connection is closed and it stops counting against `MAX_SSE_CLIENTS`. A client
that sees its stream end unexpectedly should assume this and reconnect rather
than treat it as an error.

Filters are fixed for the life of the connection. To change what a client
watches, it reconnects with new `f` parameters.

A client must tolerate the same message arriving more than once. When the
bridge's own connection to the broker drops and is remade, it is replayed
every retained message and passes each one on, so an open stream is re-sent
every topic it matches, unchanged values included. Nothing marks these as a
replay; a client that acts on each event should be able to act on a repeat.

## POST /auth/rotate — rotate the token

Replaces the current `AUTH_TOKEN` with a new one, in place, with no restart.

```
curl -i -X POST localhost:8080/auth/rotate \
  -H 'Authorization: Bearer <current-token>' \
  -d '{"token":"<new-token>"}'
```

- `204` on success. From that point, `POST` to any topic and (in TLS mode)
  new MQTT `CONNECT`s require the new token; the old one is rejected.
- `400` if the body is not JSON or not valid UTF-8, or `token` is missing or
  empty (including a body of `null`).
- `413` if the body exceeds 64 KiB.
- `408` if the body stalls for 30 seconds without a new byte arriving.
- `401` if the `Authorization` header is missing or does not match the
  *current* token.
- `404` if no `AUTH_TOKEN` is configured — there is nothing to rotate.
- `405` for any method other than `POST`.

Rotation only gates new connections. An MQTT client already past `CONNECT`
under the old token keeps working until it disconnects on its own — nothing
force-disconnects it. The bridge's own internal connection to its embedded
broker is unaffected either way: it authenticates once at startup and never
reconnects because of a rotation.

Without `AUTH_TOKEN_PATH` configured, a rotated token lives only in the
running process's memory and is lost on restart, reverting to `AUTH_TOKEN`.
With it set, rotation also overwrites that file, and it is read back at the
next startup in place of `AUTH_TOKEN`. The file is written mode `0600`; the
directory holding it should not be world-readable.

## GET /status — bridge and broker state

Reports whether the bridge is usable, without publishing or subscribing to
anything. Always `200`, even while the broker is down — that state is in the
body, not the status code.

```
curl localhost:8080/status
```

```json
{"connected":true,"ready":true,"broker":"mqtt://broker.local:1883","cacheSize":42,"sseClients":2,"lastError":null}
```

- `connected` — the MQTT connection is up (CONNACK received, no `close` since).
- `ready` — the `#` subscription that fills the cache is in place. `connected`
  can be `true` while this is `false`, briefly after reconnecting and while a
  subscribe is refused; every other endpoint's `503` gate is on this, not on
  `connected`.
- `broker` — the broker's `protocol://host:port`, from `MQTT_URL` with any
  credentials stripped.
- `cacheSize` — retained messages currently cached.
- `sseClients` — open `/events` streams.
- `lastError` — the most recent connection or subscribe error's message, or
  `null` if none has happened yet. A username or password would never appear
  here: it is stripped the same way `broker` is.

No `AUTH_TOKEN` check applies; nothing in the body identifies a source or
reveals a credential.

## Other status codes

- `401` — a `POST` with a missing or wrong bearer token, when `AUTH_TOKEN` is configured.
- `405` — a method other than GET/POST on a topic path, or anything but GET
  on `/events` or `/status`.
- `503` — `GET /events` at the `MAX_SSE_CLIENTS` limit.
- `400` — `GET /events` with more than `MAX_SSE_FILTERS` `f` parameters.

`400`, `404`, `405`, `401`, and `503` are the only statuses the binding
defines. `408` and `413` are this bridge's own answer to a stalled or
oversized `POST` body, not part of the binding. A `500` means an unforeseen
error inside the bridge, which is a bug.

## Cross-origin

Every response carries `Access-Control-Allow-Origin: *`, and `OPTIONS` on any topic is
`204` with `Access-Control-Allow-Methods: GET, POST, OPTIONS`. A dashboard served from
anywhere can therefore read this, including the bridge's own origin: `GET /`, with
`DASHBOARD_HTML` configured, serves a built dashboard directly (see
[`docs/install.md`](install.md#serving-the-dashboard)). With `AUTH_TOKEN` set, `POST`
still requires the token regardless of origin, so the wildcard origin doesn't weaken
that: a cross-origin caller still needs the token to publish.

The dashboard's own way of holding that token is described in
[Access token](../../dashboard/docs/user-manual.md#access-token): a Settings
field, stored per bridge origin, attached as `Authorization: Bearer <token>` on the
writes it makes to the origin serving it.
