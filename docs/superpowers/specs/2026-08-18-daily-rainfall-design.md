# Daily Rainfall Tracking

Daily rainfall derived on the receiver from the weather station's cumulative
bucket-tip count, reset at local midnight.

## Goal

The weather station transmits a cumulative `rain_mm` (total bucket tips since
the station powered up). The receiver subtracts a per-device baseline captured
at local midnight to publish `rain_today_mm`, the rainfall since the start of
the current local day.

## Scope

- A per-device-type hook in the receiver that augments decoded payloads before
  store and forward.
- A rain hook for the Acurite-5n1 that computes `rain_today_mm` from `rain_mm`
  and a baseline reset at local midnight.
- A GMT offset stored on the receiver, defaulting to EDT (-240 minutes) at
  boot, set by the dashboard when the weather location is set.
- The dashboard POSTs the offset to the local receiver's `/$tz` on a location
  change. No other push path.
- NOT in scope: NVS persistence of the rain baseline across receiver reboots,
  supporting rain models other than the Acurite-5n1, HTTP fetching of the
  offset, re-pushing the offset at DST transitions.

## Non-goals, stated explicitly

- The baseline is RAM-only. A receiver reboot loses it; the first reading
  after reboot becomes the new baseline and today's rain restarts from 0. This
  matches `signal_store` being RAM-only.
- The offset is pushed once per location change. A DST transition leaves
  midnight off by an hour until the user touches the location again. Accepted.

## Firmware changes

### `signal_store.h` / `signal_store.cpp` — record hook

A new optional callback, set once at boot:

```cpp
typedef void (*RecordHook)(const char* key, JsonDocument& doc);
void setRecordHook(RecordHook hook);
```

`record()` calls the hook after parsing the payload and stamping `time`,
`rssi`, and `count`, before the size check and store. The hook may add or
modify fields in the `JsonDocument`. `signal_store` stays a dumb store; it
only knows that *something* may want to augment a payload.

A NULL hook (the default) leaves `record()` exactly as it is today.

`WebReceiver.ino` wires `device_hooks::dispatch` as the callback in `setup()`.

### `device_hooks.h` / `device_hooks.cpp` — per-model dispatch

New module, Arduino-free so it host-tests like `topic` and `radio_health`.

A registry mapping model name to hook function:

```cpp
typedef void (*Hook)(const char* key, JsonDocument& doc);
void registerHook(const char* model, Hook h);
void dispatch(const char* key, JsonDocument& doc);
void begin();   // registers the rain hook for the Acurite-5n1
```

`dispatch` reads `doc["model"]`, looks up the hook, and calls it. No-op when
no hook is registered for that model.

### `tz_store.h` / `tz_store.cpp` — GMT offset

Small module on `Preferences` namespace `"tz"`, key `"offset"`:

```cpp
void begin();                // loads from NVS, defaults to -240 (EDT)
int16_t offsetMinutes();     // live value
void set(int16_t minutes);   // persists and updates
```

Default -240 minutes at first boot. No DST rules, no IANA names, just a signed
offset the dashboard pushes.

### Rain hook

A fixed 8-entry table in `device_hooks.cpp`:

```cpp
struct RainBaseline { char key[96]; float baseline; int32_t day; bool used; };
```

On each call for a registered rain model:

1. Read `rain_mm` from the doc. Skip if absent. Read `rain_in` only when
   `rain_mm` is absent and convert to mm.
2. Compute `localDay = (time(nullptr) + tz_store::offsetMinutes() * 60) / 86400`.
   If `time()` < 1700000000 (clock not set), use 0 as the day and skip the
   midnight reset check, but still track a baseline from the first reading so
   deltas accumulate within an unset-clock session.
3. Look up or create the entry for this key:
   - No entry: `baseline = rain_mm`, `day = localDay`, delta = 0.
   - Entry exists, `day` changed: `baseline = rain_mm`, `day = localDay`,
     delta = 0.
   - Entry exists, `rain_mm < baseline` (station power-cycled, counter
     rolled): `baseline = rain_mm`, delta = 0.
   - Otherwise: `delta = rain_mm - baseline`.
