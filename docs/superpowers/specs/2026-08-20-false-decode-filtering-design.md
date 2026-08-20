# False-decode filtering

ROADMAP.md Goal 2: filter false decodes from weak decoders without gating on
`MY_DEVICES`. Two independent mechanisms, both firmware-side.

## Problem

All 214 decoders in `rtl_433_devices.h` are compiled in. Weak ones claim
noise: a device shows up once, never repeats, and reads `humidity` 154,
`wind_dir_deg` 458, or `pressure_hPa` 5768. `mic` cannot filter this — several
of the offending decoders declare a passing `"mic":"CRC"`/`"CHECKSUM"` on the
noise itself.

## Range checks (`device_hooks.cpp`)

A new function:

```c
bool validate(JsonDocument& doc);
```

Checks any of the following fields present in `doc`, using the field's
standard rtl_433 name:

| Field | Valid range |
|---|---|
| `humidity` | 0–100 |
| `wind_dir_deg` | 0–360 |
| `pressure_hPa` | 800–1100 |

A field absent from the payload is not checked. `validate()` returns `false`
if any present field is outside its range.

Called from `signal_store::record()` immediately after `buildKey()` succeeds
and before the model-specific hook dispatch (`_hook(key, doc)`). On `false`,
`record()` increments `_dropped` and returns `false`, the same outcome as an
unparseable payload or one missing `model`. The whole decode is dropped, not
just the offending field: an out-of-range field is a signal the packet is
noise, not a real reading with one bad value.

`validate()` is a plain function, not a per-model `Hook`, and always runs
regardless of whether a model has a registered hook.

## Seen-twice-before-card (`signal_store.cpp`)

A new fixed-size pending table, sized the same order as the existing sub
table:

```c
#define SIGNAL_PENDING_SLOTS 8

struct PendingKey {
  char     key[SIGNAL_KEY_MAX];
  uint32_t seq;
  bool     used;
};
```

In `record()`, after `validate()` passes, only when `isDecode` is `true`:

- If `findSlot(key)` finds an existing device, proceed as today (update in
  place). The rule only gates a *new* key.
- Else, look up `key` in the pending table.
  - Not found: claim a pending slot (evicting the lowest-`seq` entry if the
    table is full, same LRU-by-seq policy as `claimSlot`), stamp it with the
    next `_seqCounter`, and return `false`. Nothing is dropped-counted and
    nothing is decoded-counted; this is a distinct third outcome. No slot is
    claimed, no sub is written, `web_ui::broadcast()` is not called (its
    caller in `WebReceiver.ino` only broadcasts when `record()` returns
    `true`).
  - Found: free the pending entry and fall through to the existing
    `claimSlot`/promote path unchanged, so the second sighting creates the
    device slot and sub exactly as `record()` does today.

`isDecode == false` (telemetry, i.e. the `Receiver` card recorded once a
minute) bypasses the pending table entirely and claims a slot on first call,
preserving the documented behavior in `receiver/docs/architecture.md`: "It is
the one device that starts with its card shown, since it cannot be a false
decode."

No time window: a pending entry is only lost by eviction (table full, this
entry has the lowest `seq`), never by age. `reset()` clears the pending table
along with the rest of the store's state.

## Test changes

- `receiver/test/host/device_hooks_test.cpp`: cases for `validate()` — each
  field in range, each field out of range (dropped), field absent (untouched),
  multiple fields where only one is out of range (dropped).
- `receiver/signal_store.cpp` `selfTest()`: every existing case that records a
  brand-new key once and immediately asserts on `deviceCount()`/`device(0)`
  needs a second `record()` of the same key first (or an explicit case
  asserting the *first* sighting produces no device/no broadcast-eligible
  return). Add new cases: first sighting of a new key returns `false` and
  `deviceCount()` stays unchanged; second sighting promotes it; a third+
  sighting behaves as an ordinary repeat; pending table eviction under churn
  from distinct one-off keys; telemetry (`isDecode=false`) still gets a card
  on the first call.

## Out of scope

- Dashboard's existing `hideNewCards`/`store.js` UI-side hiding is untouched;
  it already hides newly-arriving cards by default regardless of this
  firmware change, and continues to coexist with it.
- `MY_DEVICES` gating, per the roadmap, is explicitly not part of this
  change — all 214 decoders stay compiled in.
