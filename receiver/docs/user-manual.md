# User manual

## Routes

| Method and path | Behaviour |
|---|---|
| `GET /` | The live page. `200`, `text/html` |
| `GET /<topic>` | The stored message. `200`, `application/json`, `Cache-Control: no-store`. `404` if there is none |
| `POST /<topic>` | Set an alias. Body is a JSON string. `204` on success |
| `POST /$tz` | Store the GMT offset. Body is a JSON number, signed minutes. `204`; `405` unless the topic is `$tz` or under this receiver's source |
| `GET /events?f=<filter>&f=<filter>` | Subscribe. `200`, `text/event-stream` |

`GET` and `POST` share one handler, so a malformed topic is `400` regardless of
method.

### `GET /<topic>`

    GET /rtl433-a1b2c3/Acurite-5n1/1234

    200 application/json
    {"model":"Acurite-5n1","id":1234,"channel":1,"temperature_C":21.5,
     "humidity":54,"battery_ok":1,"mic":"CRC",
     "time":"2026-08-14T12:00:00Z","rssi":-70,"count":3}

A topic with no stored message is `404`, body `no message`. The receiver only
ever holds messages under its own source, so a `GET` for any other source's
topic is `404` too — there is nothing to distinguish that from a topic this
receiver simply hasn't heard yet.

`GET` of an alias topic returns the stored name as a JSON string:

    GET /rtl433-a1b2c3/Acurite-5n1/1234/$alias

    200 application/json
    "Back fence"

### `POST /<topic>`

Only a `POST` to an `$alias` topic under this receiver's own source is
accepted; every other `POST` — a non-`$alias` topic, or an `$alias` topic under
another source — is `405`, body `not allowed`.

    POST /rtl433-a1b2c3/Acurite-5n1/1234/$alias
    Content-Type: application/json

    "Back fence"

    204

A body that fails to parse as JSON, or parses to something other than a
string, is `400`, body `body must be a JSON string`, and the stored alias is
unchanged. A body of `""` removes the alias; the next `GET` of that topic is
then `404`.

    POST /rtl433-a1b2c3/Acurite-5n1/1234/$alias
    ""

    204

A `POST` that would exceed the 32-alias table, or the 2 KB blob the table
serialises to for storage, is `503`, body `alias store full`, and the alias is
not stored.

A malformed topic — empty, holding a wildcard character, holding a space, or
with an empty segment — is `400`, body `malformed topic`, for both `GET` and
`POST`.

### `POST /$tz`

Stores the GMT offset the dashboard uses to reset its daily rain counter at
local midnight. The body is a JSON number, signed minutes west of UTC negative:

    POST /rtl433-a1b2c3/$tz
    Content-Type: application/json

    -240

    204

The bare `/$tz` form works when the receiver is the origin the dashboard was
served from; the source-prefixed `/<source>/$tz` form is equivalent. A body
that is not a JSON number is `400`, body `body must be a JSON number`. A
`$tz` topic under another source is `405`. The offset survives a reboot via
NVS.

### `GET /events`

Filters use MQTT wildcards: `+` matches one segment, `#` matches the rest and
is only valid as the last segment. Up to four `f` parameters per connection,
each up to 64 bytes; a fifth, an over-long one, or a malformed one is `400`,
body `bad filter`, and the connection is not opened. Omitting `f` subscribes
to `#`.

    GET /events?f=rtl433-a1b2c3/Acurite-5n1/%2B&f=rtl433-a1b2c3/$alias

    200 text/event-stream
    retry: 3000

    data: {"topic":"rtl433-a1b2c3/Acurite-5n1/1234","payload":{...}}

    data: {"topic":"rtl433-a1b2c3/$alias","payload":"Garage"}

    :keepalive

A frame carries no event name. A device's payload is embedded as the JSON
object it already is; an alias's payload is a JSON string. A `:keepalive`
comment is sent to every open connection every 15 seconds.

A literal `+` in a query string decodes to a space before the receiver ever
sees it — that is how a query string is parsed, in this receiver and in the
bridge alike — and a filter segment holding a space is invalid. A client that
wants a single-segment wildcard has to send `%2B`, not a bare `+`.

With all four stream slots in use, a new connection evicts the longest-attached
one by closing its socket. The evicted browser's `EventSource` reconnects on
the server-sent `retry: 3000`, three seconds later. The five-second timer in
the page's own reconnect logic is a separate fallback for a non-200 response,
which eviction does not produce.

## Topics

A topic is `<source>/<model>/<id>`. `source` is this receiver's mDNS name,
`rtl433-a1b2c3`. `id` is the decode's `id` field when it has one, its `channel`
when it does not, and `0` when it has neither — the binding requires an id
segment, and a device with one instance uses `0`. The receiver's own telemetry
keys as `rtl433-a1b2c3/Receiver/0`.

A weather station reporting `rain_mm` (cumulative bucket tips since power-up)
also carries `rain_today_mm`, the rainfall since the start of the current local
day. The receiver derives this from a per-device baseline reset at local
midnight. The baseline is RAM-only, so a receiver reboot restarts today's
count from 0.

An alias is a topic with `$alias` appended as a final segment, at any of three
levels:

    rtl433-a1b2c3/$alias
    rtl433-a1b2c3/Acurite-5n1/1234/$alias
    rtl433-a1b2c3/Acurite-5n1/1234/temperature_C/$alias

## Retained replay

On connect, before any live frame, a subscriber receives the latest frame
retained for each message type of every device it is subscribed to, then
every alias, each sub visited once whether or not it currently holds
anything. A device that emits more than one `message_type` is delivered as
one frame per retained message type on connect, in sub-table order. The
dashboard merges these frames into a single card. This is table order, not
the order devices were last heard from, so a device heard from partway
through a subscriber's replay does not shift frames already sent or still to
come.

## Aliases

Aliases live at the source, device, and reading level, and round-trip through
`GET`, `POST`, and a `#` subscription like anything else. A missing `$alias`ed
topic is not an error; it means no alias is set. An alias set through `POST`
is written to NVS and survives a reboot — unless the receiver's NVS partition
did not open at startup, in which case a rename still returns `204` and holds
for the session, but is never written and is gone at the next reboot. That
case logs a warning to the serial console at startup; there is no way to tell
it apart from a normal `204` over HTTP.

An alias name longer than 31 bytes is truncated when stored, rather than
rejected.

The page posts a rename optimistically to its own alias map before the
request completes, and does not look at the response: any outcome other than
success — the device unreachable, a `400`, a `503` — leaves that browser
showing the new name while it never reaches the device, and so never reaches
any other viewer.

## The page

The receiver serves a build of the [dashboard](../../dashboard/README.md). See
[its user manual](../../dashboard/docs/user-manual.md) for the tabs, the card grid, and
edit mode.

## Cross-origin

Every response carries `Access-Control-Allow-Origin: *`, and `OPTIONS` on any topic is
`204` with `Access-Control-Allow-Methods: GET, POST, OPTIONS`. A dashboard served from
anywhere can therefore read this. There is no authentication for an origin check to
protect, so this exposes nothing a direct request did not.