4. Set `doc["rain_today_mm"]` to `delta` rounded to one decimal.

The key passed to the hook is the same `source/model/id` string
`signal_store::record` builds, so the baseline table keys match across
messages.

### `web_ui.cpp` — `POST /$tz`

Handled in `handleTopic` alongside the alias path. A POST to a topic ending
`/$tz` under this receiver's source:

- Body: a JSON number, signed minutes (e.g. `-240`, `330`).
- Calls `tz_store::set(value)` and returns `204`.
- `405` if the topic is not `/$tz` under this receiver's source.
- `400` if the body is not a JSON number.

Routing is added to `handleTopic`'s existing dispatch; no new route is
registered with `WebServer`. The topic validator already accepts `$` segments
(it rejects only `/`, ` `, `+`, `#`), so `/$tz` passes `validTopic`.

### `WebReceiver.ino` — wiring

In `setup()`, after `signal_store::setSource(...)`:

```cpp
tz_store::begin();
device_hooks::begin();
signal_store::setRecordHook(device_hooks::dispatch);
```

## Dashboard changes

### Offset push on location change

`settings.js` `setLocation(next)` is the single point where a location moves.
After `saveSettings()`, when the location is valid (`hasLocation()`), POST the
current offset to the local receiver only:

```js
const offset = offsetMinutes(new Date(), activeZone())
fetch(`${location.origin}/$tz`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(offset),
}).catch(err => console.error(`POST $tz failed: ${err.message || err}`))
```

Only the local receiver (`location.origin`) is pushed, matching `postAlias`'s
pattern. No push when the location is cleared, no push on DST transition, no
push to remote sources.

### Field rendering

`rain_today_mm` arrives in the merged payload like any other reading. No
dashboard code changes are needed for it to render:

- `splitUnit("rain_today_mm")` strips `_mm`, returns `{ name: "rain today",
  unit: "mm" }`.
- `GROUP_OF_UNIT["mm"]` maps to the `rain` group, so display conversion to
  inches works through the existing `toCanonical` / `fromCanonical` path.
- The field appears on the card next to `rain_mm`. The user can hide
  `rain_mm` and show `rain_today_mm` to get the "replace display" behavior.
  No firmware-side hiding of the cumulative value.

## Testing

### Host tests

`test/host/device_hooks_test.cpp`, compiled by `test/host/run.sh`:

- A model with no registered hook is untouched.
- A registered model with no `rain_mm` and no `rain_in` is untouched.
- First reading sets baseline, `rain_today_mm` is 0.
- Subsequent readings accumulate the delta.
- Day change resets baseline, `rain_today_mm` is 0.
- Station power-cycle (counter drops below baseline) resets baseline.
- `rain_in` is converted to mm when `rain_mm` is absent.
- Clock unset: baseline tracks, no day reset, delta accumulates.
- `tz_store::set` changes the day boundary used by the rain hook.

Stubs: `time()` returns a fixed value, `tz_store::offsetMinutes()` returns a
settable value.

### Binding test

`test/binding.spec.js`: a payload with `rain_mm` for an Acurite-5n1 comes back
from `GET /<topic>` with `rain_today_mm` added. A second emission with a larger
`rain_mm` shows a non-zero delta. A non-rain model (e.g. Acurite-Tower) is
unchanged.

### Dashboard test

`test/feeds.spec.js` or a new spec: setting a location POSTs the offset to
`/$tz` on the local origin. The body is a JSON number matching
`offsetMinutes(new Date(), activeZone())`. Cleared location does not POST.

## Documentation

`receiver/docs/architecture.md` gains:

- A `device_hooks` entry in the module boundaries section, describing the
  record hook and the rain baseline logic.
- A `tz_store` entry alongside `health_store`.
- A note in the data-flow section that the hook runs in `record()` before the
  size check.

`receiver/docs/user-manual.md` documents `POST /$tz` in the HTTP surface
table.

`dashboard/docs/user-manual.md` notes that `rain_today_mm` is the daily value
derived by the receiver and that setting the location pushes the local offset.
