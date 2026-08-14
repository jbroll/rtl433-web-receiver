# The HTTP binding in the receiver

Roadmap project 3 (`docs/backlog.md`). The receiver stops serving `/api/state`,
`/api/status`, and its own SSE shape, and serves the source-only subset of the
binding specified in `~/src/mqtt-http-bridge/docs/binding.md`.

The receiver becomes one source among several. Its device keys become stable
topics, its aliases move out of one browser's localStorage onto the device, and
the page reads the same shape it will read from a bridge.

## Names

`source` is `mdnsHostname()`, which already produces `rtl433-a1b2c3`.

A device topic is `<source>/<model>/<id>`. `signal_store::buildKey` builds it
from the decode: `id` when the message has one, `channel` when it does not, and
`0` when it has neither, because the binding requires the id segment. The
receiver's own telemetry keys as `<source>/Receiver/0`.

`SIGNAL_KEY_MAX` goes from 48 to 96 bytes. rtl_433 model names run past 48
characters, so today two devices whose names share a long prefix truncate into
one slot; the source segment makes that worse. 96 holds a 14-byte source, a
64-byte model, and a 16-byte id.

## Payload

`signal_store::record()` parses the decode into a `JsonDocument` already. It
now sets three fields before serialising it into the slot:

- `time`, an ISO 8601 UTC timestamp, `2026-08-14T12:00:00Z`
- `rssi`, the value the radio reported for this decode
- `count`, how many messages this device has sent since boot

Setting a key that is already present keeps its position, and a new key appends,
so the rest of the message survives in order. The page's `META` set already
drops `time` and `rssi` from the readings; `count` joins it.

`SIGNAL_PAYLOAD_MAX` goes from 512 to 600 bytes to hold the stamped fields
without cutting a long message. Deleting the event ring (below) frees far more
than this costs.

### Time

The device has no RTC, so `time` comes from SNTP: `configTime` against
`pool.ntp.org` once WiFi is up, resynced on each reconnect. Until the first
sync, `record()` omits `time` and the page shows no age for that device.

This is what makes an age computable from a retained replay, which nothing in
the binding's frame otherwise carries, and it retires the millis() rollover skew
recorded in `docs/backlog.md`. The page stops deriving a clock offset from the
device and ages every message against its own clock.

## Modules

### `topic.h` / `topic.cpp`

Topic and filter handling with no allocation, mirroring
`mqtt-http-bridge/src/topic.js` so the two implementations agree.

    bool validTopic(const char* topic);
    bool validFilter(const char* filter);
    bool matchFilter(const char* filter, const char* topic);
    bool isAlias(const char* topic);   // last segment is $alias

A topic is invalid if it is empty, holds a wildcard, holds a space, or has an
empty segment. Segment counts are not enforced, matching the bridge: a topic the
receiver does not hold answers `404` rather than `400`. A filter is invalid if
`#` appears anywhere but the last segment.

### `alias_store.h` / `alias_store.cpp`

    bool        begin();
    const char* get(const char* topic);          // NULL when unset
    bool        set(const char* topic, const char* name);
    bool        remove(const char* topic);
    uint8_t     count();
    const char* topicAt(uint8_t i);
    const char* nameAt(uint8_t i);

Aliases live in RAM as a fixed table of 32 entries, each a 96-byte topic and a
32-byte name, and are persisted as one JSON object of topic to name in a single
`Preferences` entry, namespace `alias`, key `map`, capped at 2 KB. NVS keys are
limited to 15 characters and an alias topic runs to 96, so one blob rather than
one entry per alias. The blob is rewritten whenever an alias changes, which is a
user action and rare.

A `set` that would exceed the table or the blob cap fails, and the POST that
caused it answers `503`.

### `signal_store`

Keeps its slot table, ordering, eviction, and stale sweep. Changes: topic keys,
stamped payloads, wider key and payload buffers, and the event ring
(`SignalEvent`, `pushEvent`, `eventCount`, `event`) deleted. That frees
40 x 513 bytes of RAM and removes the last thing `/api/state` was serving.

### `web_ui`

Four routes, dispatched from `onNotFound` since topics are arbitrary paths:

| Request | Behaviour |
|---|---|
| `GET /` | The page, as today |
| `GET /events?f=…` | Subscribe |
| `GET /<topic>` | The stored message, `404` if none |
| `POST /<topic>` | Store an alias, `204` |

`/api/state`, `/api/status`, and the `signal`-named SSE event are removed.

## Operations

