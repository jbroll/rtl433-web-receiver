# User manual

## Use

The mDNS name is `MDNS_PREFIX` plus the low three bytes of the MAC, so two
boards on one network do not collide. It is printed at startup along with the
IP address: `mDNS started: rtl433-a1b2c3.local`.

At boot the device tries to connect WiFi (stored credentials, or the `.env`
macros if there are none), up to 5 attempts of 20 seconds each, so a router
that is still booting after a power outage has time to come up. If every
attempt fails, or there are no credentials, it opens a `rtl433-receiver-XXXX`
SoftAP with a captive-portal setup page instead of decoding; the receiver's
normal UI, routes, and SSE are not up during provisioning. When credentials
are stored, the portal restarts the device after 10 minutes without a request
so it tries the network again; a board that has never been provisioned stays
in the portal. Holding the BOOT button ~3 seconds at boot clears
stored credentials and returns to this state — unless the build has `.env`
present, in which case it reconnects with the compiled-in credentials and
re-persists them on the same boot, never reaching the portal. See
`docs/install.md` for the full flow.

Once connected, WiFi is not required to keep decoding: if the connection
later drops, the sketch keeps decoding and logging to serial, and retries
reconnecting every 30 seconds without touching stored credentials.

## Publishing to a remote broker

The receiver can push every record, retained, to up to four MQTT brokers at
once: three configured from the dashboard's Settings tab (see below) plus
one always-on default from the `MQTT_BROKER_URL`/`MQTT_TOKEN` build flags
(`.env`) — off by default. The topic is the same key the receiver stores it
under locally, `<mdnsHostname()>/<model>/<id>`, and the payload is the
identical JSON `GET /<topic>` would return. A broker's token, if set, is
sent as the CONNECT password; a broker on the LAN often needs none.
Publishing is fire-and-forget per connection — a record that arrives while
a given broker is disconnected is simply not published to it — but every
successful connect or reconnect republishes everything currently held to
that broker, so one that was briefly unreachable catches back up without
waiting for each device's next natural transmission. One broker being
unreachable doesn't affect any other.

Add, update, or remove a bridge from the dashboard's Settings tab (see
`../../dashboard/docs/user-manual.md`'s "Bridges" section), or directly via
`POST /$mqtt` / `POST /$mqtt/remove` below. There's no way to edit a stored
token without re-adding the bridge; posting an already-known url updates its
token in place.

## Routes

| Method and path | Behaviour |
|---|---|
| `GET /` | The live page. `200`, `text/html` |
| `GET /<topic>` | The stored message. `200`, `application/json`, `Cache-Control: no-store`. `404` if there is none |
| `POST /<topic>` | Set an alias. Body is a JSON string. `204` on success, `403` off-origin |
| `POST /$tz` | Store the GMT offset. Body is a JSON number, signed minutes. `204`; `405` unless the topic is `$tz` or under this receiver's source, `403` off-origin |
| `POST /$units` | Store the unit preferences. Body is a JSON object. `204`; `405` unless the topic is `$units` or under this receiver's source, `403` off-origin |
| `POST /$mqtt` | Add or update a bridge to push to. Body `{"url":"...","token":"..."}`. `204` on success, `400` on an invalid url/token or a full table, `403` off-origin |
| `GET /$mqtt` | This receiver's active push connections. `200`, `application/json`: `[{"url":"...","connected":true}, ...]` — never the token |
| `POST /$mqtt/remove` | Stop pushing to a bridge. Body `{"url":"..."}`. `204` on success, including if the url wasn't present; `403` off-origin |
| `GET /events?f=<filter>&f=<filter>` | Subscribe. `200`, `text/event-stream` |
| `POST /$update` | Push a firmware image. `multipart/form-data`, bearer token required. `200` and reboots on success |

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
another source — is `405`, body `not allowed`. Every write route, this one
and `$tz`, `$layout`, `$location`, `$units`, `$mqtt`, is `403`, body
`off-origin`, when the request carries an `Origin` header whose host is not
this receiver's own `Host`. A request with no `Origin` header (curl) is
accepted; a browser page served by the receiver sends its own origin and is
accepted; a page on any other origin is refused.

    POST /rtl433-a1b2c3/Acurite-5n1/1234/$alias
    Content-Type: application/json

    "Back fence"

    204

