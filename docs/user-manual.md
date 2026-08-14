# User manual

## Routes

| Method and path | Behaviour |
|---|---|
| `GET /` | The live page. `200`, `text/html` |
| `GET /<topic>` | The stored message. `200`, `application/json`, `Cache-Control: no-store`. `404` if there is none |
| `POST /<topic>` | Set an alias. Body is a JSON string. `204` on success |
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

An alias is a topic with `$alias` appended as a final segment, at any of three
levels:

    rtl433-a1b2c3/$alias
    rtl433-a1b2c3/Acurite-5n1/1234/$alias
    rtl433-a1b2c3/Acurite-5n1/1234/temperature_C/$alias

## Retained replay

On connect, before any live frame, a subscriber receives the message currently
stored for every topic it is subscribed to: every device slot in turn, then
every alias, each slot visited once whether or not it currently holds
anything. This is table order, not the order devices were last heard from, so
a device heard from partway through a subscriber's replay does not shift
frames already sent or still to come.

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

Three tabs — Devices, Log, Cards — and the page opens on Cards. The status
indicator in the header reads `connecting`, `live`, or `reconnecting`.

### Devices

One row per device: Model, ID, Reading (every field merged from messages seen
so far, since a device like the Acurite 5n1 splits its data across message
types), RSSI, Msgs, Age, an Alias box, and a Card checkbox.

The Reading column excludes the fields the page treats as metadata rather than
a sensor value: `model`, `id`, `channel`, `protocol`, `rssi`, `duration`,
`mic`, `message_type`, `sequence_num`, `time`, `count`, and `build`. A value in
the merge can come from an earlier message than the row's own Age, which
tracks the newest message regardless of which fields it carried; a value can
therefore be older than the age column shows.

The Alias box names that device's card, the same name double-clicking the card
label sets; both post to `<topic>/$alias`, so a name assigned in either place
is visible to every viewer. Emptying the box posts `""`, which removes the
alias and puts the topic's own key back as the name.

A new device gets no card. The Card checkbox is how it gets one, and it is the
same setting as the ✕ on the card in edit mode, so a device hidden either way
shows unchecked here. This is what keeps decodes from protocols nobody owns —
which arrive on any 433 MHz receiver — off the dashboard by default.

The table rebuilds every second but holds still while a text box or a select
in it has focus, so an entry in progress is never interrupted. Only the tab on
screen is rebuilt; switching to one draws it.

Under each device is one row per reading, carrying that reading's current
value and a select for its display mode. This is where a card's contents are
chosen; the card's own edit mode only arranges what is already there.

Every reading has three display modes: Shown puts it in the card body at full
size, Bottom puts it small and labelled along the bottom-left edge (mirroring
the age at bottom-right, which is where a battery flag belongs), and Hidden
drops it. rtl_433's status fields (`battery_ok`, `test`, `tamper`, and the
rest) start at Bottom; everything else starts Shown.

### Log

Raw messages as they arrive, newest first, capped at 200 rows in the browser.
The device keeps no history of its own, so the Log starts empty on every page
load — nothing before the page connected can be replayed into it.

### Cards

Cards is the tab the page opens on. It lays every device whose card is checked
in the device table on a grid of square cells. Two number inputs in edit mode
set the columns and rows, 6 × 4 by default and 1–24 each; the cell side is
whichever of width ÷ columns and height ÷ rows is smaller, so the grid fits on
screen with margin on the other axis. Nothing narrows the default for a small
screen, so a phone gets the full 6 × 4 grid of very small cells until the user
sets smaller numbers.

A card spans whole cells. On first detection it is sized to hold its visible
readings one per cell, in the most compact rectangle: one reading gives 1×1,
three or four give 2×2, seven through nine give 3×3. Dragging the corner
handle in edit mode resizes it, snapped to whole cells, from 1×1 up to the
grid's own dimensions. Type size follows the measured cell, so a bigger card
reads bigger, and shrinks further where a reading is too wide to fit at that
size. Every reading on a card takes the same size, the one its widest needs.
Cards that do not fit in the set number of rows render below the fold.

Layout is per browser, in localStorage under `rtl433.cards.v2`: the grid size,
the card order, which cards are hidden, and per card a size in cells, the
value order, and which values are hidden or at the bottom. No name is stored
there; a card's name is the published alias, or the device's key if none is
set. Layout is never sent to the device, so two browsers can arrange the same
receiver differently.

A card the user showed or renamed is kept even after its device goes quiet, so
a sensor that returns finds its card as it left it. A card that was never
shown is dropped once its device is gone from the table, which is what keeps a
band full of one-off false decodes from growing the stored layout without
limit.

Forget layouts, in edit mode, clears the lot after a confirmation prompt. The
devices on screen at the time keep their cards; only ones seen afterwards
start hidden.

### Cards edit mode

The pencil button opens edit mode, which arranges the card and nothing else:
cards drag to reorder, values drag to reorder within their card, the corner
handle resizes, ✕ hides the card, and double-clicking the label renames it (and
posts the alias). A card shows the same values in edit mode as out of it; what
appears is the card's own controls, plus hidden cards drawn as ghosts. A long
device name in the label ellipsizes rather than overflowing the card; readings
round to one or two decimal places for display, without changing the stored
values.