`GET` of a device topic returns the stored payload with
`Content-Type: application/json`. `GET` of an `$alias` topic returns the JSON
string. Anything not held, including every topic outside this source, is `404`.

`POST` to an `$alias` topic under this source stores the name and returns `204`.
A body of `""` removes the alias, after which `GET` answers `404`; this matches
the bridge, where a zero-length publish deletes a retained message. Every other
`POST` is `405`: a non-`$alias` topic, or an `$alias` topic under another
source. A body that is not JSON, or is JSON but not a string, is `400`, and the
stored alias does not change. A malformed topic is `400`.

`GET /events` takes repeated `f` parameters, up to four per connection, each up
to 64 bytes. An invalid filter is `400`. Omitting `f` subscribes to `#`. Frames
carry no event name, matching the bridge:

    data: {"topic":"rtl433-a1b2c3/Acurite-5n1/1234","payload":{ ... }}

A device payload is embedded as the object it already is, not as an escaped
string. An alias payload is a JSON string.

## Retained replay

A subscriber receives the current message for every matching topic on connect,
before any live one. Writing 24 payloads of 600 bytes in one pass would overflow
the socket's send buffer and drop the client, so each SSE slot carries a replay
cursor drained a few frames per `web_ui::loop()`, subject to the same
`socketReadyToWrite` check every other frame takes. The cursor walks the device
table and then the alias table.

While a slot is still replaying, live frames to that slot are suppressed.
Nothing is lost: the replay reads the live table, so a device updated mid-replay
is delivered with its newer payload when the cursor reaches it. A device evicted
mid-replay is simply not delivered, which is what a subscriber connecting a
moment later would have seen.

Eviction of a busy slot and the reconnect churn it causes are unchanged
(`docs/backlog.md`), except that a reconnecting viewer now costs a full replay
rather than a `/api/state` fetch.

## The page

`refresh()` and `/api/state` go away. The page opens `/events` with no filter,
since the receiver serves only its own source, learns that source from the
topics that arrive, and builds the device table from the replay.

- Device keys become topics. `CARDS_KEY` goes to `rtl433.cards.v2` and any `v1`
  state is discarded rather than migrated: the keys changed shape, and it is
  local layout config.
- The card rename and the device table's Alias field `POST` to
  `<topic>/$alias` instead of writing localStorage. Clearing the field posts
  `""`, which removes it.
- Aliases are read from the `$alias` topics arriving on the stream, so a name
  set in one browser appears in every other one.
- Card layout, visibility, and value modes stay in localStorage, which is the
  layering the roadmap describes: the browser's own config wins, the published
  alias next, the stable segment last.
- The Log tab fills from messages arriving after the page loads and starts empty
  on reload. Its history came from `/api/state`'s `events` array, which no
  longer exists.
- Reload-on-reflash reads `build` from the `<source>/Receiver/0` payload
  instead of `/api/state`.

## Testing

`test/harness.js` stops stubbing `/api/state` and implements the binding: `GET`
of a topic, `POST` of an alias, and `/events` with filters and a retained
replay. `test/binding.spec.js` runs the spec's own test list against the page:

- A topic with no message is `404`; after a `POST` the same `GET` returns the
  body byte for byte.
- A `POST` of a non-JSON body is `400` and does not change the stored message.
- `+` matches one segment, `#` matches the remainder, and a filter matching
  nothing opens a stream that stays empty.
- Repeated `f` delivers from every filter on one connection, and a topic
  matching two filters is delivered once.
- A subscriber receives retained messages on connect before any live one.
- `$alias` round-trips through `GET`, `POST`, and a `#` subscription.
- A `POST` to a non-`$alias` topic is `405`.

`test/cards.spec.js` is updated for topic keys, the `v2` storage key, and
aliases arriving from the stream rather than localStorage.

`signal_store::selfTest` gains checks for topic keys, the `0` id segment, and
the three stamped fields. `alias_store` gains a self-test for round-trip,
removal, the table cap, and reload from a serialised blob.

An alias surviving a reboot needs hardware and can only be checked by hand,
which is the self-test gap already recorded in `docs/backlog.md`.

## Documentation

`README.md` describes the binding as the receiver's HTTP surface. `docs/`
holds only `backlog.md` today, so this adds `docs/user-manual.md` for the
routes and their statuses and `docs/architecture.md` for the module boundaries
and the replay design. `docs/backlog.md` loses the roadmap
entry for this project and the two gaps it closes: the 48-byte key collision and
the millis() rollover skew. The binding spec itself stays in the bridge repo and
is linked, not copied.