A body that fails to parse as JSON, or parses to something other than a
string, is `400`, body `body must be a JSON string`, and the stored alias is
unchanged. A body of `""` removes the alias; the next `GET` of that topic is
then `404`. Every save is also published, retained, to each configured MQTT
bridge, and replayed to a bridge that connects later; a `""` body clears the
bridge's retained copy the same way.

    POST /rtl433-a1b2c3/Acurite-5n1/1234/$alias
    ""

    204

A `POST` whose topic is 103 characters or longer is `400`, body `alias too
long`. A name of 32 characters or longer is `400`, body `alias name too
long`. One that would exceed the 32-alias table, or the 2 KB blob the table
serialises to for storage, is `503`, body `alias store full`, and the alias is
not stored. Removing an alias that existed is `503`, body `alias remove
failed`, if the NVS persist write fails; removing a topic with no stored
alias always succeeds.

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
`$tz` topic under another source is `405`, and a browser request from another
origin is `403`. The offset survives a reboot via
NVS.

### `POST /$layout`

Stores the site-default card layout the dashboard's **Save as default layout**
button posts — one JSON object holding the grid size and a per-card entry,
kept verbatim. The receiver never reads inside it.

    POST /rtl433-a1b2c3/$layout
    Content-Type: application/json

    {"grid":{"cols":6,"rows":4},"order":["Acurite-5n1/1234"],"models":{...}}

    204

`GET` of the same path returns the stored object, or `404`, body `no message`,
when nothing is stored. Every save is also broadcast on `/events` and
published to each configured MQTT bridge, and replayed to a browser that
connects later.

The bare `/$layout` form works when the receiver is the origin the dashboard
was served from; the source-prefixed form is equivalent, and a `$layout` topic
under another source is `405`, and a browser request from another origin is
`403`. A body that is not a JSON object is `400`, body
`body must be a JSON object`. A body at or over 5 KB, or one NVS refuses to
write, is `503`, body `layout store full`, and the stored layout is unchanged.
5 KB holds all 24 device slots plus the four dashboard-computed cards, at
roughly 165 bytes each.

### `POST /$units`

Stores the units every visitor's dashboard renders in — one JSON object kept
verbatim. The receiver never reads inside it. The dashboard posts it on every
change to a unit or decimals control, and again with the **Save as default
layout** button, so one Save fills both stores.

    POST /rtl433-a1b2c3/$units
    Content-Type: application/json

    {"units":"metric","decimals":1,
     "custom":{"temp":"C","rain":"mm","wind":"km/h","pressure":"hPa"}}

    204

`GET` of the same path returns the stored object, or `404`, body `no message`,
when nothing is stored. Every save is also broadcast on `/events` and
published to each configured MQTT bridge, and replayed to a browser that
connects later, so a visitor gets the owner's units rather than picking their
own.

The bare `/$units` form works when the receiver is the origin the dashboard
was served from; the source-prefixed form is equivalent, and a `$units` topic
under another source is `405`, and a browser request from another origin is
`403`. A body that is not a JSON object is `400`, body
`body must be a JSON object`. A body at or over 256 bytes, or one NVS refuses
to write, is `503`, body `units store full`, and the stored units are
unchanged.

### `POST /$update`

Pushes a new firmware image over WiFi — the same shape as `pio run -t
upload`, without the serial cable. The body must be `multipart/form-data`
with the image in a field named `firmware`; a raw `--data-binary` body is
rejected the same as any other malformed request to this route, since the
firmware only streams the multipart form through incrementally, not a raw
POST body.

    curl -F firmware=@build/firmware.bin \
         -H "Authorization: Bearer generate-your-own-32-hex-chars" \
         'http://rtl433-a1b2c3.local/$update'

    200 ok

