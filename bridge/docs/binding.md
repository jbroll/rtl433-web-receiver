# HTTP binding for MQTT

An HTTP surface over an MQTT-shaped namespace: three operations, stable topic
names, and an alias at every level. It is the contract three other projects are
written against, so it is specified on its own and implemented separately.

## Why

Before this binding, the receiver served `/api/state`, `/events`, and
`/api/status`, all shaped around its own device table. Nothing else could feed
that page, and the page could not read anything else. Aliases lived in one
browser's localStorage, so a name assigned in one place was invisible
everywhere else.

Naming every value the same way wherever it comes from, and carrying the alias
with the value, removes both limits. The receiver is one source among several
rather than the only one.

## Names

A topic is three segments:

    <source>/<model>/<id>

`source` identifies the publisher, `model` the device type, `id` the instance.
The id segment is always present; a device with one instance uses `0`. So the
receiver's own telemetry is `rtl433-a1b2c3/Receiver/0`.

This is the stable id. It is never renamed, and every alias resolves back to it.

A reading is named by appending the field name:

    <source>/<model>/<id>/<field>

That is not a separate topic. It is a key in the message, named so it can be
aliased and referred to.

The bridge is not part of a topic. It is the base URL a client is talking to. A
client holding several bridges qualifies a name locally as
`[bridge]/<source>/<model>/<id>/<field>`, and `[bridge]` is its own label for
that base URL.

## Payload

The rtl_433 JSON message, verbatim. A bridge stores the last message published
to a topic and returns it unchanged. It does not parse, normalise, reorder, or
strip fields.

Consumers already know how to read it: the page drops `model`, `id`, `channel`,
`protocol`, `rssi`, `duration`, `mic`, `message_type`, `sequence_num`, `time`,
`count`, and `build` to find the readings.

## Operations

| Method and path | Behaviour |
|---|---|
| `GET /<topic>` | The last message published to that topic. `404` if there is none. `Content-Type: application/json` |
| `POST /<topic>` | Publish a message. Body is the JSON. `204` on success |
| `GET /events?f=<filter>&f=<filter>` | Subscribe. `Content-Type: text/event-stream` |

Filters use MQTT wildcards: `+` matches one segment, `#` matches the rest.
Repeating `f` subscribes to several filters on one connection, which is what
keeps a dashboard watching many topics inside the browser's per-origin
connection limit and the receiver's four stream slots. Filters are fixed for the
life of the connection; changing them means reconnecting. Omitting `f`
subscribes to `#`.

Each SSE event's data is a JSON object:

    {"topic": "rtl433-a1b2c3/Acurite-5n1/1234", "payload": { ... }}

A subscriber receives the current retained message for every matching topic on
connect, then each message as it is published.

## Aliases

An alias is a topic whose last segment is `$alias`, holding a JSON string. It is
read, written, and streamed by the same three operations, and it arrives on a
`#` subscription like any other topic.

    rtl433-a1b2c3/$alias                                 "Garage"
    rtl433-a1b2c3/Acurite-5n1/1234/$alias                "Back fence"
    rtl433-a1b2c3/Acurite-5n1/1234/temperature_C/$alias  "Outside"

Aliases exist at the source, device, and reading levels. A missing `$alias` is
not an error; it means no alias is set.

Because `$alias` is the last segment, `<source>/+/+` still matches devices only
and `#` matches everything.

A display name resolves in this order:

1. The client's own configuration for that name
2. The `$alias` published by the bridge
3. The stable segment itself

The bridge's own alias is client configuration only, since the bridge does not
appear in a topic.

## Layout

`<source>/$layout` holds one JSON object: the site-default dashboard
arrangement, keyed by device model rather than device id so it survives a
device being replaced. It round-trips through `GET`, `POST`, and a `#`
subscription like any other topic — there is nothing binding-specific about
it, it is simply a topic whose payload happens to be a layout rather than a
sensor reading or a name.

    rtl433-a1b2c3/$layout   {"grid":{"cols":6,"rows":4},"order":[...],"models":{...}}

A missing `$layout` is not an error; it means no site default has been
saved. The shape of the object itself (`grid`/`order`/`models`) is a
dashboard convention, not part of this binding — a bridge or a receiver
never inspects it, only stores and forwards it.

