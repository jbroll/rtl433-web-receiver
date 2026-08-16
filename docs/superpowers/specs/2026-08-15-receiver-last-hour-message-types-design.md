# Receiver: retain recent message types per device for connect backfill

## Problem

The dashboard's card for a device shows the **union of reading fields across recent frames** (`dashboard/src/units.js:25`, `mergeReadings`). The Acurite 5n1 is the named example: it splits readings across alternating `message_type`s, and the dashboard keeps both parts by merging.

On a fresh page load, the receiver replays **one frame per topic** (the latest). The dashboard has no previous merged state, so the card shows only the fields of the latest frame. Other `message_type`s are missing until their next live transmission arrives seconds to minutes later.

The bridge path is unchanged: it depends on MQTT retain semantics, which holds one message per topic. This design is for **receiver-direct SSE connections only**.

## Goal

When a dashboard connects directly to the receiver, the replay should carry enough recent frames per device that `mergeReadings` reconstructs the expected union and the card fills in immediately.

## Success criteria

- A device that emits multiple `message_type`s under the same `<source>/<model>/<id>` topic is replayed as one frame per type on connect.
- Single-`message_type` devices do not reserve unused sub slots.
- Payloads stay verbatim rtl_433 JSON; the receiver does not synthesize merged payloads.
- The topic shape `<source>/<model>/<id>` stays unchanged.
- The firmware stays within its "static allocation only" rule (`receiver/docs/backlog.md:71-80`).

## Non-goals

- History / sparklines / time-series per device. Only the latest frame per `message_type` is retained.
- Bridge-path backfill. The bridge keeps one retained message per topic and is out of scope.
- Changing dashboard source code. The dashboard already merges; it only receives more frames on connect.

## Design summary

`signal_store` keeps the existing 24-device `_devices[]` table for device metadata (key, `lastSeen`, `count`), but moves payload storage into a shared, fixed `_subs[]` table indexed by `message_type` within a device.

- `_subs[SIGNAL_SUB_TABLE]` holds `SIGNAL_SUB_TABLE = 32` entries.
- Each `_subs[i]` stores `slotIdx`, `msgType`, `payload`, `lastSeen`, and `seq`.
- A typical 1-type device consumes one `_subs` entry; a splitter consumes two or three.
- Replay walks `_subs[]` instead of `_devices[]`, emitting one frame per used sub.
- Live suppression uses the sub's flat index, preserving the existing cursor property that a frame written ahead of the cursor is delivered by the cursor, and one behind it is delivered live.
- Subs not heard within `SUB_STALE_MS` (1h) are freed; when a slot's last sub is freed, the slot is freed.

## Detailed design

### `signal_store` data model

```c
#define SIGNAL_SUB_TABLE 32
#define SUB_STALE_MS     3600000   // 1 hour; override with -DSUB_STALE_MS=

struct DeviceSub {
  uint8_t       slotIdx;      // owning DeviceSlot index, 0xFF when free
  char          msgType[16];  // stringified message_type, "" for none
  char          payload[SIGNAL_PAYLOAD_MAX + 1];
  unsigned long lastSeen;     // millis, for SUB_STALE_MS sweep
  uint32_t      seq;          // global monotonic order; LRU among a device's subs
  bool          used;
};

struct DeviceSlot {
  char          key[SIGNAL_KEY_MAX];
  unsigned long lastSeen;     // for DEVICE_STALE_HOURS sweep
  uint32_t      count;        // per-device message count
  bool          used;
};

static DeviceSlot _devices[SIGNAL_DEVICE_SLOTS];
static uint32_t   _seq[SIGNAL_DEVICE_SLOTS];   // today: global monotonic order for device LRU
static DeviceSub  _subs[SIGNAL_SUB_TABLE];
```

The 24-device table is unchanged in size. The shared sub table adds ~21KB RAM on top of the ~2.6KB slot table, for a total of ~23.5KB vs today's ~18KB.

### `record()`

1. Deserialize JSON and build the 3-segment key (`<source>/<model>/<id>`) exactly as today.
2. Extract `message_type` and normalize it:
   - `doc["message_type"].as<String>().c_str()`, truncated to 15 chars.
   - Treat absent, null, or empty as `""`.