`tools/flash-ota.js` wraps this (`npx flash-ota rtl433-a1b2c3.local`) — see
`docs/development.md`.

The bearer token is set from the SoftAP captive portal's "Update token"
field (see `docs/install.md`) or from the `.env` `OTA_TOKEN` build flag if
none has been set through the portal yet. A missing or wrong
`Authorization` header is `401`; no token configured at all — neither
stored nor `.env` — is `404`, same as any other unrecognized route. A write
failure is `500`; a truncated transfer (connection dropped mid-upload) is
caught because the abort path never finalizes the write, and a file that
isn't a valid firmware image is caught by a magic-byte check. In every case
`otadata` is never updated, so a rejected or failed push is a no-op, not a
bricked device. The device reboots on the new firmware only after a `200`.

Quote the URL (or escape the `$`) — an unquoted `/$update` is a shell
variable expansion, not a literal path.

### `GET /events`

Filters use MQTT wildcards: `+` matches one segment, `#` matches the rest and
is only valid as the last segment. Up to four `f` parameters per connection,
each up to 64 bytes; a fifth, an over-long one, or a malformed one is `400`,
body `bad filter`, and the connection is not opened. Omitting `f` subscribes
to `#`.

    GET /events?f=rtl433-a1b2c3/Acurite-5n1/%2B&f=rtl433-a1b2c3/$alias

    200 text/event-stream
    retry: 15000

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

With all six stream slots in use, a new connection evicts the longest-attached
one by closing its socket. The evicted browser's `EventSource` reconnects on
the server-sent `retry: 15000`, fifteen seconds later. The five-second timer
in the page's own reconnect logic is a separate fallback for a non-200
response, which eviction does not produce.

## Topics

The receiver serves the source-only subset of the
[HTTP binding for MQTT](../../bridge/docs/binding.md): stable
`<source>/<model>/<id>` topics, the rtl_433 message as the payload, and an alias
at every level.

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

Every stored message carries `time` (ISO 8601 UTC, from SNTP), `rssi`, and
`count`, stamped in by the receiver. Until the clock is set `time` is absent and
the page ages that device from when it arrived.

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

The page posts a rename optimistically to its own alias map before the
request completes, and does not look at the response: any outcome other than
success — the device unreachable, a `400`, a `503` — leaves that browser
showing the new name while it never reaches the device, and so never reaches
any other viewer.

## The page

The receiver serves a build of the [dashboard](../../dashboard/README.md). See
[its user manual](../../dashboard/docs/user-manual.md) for the tabs, the card grid, and
edit mode, and [architecture.md](architecture.md) for the receiver's own card and its
telemetry fields.

`build` rides on the telemetry message. The page keeps the first id it sees and
reloads itself when a later one differs, so a reflash reboots the device, the
stream reconnects, and every open browser picks up the new page.

## Limits

- 24 devices tracked; a new decode evicts the least recently seen device once
  the table is full, and a slot unheard from for `DEVICE_STALE_HOURS` (72 by
  default, `0` to disable) is freed on its own. Weather sensors transmit every
  16–60 seconds, so the default only clears a genuinely dead one. Raise it if
  you receive TPMS, which is silent while a car is parked, or door contacts and
  remotes, which transmit only when triggered.
- payloads up to 600 bytes; a longer one is dropped rather than truncated
- 32 aliases
- 6 concurrent SSE clients, each subscribing up to 4 filters; a seventh client
  evicts the longest-attached one, whose browser reconnects on its own
- the radio monitors its own health once a minute; a stuck or parked radio is
  recovered by re-running the radio init.
  `radio_ok`, `recovery_count`, and `last_recovery_s` on the receiver's card
  carry the state

## Cross-origin

Every response carries `Access-Control-Allow-Origin: *`, and `OPTIONS` on any topic is
`204` with `Access-Control-Allow-Methods: GET, POST, OPTIONS`. A dashboard served from
anywhere can therefore read this. There is no authentication for an origin check to
protect, so this exposes nothing a direct request did not.