## Location

`<source>/$location` holds one JSON object: the receiver's configured
location and timezone name, the same shape `settings.value.location` uses on
the dashboard. It round-trips through `GET`, `POST`, and a `#` subscription
like any other topic — there is nothing binding-specific about it, it is
simply a topic whose payload happens to be a location rather than a sensor
reading or a name.

    rtl433-a1b2c3/$location   {"lat":40.015,"lon":-105.2705,"label":"Boulder","zone":"America/Denver","zoom":12}

A missing `$location` is not an error; it means no location has been saved.
The shape of the object itself is a dashboard convention, not part of this
binding — a bridge or a receiver never inspects it, only stores and forwards
it.

`<source>/$tz` holds the receiver's UTC offset in whole minutes, as a JSON
number, used to set the receiver's own clock. It round-trips the same way;
unlike `$location` and `$layout`, it is never unset — a fresh receiver's
`$tz` defaults to `-240`.

    rtl433-a1b2c3/$tz   -420

## Errors

| Status | When |
|---|---|
| `400` | Malformed topic, malformed filter, or a body that is not JSON |
| `404` | `GET` of a topic with no retained message |
| `401` | `POST` with a missing or wrong bearer token, when the implementation has auth enabled |
| `405` | An operation the implementation does not offer for that topic |
| `408` | An implementation that enforces an idle timeout on the request body, on a `POST` that stalls |
| `413` | An implementation that caps the request body size, on a `POST` over that cap |
| `503` | The bridge's backend is unavailable |

An implementation that refuses an operation returns `405` rather than silently
accepting it, so a client can tell what will actually happen.

The body cap and any idle timeout on receiving it are implementation-defined;
the binding names no fixed limit. An implementation may refuse an oversized
`POST` body outright rather than accept a payload of unbounded size.

`401` is implementation-specific, the same way CORS is: not every implementation
of this binding has to gate writes behind a token, and a client should not assume
one that doesn't answers `401` to anything. The receiver's own source-only subset
keeps its existing `405` answer for a `POST` to anything other than `$alias`,
`$tz`, `$layout`, or `$location` regardless.

Every response carries `Access-Control-Allow-Origin: *`, so a dashboard on any
origin can read any source.

## Implementations

Both ship in this repo, differing only in what they refuse.

**A bridge over a real broker** implements all three operations over the whole
topic space. Retained messages come from the broker's own retain. Publishing to
`$alias` topics is publishing a retained message like any other.

**The receiver's source-only subset** serves `GET` and `/events` for topics
under its own `source`, and accepts `POST` only to its own `$alias`, `$tz`,
`$layout`, and `$location` topics, each persisted to NVS. Every other `POST`
is `405`.
Its `source` is the existing mDNS name, `rtl433-a1b2c3`.

What the binding deliberately does not have: QoS, an addressable retain flag,
sessions, last-will messages, unsubscribe, or per-field publishing. A client
cannot reach them through the HTTP binding, and neither implementation needs
them.

## Testing

The spec is the test list. Both implementations run the same cases:

- A topic with no message is `404`; after a `POST` the same `GET` returns the
  body byte for byte.
- A `POST` of a non-JSON body is `400`, and does not change the retained
  message.
- `+` matches exactly one segment and `#` matches the remainder; a filter
  matching nothing yields a stream that opens and stays empty.
- Repeated `f` delivers from every filter on the one connection, and a topic
  matching two filters is delivered once.
- A subscriber receives retained messages on connect before any live one.
- `$alias` round-trips through `GET`, `POST`, and a `#` subscription, and a
  device with no alias omits the topic rather than returning an empty string.
- `$location` and `$tz` round-trip through `GET`, `POST`, and a `#`
  subscription the same way `$layout` does; `$tz`'s `GET` never `404`s, since
  a receiver always has some offset.
- The receiver returns `405` for a `POST` to a topic that is not `$alias`,
  `$tz`, `$layout`, or `$location`, and a value written to any of the four
  survives a reboot.

## What this unblocked

- `bridge/`, a standalone service implementing the full binding.
- The receiver's `/api/state` and `/events` replaced by the subset above.
- `dashboard/`, reading a configurable list of sources, with the browser's
  layout config layered over the aliases each source publishes.