3. Find the slot by key; if none, `claimSlot()` evicts the device with the lowest `_seq` (today's behavior).
4. Find the sub with matching `slotIdx` and `msgType`.
   - If found, overwrite it.
   - Else if a free `_subs` entry exists, claim it.
   - Else if this device already has more than one sub, evict its lowest-`seq` sub to make room.
   - Else (this device has exactly one sub and the table is full), drop the message and increment `_dropped`; this preserves the device's existing type instead of replacing it.
5. Stamp `time`, `rssi`, and the slot's `count` into the JSON and serialize into the chosen sub's `payload`.
6. Set sub `lastSeen = millis()`, sub `seq = ++_seqCounter`, and slot `_seq[idx] = _seqCounter`. The same monotonic counter orders both device slots and subs.
7. Return `bool` (unchanged signature).

Because the just-written sub has the highest `seq` for its device, `broadcast(signal_store::device(0))` still broadcasts the frame that was just recorded.

### Replay

`web_ui::_replay[i]` remains a flat `int16_t`, but its range becomes:

- `0 .. SIGNAL_SUB_TABLE - 1`: sub-table entries.
- `SIGNAL_SUB_TABLE .. SIGNAL_SUB_TABLE + ALIAS_SLOTS - 1`: aliases.
- `>= SIGNAL_SUB_TABLE + ALIAS_SLOTS`: done.

`drainReplay` reads `_subs[at]`, skips unused entries, builds a frame from the sub's payload and the owning slot's key, and applies `slotWants`. Alias handling is unchanged except for the offset.

### Live suppression

`broadcastFrame` skips a live frame when the sub's flat index is still ahead of the client's cursor:

```c
int flatIdx = subIdx;   // subIdx is already flat in _subs[]
if (_replay[i] >= 0 && flatIdx >= 0 && flatIdx >= _replay[i]) continue;
```

This preserves today's property: a sub written before the cursor reaches it is delivered by the cursor with its current payload; a sub written after the cursor passed it is delivered live.

### `GET /<topic>`

`GET /<topic>` returns the highest-`seq` sub's payload for that slot. This preserves "the last message published to that topic" as closely as a multi-message-type store can: one verbatim payload, never a merged object.

The dashboard never `GET`s sensor topics; it uses `/events`. This path matters only for the binding contract and external clients.

### Sweeps

- **Sub staleness sweep** (new): `sweepSubStale(now, SUB_STALE_MS)` frees any sub whose `lastSeen` is older than `SUB_STALE_MS`. If a slot's last sub is freed, the slot is also freed.
- **Device staleness sweep** (existing): `sweepStale(now, DEVICE_STALE_HOURS)` remains, but with the 1h sub-sweep active it is structurally unreachable. It is left as belt-and-braces; removal is a follow-up cleanup, not part of this change.

### New / changed accessors

- `const char* latestPayload(const DeviceSlot& slot)` returns the highest-`seq` sub's payload for a slot, or `nullptr` if the slot has no subs. Used by `web_ui.cpp` `GET` and replay-frame building, and by self-test assertions. `GET` should answer `404` when this returns `nullptr`.
- `record()` keeps its `bool` signature.
- `broadcast()` keeps its `void broadcast(const DeviceSlot&)` signature; it internally resolves to the latest sub.
- `device()`, `slotAt()`, `indexOf()`, `deviceCount()`, `totalRecorded()`, `droppedCount()` keep their signatures.

## Test plan

### `signal_store.cpp` selfTest (`#ifdef FAKE_SIGNALS`)

- Two `record()`s with the same key but different `message_type` create two subs.
- Two `record()`s with the same key and same `message_type` overwrite one sub.
- A device with no `message_type` creates one sub with `msgType = ""`.
- When `_subs` is full, a device with more than one sub evicts its own least-recent sub; a device with exactly one sub drops the new message to preserve its existing type.
- `sweepSubStale` removes a sub older than `SUB_STALE_MS` and frees the slot when its last sub is removed.
- Rollover: unsigned `lastSeen` subtraction in `sweepSubStale` stays correct across `millis()` wrap.
- `latestPayload(slot)` returns the highest-`seq` sub.
- Existing assertions reading `device(0).payload` change to `latestPayload(device(0))`.

### `receiver/test/binding-server.js`

The mock server currently holds one retained payload per topic. It grows sub-entries keyed by `(topic, msgType)` so it can host the new binding test. A device without `message_type` keeps one sub with `msgType = ""`. `GET /<topic>` returns the highest-`seq` sub.

### `receiver/test/binding.spec.js`

- **Splitter replay on connect**: start the server with two fixtures (`ACURITE_WIND`, `ACURITE_RAIN`) sharing model/id but different `message_type`; open `/events`; assert both frames arrive with the same topic before any live frame.
- **Multi-type GET returns the latest sub**: after emitting a rain frame, `GET` returns the rain payload; after emitting a wind frame, `GET` returns the wind payload.
- Existing tests continue to pass unchanged for single-type devices.

### Dashboard Playwright

A test that loads the dashboard against a source replaying two message_types for one device and asserts the card shows both field sets immediately. This guards the end-to-end path: the receiver replays multiple types, and `mergeReadings` reconstructs the union on connect.

## Documentation updates

- `receiver/docs/architecture.md`:
  - Update the `signal_store` module boundary description to describe `_devices` + `_subs`.
  - Update the replay section to state the cursor walks the sub-table then the alias table.
- `receiver/docs/user-manual.md`:
  - Update "Retained replay" to note that a device with multiple `message_type`s is delivered as one frame per type on connect.
- `bridge/docs/binding.md`:
  - No change. The bridge keeps one retained message per topic.
- `receiver/docs/backlog.md`:
  - No new backlog item for heap allocation (the design honors the static rule).

## Migration touch points

These call sites read `DeviceSlot::payload` today and must change when payload moves into `DeviceSub`:

- `web_ui.cpp:384` — `GET /<topic>` handler: use `latestPayload(slot)`.
- `web_ui.cpp:468-472` — `drainReplay` device half: walk `_subs[]` and use the sub's payload.
- `signal_store.cpp:151` — `serializeJson` target: write into the chosen sub's payload buffer.
- `signal_store.cpp` selfTest assertions at `:244, :247, :252`: use `latestPayload(device(0))`.

`WebReceiver.ino:190,288,308` calls `web_ui::broadcast(signal_store::device(0))` — no change.

## Decisions made during design

- **Static allocation rule honored.** A shared fixed sub-table is used instead of heap-allocated sub-entries.
- **`SIGNAL_SUB_TABLE = 32`.** Covers 24 single-type devices plus ~8 extra subs for splitters (~23.5KB total RAM).
- **`SUB_STALE_MS = 3600000` (1h).** Default matches the original request; overridable at build time.
- **`message_type` normalization:** stringify via `as<String>()`, truncate to 15 chars, treat absent/null as `""`. Two records with `0` and `"0"` are treated as the same type.
- **72h `sweepStale` kept.** Structurally unreachable after the 1h sub-sweep, but left in place.
- **Receiver-direct only.** The bridge path and dashboard code are unchanged.
