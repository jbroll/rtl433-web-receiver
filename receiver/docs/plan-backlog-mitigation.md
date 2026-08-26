# Backlog mitigation plan

Every item in [`backlog.md`](backlog.md) grouped into commit-sized batches, in the order
they should land. Items not worth doing are listed at the end with the reason. Claims that
did not survive a read of the code are listed after that.

This plan was written against the working tree at commit `8fc66f5` plus the uncommitted
backlog additions. No code was changed.

## What "proves it" means here

Three test vehicles, and they prove different things.

- `bash test/host/run.sh` compiles `topic.cpp`, `radio_health.cpp`, `device_hooks.cpp`,
  `signal_store.cpp`, `alias_store.cpp`, `layout_store.cpp`, `location_store.cpp`,
  `units_store.cpp` and `mqtt_publish_store.cpp` on the host against
  `test/host/arduino_shim/` and runs each module's `selfTest()`. This is the only vehicle
  that runs firmware code. Anything landing in those nine files gets a check here.
- `npx playwright test` runs `test/binding.spec.js` against `test/binding-server.js`, a
  JavaScript model of the HTTP surface. It proves the contract, not the firmware. A change
  to firmware behaviour that the binding describes has to be mirrored into
  `binding-server.js` or the spec passes while the device disagrees.
- On-device: build, OTA the image with `tools/flash-ota.js`, read `python3 monitor.py`.
  `web_ui.cpp`, `mqtt_publish.cpp`, `provisioning.cpp` and `WebReceiver.ino` have no host
  test and no path to one without a much larger shim, so every change to them is proved
  this way.

## The two ways to lose a board

Deployed devices update through `POST /$update`, not USB. Two classes of change can end
that path.

**Losing the OTA credential.** `ota_token_store::token()` returns the NVS token if one is
set and the `OTA_TOKEN` build macro otherwise (`ota_token_store.cpp:30-38`). A change that
writes a token the operator does not have, or that makes `hasToken()` false, turns
`/$update` into a permanent 404 or 401. Recovery is USB, or the BOOT-button hold that
clears WiFi credentials and reopens the portal. Batch 6 and batch 9 both touch this.

**Losing the network.** `provisioning.cpp` only runs when WiFi never comes up. A firmware
that cannot join the configured network is reachable only through the BOOT-button portal,
which needs the board in hand. Batch 9 changes the portal itself.

Neither class is a brick in the `partitions.csv` sense. Nothing in this plan touches
`partitions.csv`; that file's `app0` offset is hardcoded by the platform and moving it
does boot-loop the board.

Land each batch on a board that is physically reachable before OTAing it to one that is
not.

---

## Batch 1: host tooling

Nothing in the firmware changes. This goes first because every later batch reaches the
device through `tools/flash-ota.js`, and two of its faults bite during exactly that.

**Files:** `tools/flash-ota.js`, `monitor.py`, `tools/fetch_coredump.sh`,
`build_dashboard.py` or a new post-build hook, `docs/development.md`.

**Changes:**

- `tools/flash-ota.js:65`: `main()` has no `.catch()`, and `main` awaits `fetch`, so an
  unreachable host exits with a Node stack trace. Make it
  `main().catch(e => { console.error(e.message); process.exit(1); })`.
- `tools/flash-ota.js:19`: `readEnvToken` does not strip a leading `export `, so it skips
  `export OTA_TOKEN=...` and reports "no OTA_TOKEN in the environment or receiver/.env"
  for a `.env` the firmware build accepts. `load_env.py:28-29` strips it. Add
  `if (line.startsWith("export ")) line = line.slice(7);` before the `=` split, which
  needs `let line`.
- `monitor.py:80-86`: `--reset`/`-r` is `action="store_true", default=True`, and nothing
  reads `args.reset`; `:138` tests `args.no_reset`. Delete the `--reset` argument, or
  redeclare it as `dest="no_reset", action="store_false", default=False` and drop the
  separate `--no-reset`.
- `tools/fetch_coredump.sh:8-11`: `$HOME/.platformio/packages/tool-esptoolpy/esptool.py`,
  `$HOME/.platformio/penv/bin/esp-coredump` and `$build/firmware.elf` are executed with no
  existence check. Add one guard loop that names the missing file and exits. Read the
  offset and size from `partitions.csv` instead of the literal `0xFF0000 0x10000` on
  `:10`.
- Keep the ELF of a build until any core dump it left behind is fetched. The cheapest
  version: a post-build hook that copies `firmware.elf` to
  `tools/elf/$BUILD_ID.elf` and gitignores the directory, plus a line in
  `fetch_coredump.sh` that prefers the ELF matching the dump's build. The alternative,
  keeping every ELF forever, is not worth the disk.

**Proof:** run `node tools/flash-ota.js` against an unreachable host and against a `.env`
whose `OTA_TOKEN` line is written with `export`; both should print one line. Run
`python3 monitor.py --help`. Run `tools/fetch_coredump.sh` with `$HOME/.platformio` moved
aside. There is no automated suite for these; they are shell scripts and a 65-line Node
file.

**Risk:** none to the device. The `fetch_coredump.sh` offset change reads a file that
currently agrees with the literal, so behaviour is unchanged today.

**Blocks:** nothing formally, but the `export` fix removes a failure mode from every OTA
in batches 2 through 9.

---

## Batch 2: record-path correctness

Four defects in one function plus one in the hook it calls. All five are host-testable.

**Files:** `signal_store.cpp`, `signal_store.h`, `device_hooks.cpp`, `alias_store.cpp`,
`test/host/signal_store_test.cpp`, `test/host/alias_store_test.cpp`,
`test/host/device_hooks_test.cpp`, `docs/architecture.md`.

**Changes:**

- **A failed sub claim leaks a device slot.** `record()` calls `claimSlot()` at
  `signal_store.cpp:251-254`, which increments `_deviceCount` and sets `used = true`,
  before `claimSub()` can return -1 at `:264-268`. `claimSub()` returns -1 whenever the
  32-entry table is full and the device has one sub or none, which is always true of a
  slot just claimed. The store then reports a device whose `latestPayload()` is NULL.
  Move the `findSub`/`claimSub` pair above the `claimSlot` block: compute `msgType` from
  the doc, resolve the sub for `idx` when `idx >= 0`, and when `idx < 0` claim the slot
  only after confirming a free sub exists. Simplest correct shape: claim the slot, and on
  `claimSub() < 0` undo it (`_devices[idx].used = false; _deviceCount--; _seq[idx] = 0;`)
  before the `_dropped++`.
- **MQTT publishes what the store drops.** The hook loop runs at `signal_store.cpp:239-241`
  and the `measureJson(doc) > SIGNAL_PAYLOAD_MAX` check at `:245-248`, so
  `mqtt_publish::onRecord` publishes retained a payload the store then refuses. Move the
  size check above the hook loop. `SIGNAL_PAYLOAD_MAX` is a property of the message, not
  of the store's write, so nothing else moves with it. The slot-leak fix above puts the
  other post-hook drop path away as well; if it does not, hoist that check too.
- **The hour cap on retention.** `sweepStale()` ends with
  `sweepSubStale(now, SUB_STALE_MS)` (`:382`) and `SUB_STALE_MS` is hardcoded to 3600000
  in `signal_store.h:12`. `sweepSubStale()` frees the owning device slot when its last sub
  goes (`:399-403`), so effective device retention is one hour and the
  `DEVICE_STALE_HOURS=72` build flag never takes effect. Fix: make `sweepSubStale()` spare
  each slot's newest sub and stop freeing device slots entirely, leaving the device window
  as the only thing that ends a slot's life. `sweepStale()` already calls `freeSlotSubs()`
  when it frees a slot (`:376`), so no sub survives a freed slot either way. The sub sweep
  then does what its name says: it reclaims a splitter's stale secondary message types
  without evicting the device.
- **`buildKey()` truncates the id.** `signal_store.cpp:80-89` copies `doc["id"]` into a
  16-byte buffer with `copyTruncated`, so two sensors sharing a 15-character prefix map to
  one key and interleave. Every other segment rejects rather than truncates and has a
  self-test for it (`:496-497`). Make the id path reject: compare
  `strlen(source) < sizeof(id)` before copying, return false otherwise. A 15-character id
  is already outside anything rtl_433 emits, so this changes no working device.
- **`claimRain()` evicts the clock-less entry.** `device_hooks.cpp:71-81` picks the lowest
  `day`, and `localDay()` returns 0 before the first SNTP sync (`:33-37`), so a baseline
  recorded pre-sync is the permanent victim and its `rain_today_mm` is meaningless anyway
  because the rollover branch never fires. Return early from `rainHook()` while
  `localDay() == 0`.
- **`indexOf()` has no self-test.** `alias_store.cpp:217-218` casts `indexOf()`'s result to
  `uint8_t`, so -1 reads as 255, `topicAt(255)` fails its `i < ALIAS_SLOTS` bound and
  returns NULL, and the check passes whether the entry was freed or never found. Add
  `idx2 >= 0` to the conjunction. `signal_store::indexOf` (`:318-323`) is never called from
  `selfTest()` at all; it runs only through `latestPayload()` and `latestSubIndex()`, always
  with an in-range slot, so the -1 branch has no coverage. Add
  `DeviceSlot foreign{}; check("indexOf rejects a slot outside the table", indexOf(foreign)
  < 0);` and `indexOf(device(0)) == 0`. The same cast appears at
  `mqtt_publish_store.cpp:252-253` and `:295`, where the result feeds `strcmp` and a -1
  would crash rather than pass quietly; guard those in batch 4.

**Proof:** host tests in `test/host/signal_store_test.cpp`. For the slot leak: fill the
sub table with 32 single-sub devices, promote a 33rd key, assert `deviceCount()` is
unchanged and no slot has a NULL `latestPayload()`. For the size check: register a hook
that counts calls, feed an over-long payload, assert the hook did not fire. For retention:
record two subs on one device, age one past `SUB_STALE_MS`, assert the device survives
with one sub, then age the device past the device window and assert the slot goes. For the
id: a 20-character id is rejected and creates no device.

**Risk:** the retention change makes slots live up to 72 hours instead of one, so the
24-slot device table and 32-entry sub table run fuller. `claimSlot()` already evicts the
lowest `_seq` and `claimSub()` evicts a device's own oldest sub, so neither overflows, but
a busy band will now evict on capacity rather than expiry. That is the intended behaviour
of `DEVICE_STALE_HOURS`. The slot-leak fix changes a drop path that today leaves state
behind; nothing reads that state deliberately.

**Blocks:** batch 3 edits the same function, and batch 7 edits `alias_store.cpp`. Land
this first so those rebase onto a correct `record()`.

---

## Batch 3: record-path allocation

The project's rule is static allocation. Three places break it and one wastes a copy.
Free heap was reported steady across a four-minute sample, so this is about the rule and
the per-decode cost, not a leak.

**Files:** `signal_store.cpp`, `WebReceiver.ino`, `docs/architecture.md`.

**Changes:**

- **`String` on the decode path.** `signal_store.cpp:83`, `:85` and `:259` call
  `.as<String>()` on `doc["id"]`, `doc["channel"]` and `doc["message_type"]` to copy into
  a fixed buffer, where the underlying value is an `int` or a `const char*`. Replace each
  with: if the value `is<const char*>()`, `copyTruncated` from it; else if it
  `is<long>()`, `snprintf("%ld")`; else leave the existing fallback.
- **The ArduinoJson allocator.** 7.4.3 defaults to `malloc`/`realloc` and reallocs several
  times per parse. Subclass `ArduinoJson::Allocator` over a fixed static buffer and pass it
  to the `JsonDocument` constructor at `signal_store.cpp:203`. Size the buffer from the
  worst case the parse already bounds: `JSON_MSG_BUFFER` is 512 and the doc gains `time`,
  `rssi`, `count` and `rain_today_mm`, so 2 KB is generous. `deallocate` can be a no-op if
  the buffer is reset per `record()` call, which is safe because the doc does not outlive
  the function. Fail the parse rather than falling back to the heap when the pool is
  exhausted, so an over-large message is dropped the same way an unparseable one is.
- **`device(0)` on every decode.** `signal_store::device()` rebuilds `_order` and runs an
  insertion sort over every used slot (`:288-309`). All four callers pass 0
  (`WebReceiver.ino:251`, `:387`, `:433`, `:454`), each immediately after a successful
  `record()`, and the slot just written always holds the highest `_seq`, so `device(0)` is
  by construction the slot `record()` just touched. Have `record()` stash that index in a
  file-static and export `lastRecorded()` returning `const DeviceSlot*`; change the four
  call sites. `web_ui` uses `slotAt()` and does not call `device()`.
- **The queue item's zero padding.** `rtl_433_Callback` (`WebReceiver.ino:231`) uses
  `strncpy` into a 512-byte field, which zero-fills the tail, so a 120-byte decode writes
  about 390 wasted bytes on the decoder task. `memcpy` the measured length plus the
  terminator instead. Marginal: `xQueueSend` copies the whole struct either way.

**Proof:** host tests. The existing `signal_store` checks cover the id, channel and
message_type paths already (`:443-450`, `:511-520`); they will catch a formatting
regression. Add a check that a string id and an integer id both produce the key they
produce today, and one that a `lastRecorded()` slot matches `device(0)` after each of a
first, repeat and evicting record. The allocator needs a check that a parse larger than
the pool is dropped rather than crashing. On-device: OTA, watch free heap over a few
minutes with `monitor.py`, confirm decodes still land.

**Risk:** the allocator is the one that can crash rather than misbehave. A pool that a
parse overruns must return null from `allocate` and let ArduinoJson report the failure,
not assert. Test the exhaustion path explicitly before flashing. `lastRecorded()` must
return null when `record()` returned false, or a caller broadcasts a stale slot.

**Blocked by:** batch 2.

---

## Batch 4: MQTT bridge lifecycle

Five items in `mqtt_publish.cpp` and one in `mqtt_publish_store.cpp`. They interact, so
they land together.

**Files:** `mqtt_publish.cpp`, `mqtt_publish_store.cpp`, `mqtt_publish.h`,
`test/host/mqtt_publish_store_test.cpp`, `docs/architecture.md`.

**Changes:**

- **21 KB of buffers at static-init.** `Connection _conn[MQTT_PUBLISH_SLOTS + 1]`
  (`:115`) holds four `PubSubClient`s, each default-constructed, and PubSubClient's default
  constructor mallocs `MQTT_MAX_PACKET_SIZE`. With that flag at 5300
  (`platformio.ini:62`) the array costs 21,200 bytes of heap before `setup()` runs, on a
  device that typically has one broker. Construct the clients with a small buffer and call
  `setBufferSize(MQTT_MAX_PACKET_SIZE)` from `setupConnection()` only after
  `c.broker.valid`, which recovers about 16 KB. Update the `platformio.ini:62` comment,
  which currently describes the buffer as costing RAM per connection without saying there
  are four.
- **`begin()` tears down every connection.** `:231-241` disconnects and stops all four
  slots on every `POST /$mqtt` and `/$mqtt/remove` (`web_ui.cpp:559`, `:579`), so adding
  one bridge re-handshakes every other, up to about 15 s per TLS connection plus a full
  `replayAll()` to each. Diff the store's table against the live connections: for each live
  slot, if a table entry has the same url, token and TLS flag, leave it alone; tear down
  the rest and set up the new ones. The comment at `:227-230` explains why the blanket
  teardown exists, which is that a dashboard add or remove reshuffles which array index
  serves which broker. The diff has to be by url, not by index, or that bug comes back.
- **An unparseable url is still counted.** `setupConnection()` sets `enabled = false` and
  returns at `:123-127`, but `begin()` increments `_connCount` regardless (`:248`), so
  `count()`, `urlAt()`, `connectedAt()` and through them `GET /$mqtt` list a bridge that
  will never connect and give no reason. Either do not count an invalid slot, or carry a
  reason string in `Connection` and report it in the `$mqtt` JSON. The second is better:
  the dashboard currently shows a dot that never turns green, and silently dropping the
  row makes an add look like it did nothing.
- **Adding the build-flag broker twice.** `mqtt_publish_store::add()` (`:122`) dedupes
  against its own table through `find(url)` but has no knowledge of `MQTT_BROKER_URL`, so
  adding that url from the dashboard creates two connections to the same broker under the
  same `_clientId`, which most brokers resolve by kicking one session, producing a
  connect/disconnect flap. Reject a url equal to `MQTT_BROKER_URL` in `add()` under
  `#ifdef`, returning false so the existing 400 at `web_ui.cpp:556` covers it.
- **`aliasPayload()` allocates.** `:153-158` builds a `JsonDocument` to escape one string,
  and `replayAll()` calls it once per alias (`:187-194`), so a reconnect costs up to 32
  documents. `web_ui::writeJsonString` does the same escaping without allocating and is
  exported in `web_ui.h`. It takes a `Print&`, so this needs a small `Print` subclass over
  the fixed `payload` buffer, which `web_ui.cpp`'s `Frame` already is. Either move `Frame`
  into a shared header or write a six-line local one.

While in `mqtt_publish_store.cpp`, guard the `(uint8_t)` casts of `indexOf`-style results at
`:252-253` and `:295`: the result feeds `strcmp`, so a -1 crashes the self-test rather than
passing quietly. `MQTT_PUBLISH_SLOTS` is 3, so three table slots plus the build-flag default
exactly fill `_conn[]`; none of these changes can overflow it.

**Proof:** the store change gets a host check in `mqtt_publish_store_test.cpp`: `add()` of
the build-flag url returns false and leaves `count()` unchanged. The rest has no host
test. On-device: configure two brokers, add a third, and confirm from the broker side that
the first two sessions were not dropped. Watch `ESP.getFreeHeap()` in the Receiver card's
`heap_kB` across a boot before and after the buffer change; the difference should be
around 16 KB.

**Risk:** the diffing change is the one that can leave a stale connection publishing to a
removed broker, which is the bug the blanket teardown was written to fix. Compare url,
token and TLS flag, and tear down anything not matched exactly. The `setBufferSize` change
can silently truncate a large publish if a slot connects without it having been called;
put the call in `setupConnection()` before `enabled = true`, not in `connectOnce()`.

---

## Batch 5: SSE and web server cost

Six items in `web_ui.cpp`. None changes the wire format except the alias length check.

**Files:** `web_ui.cpp`, `test/binding-server.js`, `test/binding.spec.js`,
`docs/user-manual.md`.

**Changes:**

- **The frame memset.** `SizedFrame`'s `char _storage[CAP] = {}` (`:231`) zero-initialises
  on construction, and `FRAME_DEVICE_CAP` is 1363, so `broadcast()`, `broadcastAlias()`,
  `broadcastLocation()`, `broadcastUnits()` and `broadcastTz()` each clear 1363 bytes to
  write about 250. The zero-init exists so the byte past the last write is the NUL that
  `data()` promises, but `reset()` sets only `_buf[0]` (`:207-211`), so a reused buffer
  (the static `replayFrame` at `:969` and the static layout frame at `:1046`) does not have
  it. Append `_buf[_len] = '\0';` at the end of `Frame::write`, where `_len <= _cap - 1` is
  already the invariant, and drop the `= {}`. Today only `handleTopic` (`:742-746`) relies
  on `data()` as a C string and it uses a fresh stack buffer, so this is a stronger
  guarantee rather than a bug fix.
- **`handleTopic`'s stack buffer.** `:742` puts a full 1363-byte `FrameBuffer` on the stack
  to escape an alias name capped at `ALIAS_NAME_MAX` 32 characters.
  `mqtt_publish.cpp:151`'s `ALIAS_PAYLOAD_MAX` already names the worst case as
  `ALIAS_NAME_MAX * 6 + 3`, 195 bytes. Use a `SizedFrame<ALIAS_PAYLOAD_MAX>`.
- **`reapClosedClients()` at loop rate.** `loop()` calls it unconditionally at `:960` and
  again inside the keepalive branch at `:978`. Each call costs an `operator bool` plus a
  `recv(MSG_DONTWAIT|MSG_PEEK)` per SSE slot, so at loop rate that is thousands of syscalls
  a second to notice something that matters within a second or two. Gate the `:960` call on
  a 100 ms timer like the keepalive. Keep it ahead of the `wifiReady()` gate, which is what
  the comment at `:958-959` is about.
- **The keepalive's write-failure path.** `:988`'s `sendFrameOrDrop` calls `client.stop()`
  on a short write without going through `releaseSlot()`, so the slot's filters and replay
  cursor stay set. Inert, because every reader gates on `_sse[i]` first and
  `handleEvents()` overwrites both when the slot is reused. Follow the `:983-986` pattern:
  check `_sse[i]` after the send and `releaseSlot(i)` if it went away, the same way
  `sendTo()` does at `:308-310`.
- **The replay cursor's worst case.** `REPLAY_PER_LOOP` bounds frames sent, not cursor
  steps: `drainReplay`'s `continue` paths do not increment `sent` (`:831-933`), so a
  subscriber whose filters match nothing walks the whole cursor space in one pass. That
  space is `SIGNAL_SUB_TABLE` 32 plus `ALIAS_SLOTS` 32 plus four store entries, 68 indices.
  Bounded and cheap. Either bound the steps as well (a second counter, break at say 16
  steps) or state the worst case in a comment. Prefer the comment: the current behaviour
  finishes a no-match replay in one pass instead of five, and 68 `topic::matchFilter` calls
  is not the loop's problem.
- **An over-long alias name.** `handleAliasPost` checks the topic length (`:387-390`) but
  not the name, and `alias_store::set` truncates to `ALIAS_NAME_MAX` 32, so a 40-character
  name answers 204 and stores 31 characters. The truncation propagates consistently because
  the handler re-reads the stored value for the broadcast (`:400-403`). Return 400 for a
  name at or over `ALIAS_NAME_MAX`, matching the topic check right above it. Do it in
  `web_ui.cpp`, not in `alias_store::set`: a `false` from the store routes through the
  `:396-399` branch and answers 503 "alias store full", which is the wrong reason.
- **SSE eviction churn.** With all four slots busy, a new viewer evicts the
  longest-attached (`:793-804`) and that browser reconnects on the server-sent
  `retry: 3000` (`:811`) and evicts the next. Self-limiting and only when oversubscribed.
  Two cheap knobs: raise `WEB_UI_SSE_CLIENTS` from 4 to 6, which costs one `WiFiClient`
  plus 4 x 65 bytes of filters per slot, and raise the `retry` to 15000 so a churning
  viewer backs off. The dashboard already retries by hand after 5 s on a closed stream
  (`dashboard/src/stream.js:24`); the `retry` header governs the other case, a stream that
  was accepted and then dropped.

**Proof:** the alias length check is a binding change, so it needs a case in
`binding.spec.js` and the matching rule in `binding-server.js`: a name at
`ALIAS_NAME_MAX` is 400 and leaves the stored alias alone. The rest is on-device: OTA,
open five browser tabs plus a `curl` stream, confirm the table stops reloading; watch the
Receiver card's `heap_kB` and confirm decodes keep arriving.

**Risk:** the `_buf[_len] = '\0'` change writes at index `_cap - 1` in the full case, which
is in bounds because `write()` caps `n` at `_cap - 1 - _len`. Verify that before trusting
it. Raising `WEB_UI_SSE_CLIENTS` adds a `_filters` row of 4 x 65 bytes plus a `WiFiClient`
per slot; check the static RAM figure in the build output.

---

## Batch 6: OTA token handling

Three items, all on the path that flashes firmware. Read the brick section above before
starting.

**Files:** `ota_token_store.h`, `ota_token_store.cpp`, `web_ui.cpp`, `provisioning.cpp`,
`.env.example`, `docs/install.md`, `docs/user-manual.md`.

**Changes:**

- **The stored token is capped shorter than `.env`'s.** `OTA_TOKEN_STORE_MAX` is 33
  (`ota_token_store.h:6`), which is 32 usable characters plus the NUL, enforced at
  `ota_token_store.cpp:46`. The `.env` on this machine has a 48-character `OTA_TOKEN`, so
  `provisioning.cpp:178`'s `token.length() >= OTA_TOKEN_STORE_MAX` rejects it with a 400
  and the board falls back to the compiled-in token with no portal-settable token at all.
  `.env.example:6` and `docs/install.md:62` both say 32 hex characters, so the `.env` is
  the outlier. Two options: regenerate `.env`'s token with `openssl rand -hex 16`, or raise
  `OTA_TOKEN_STORE_MAX` to 65 so any hex token up to 64 characters fits. Prefer raising
  it. It costs 32 bytes of static RAM, removes a class of confusing 400, and does not
  require anyone to notice a length rule.
- **No way to clear a set token.** `ota_token_store` has no `clear()`, and `set()` rejects
  an empty string (`:45-47`), so once a token is stored there is no path back to the
  "OTA disabled" 404 state short of erasing NVS. Add `bool clear()` that calls
  `_prefs.remove("token")` and empties `_stored`. Reaching it needs a route; the safe one
  is the provisioning portal, where physical access is already implied, not an HTTP route
  on the live device. Note that clearing the NVS token falls back to the `OTA_TOKEN` build
  macro rather than disabling OTA, so on a build with that macro `clear()` does not
  disable anything. Say so in `user-manual.md`.
- **Constant-time token compare.** `web_ui.cpp:600-601` builds
  `String("Bearer ") + token()` and compares with `String::operator==`, which returns on
  the first differing byte. Over a LAN with a TCP handshake per request the jitter swamps a
  one-byte delta, so this is not practically exploitable. It is worth fixing only because
  it guards the firmware-flash path: compare the header against the expected string with a
  loop that ORs the differences over a fixed length and checks the lengths separately.
  This also drops two `String` allocations from the OTA path.

**Proof:** `ota_token_store::selfTest()` runs on the host, so the cap and `clear()` get
checks there: a 48-character token round-trips, `clear()` makes `hasToken()` false, and
`set("")` still fails. The compare needs a check that a correct token, a token differing in
the last byte, and a token differing in length all give the answers they give today.
On-device: OTA once with the correct token before changing anything, OTA again after, and
confirm a wrong token still gets 401.

**Risk:** highest in the plan. A `clear()` reachable from an HTTP route would let anything
that can reach `/$update`'s neighbour turn OTA off; keep it behind the portal. Raising
`OTA_TOKEN_STORE_MAX` changes a buffer that `begin()` reads NVS into via `copyTruncated`
(`:24-25`), so an already-stored 32-character token still loads. Verify that on a board
with a token set before flashing one that has none.

**Blocked by:** nothing, but do it while a board is reachable over USB.

---

## Batch 7: the NVS stores

Three headings collapse into one commit because they touch the same five files.

**Files:** `alias_store.cpp`, `mqtt_publish_store.cpp`, `location_store.cpp`,
`units_store.cpp`, `layout_store.cpp`, `tz_store.cpp`, a new shared blob-store header,
`test/host/*_store_test.cpp`, `docs/architecture.md`.

**Changes:**

- **`putString` for a multi-KB blob.** `alias_store::persist()` writes a 2048-byte blob
  with `putString("map", blob)` (`alias_store.cpp:87`). An NVS string is one
  variable-length item that must fit a contiguous free run inside a single page, which is
  the failure `layout_store.h:9-13` documents hitting near 2.7 KB on a real device. When
  it starts failing, `set()` and `remove()` revert the in-memory change and the rename
  answers 503 with "alias store full" as the only explanation.
  `mqtt_publish_store::persist()` writes its 768-byte table the same way
  (`mqtt_publish_store.cpp:101`); at 768 bytes that is a consistency fix, not a live
  failure. Convert both to `putBytes`/`getBytes` with the migration `layout_store::load()`
  already implements (`layout_store.cpp:21-36`): read `getBytesLength(BLOB_KEY)` first and
  use it if non-zero and in range; otherwise read the legacy string key, adopt it, write it
  back with `putBytes`, and `remove()` the legacy key only if that write succeeded. The new
  key has to be a different name from the old one because NVS keys are typed and a
  `getBytesLength` on a string-typed key reads as absent, which is exactly what makes the
  two-key form work. Keep `"map"` and `"table"` as the legacy names and pick new ones for
  the bytes. `mqtt_publish_store` already has a `migrateLegacy()` (`:175-199`), but it
  migrates values (`url`/`token` into `table`), not the storage type, so the two migrations
  have to chain: legacy values first, then legacy string into bytes.
- **Rewriting an unchanged blob.** None of `layout_store`, `location_store`, `units_store`,
  `alias_store` or `tz_store` compares against the copy already in RAM before writing. A
  dashboard that autosaves the layout on each drag rewrites 5120 bytes per drag; each
  rewrite appends a new copy before the old can be erased, so live utilisation briefly
  doubles and the wear counter advances on a four-page arena. Add `if (strcmp(_blob, json)
  == 0) return true;` at the top of each `set()`, after the validation and before the
  write. `alias_store` needs its own shape: `set()` (`:111-142`) rewrites the whole table
  even when `strcmp(_names[i], name) == 0`, so the early-out goes before the `copyTruncated`
  at `:131`, guarded on the entry not being newly added. `tz_store::set()`
  (`tz_store.cpp:27-33`) is the same story with a `putShort`; it is not in the backlog and
  it is one line, but it has no `selfTest()` and the `Preferences` shim has no
  `putShort`/`getShort`, so covering it means extending the shim. Either extend it or leave
  `tz_store` alone and say why.
- **Nothing checks NVS headroom.** `LAYOUT_STORE_MAX` alone is 5120 bytes and `set()`
  accepts anything under it; the write either works or does not. Raising the partition is
  blocked on the platform hardcoding `app0`'s offset, which `partitions.csv:5-9` documents.
  The post-hoc check is sound as it stands: `putBytes(...) != len` at `layout_store.cpp:63`
  surfaces as the 503 at `web_ui.cpp:426-428`. What is missing is a number to reason with.
  Log `Preferences::freeEntries()` at each store's `begin()`, and give the 503 a message
  that names the store rather than "layout store full" for both a too-large blob and a full
  partition. Shrinking the per-card layout template is a dashboard change and belongs in
  that backlog.
- **One blob store, one check helper.** `units_store.cpp:13-52` and
  `location_store.cpp:13-52` are line-for-line identical apart from the cap macro, the
  namespace, the NVS namespace string and the log text. `layout_store.cpp` differs in three
  deliberate ways: it uses `putBytes` with the two-key migration; it persists before
  adopting (`:59-69`) where the other two adopt first and roll back from a full-size
  `previous[]` on the stack; and it expresses the NVS-unavailable case as `if (_open && ...)`
  rather than an early return. Only the second difference is load-bearing, and it is
  load-bearing in layout's favour: a 5120-byte rollback buffer on an HTTP handler's stack is
  not something the other two should grow into. Standardise all three on layout's shape.
  The template is a header taking the namespace name, the two key names and the capacity,
  exposing `begin`/`get`/`set`/`selfTest`. None of the three validates the JSON (that check
  lives in `web_ui.cpp:420-424`, `:448-452`, `:475-479`), none has a default, and none
  broadcasts, so nothing else has to be parameterised. `tz_store` is not a blob store and
  stays as it is. `alias_store` and `mqtt_publish_store` do not fit either; they
  serialize a table rather than storing a blob verbatim, so leave them out of the template
  and only give them the `putBytes` treatment above. Separately, eight files carry an
  identical `static bool check(const char* what, bool ok)`: `signal_store.cpp:408`,
  `alias_store.cpp:180`, `layout_store.cpp:74`, `location_store.cpp:55`,
  `units_store.cpp:55`, `wifi_store.cpp:96`, `ota_token_store.cpp:67`,
  `mqtt_publish_store.cpp:205`. They differ only in the literal prefix in the format
  string. Move it to one header under a `FAKE_SIGNALS` guard, taking the module name as an
  argument, with a per-file `#define CHECK(what, ok) check("alias", what, ok)` so the log
  lines keep their current shape. The three host-test files (`topic_test.cpp:12`,
  `radio_health_test.cpp:7`, `device_hooks_test.cpp:11`) have their own `check()` returning
  `void` and incrementing a failure counter; that is a different signature for a different
  job and does not join this header.
- **An alias surviving a reboot is unverified.** `alias_store::selfTest()` covers the
  in-RAM table and the round trip through a serialised blob, but never that
  `Preferences::putString` lands in NVS and survives a power cycle. The `putBytes`
  conversion above is exactly the change that would break it silently, so verify it on
  hardware in this batch: set three aliases through the dashboard, power-cycle the board
  (not a reboot), confirm all three come back. Do the same for a board upgraded from a
  build that used `putString`, which is what proves the migration.

**Proof:** host tests for all of it except the power cycle. `test/host/arduino_shim`'s
`Preferences` fake is a `std::map` with a separate set of blob-typed keys, so
`getBytesLength()` on a string key returns 0 there exactly as it does on the device, which
is what makes the migration testable; `layout_store.cpp:112-135` already exercises it. Copy
that structure for `alias_store` and `mqtt_publish_store`: seed the legacy string key,
`begin()`, assert the value loaded, assert the bytes key holds it and the legacy key is
gone. Add a check that a repeated `set()` of the same value does not write, which needs a
write counter in the shim.

**Risk:** the migration is the risk. A board that has aliases stored under the string key
and gets firmware that reads only the bytes key comes up with no aliases and, worse, may
overwrite the legacy key's content on the first save. Read the legacy key before writing
anything, and do not remove it until the bytes write returns success, exactly as
`layout_store::load()` does. Test the upgrade on a board with aliases already set before
OTAing anything that matters.

**Blocked by:** batch 2 (which also edits `alias_store.cpp`).

---

## Batch 8: diagnostics

What the firmware can say about itself when something goes wrong.

**Files:** `WebReceiver.ino`, `radio_health.h`, `signal_store.h`, `docs/architecture.md`,
`docs/user-manual.md`, `docs/development.md`.

**Changes:**

- **`RegIrqFlags1` in the health path.** Everything the firmware knows about a sick radio
  comes from `setMode` returning -16 and from the noise floor, and -16 means only "readback
  did not match". It cannot separate a chip refusing a mode change from an SPI bus that has
  stopped, which is where the last hardware fault sent the diagnosis.
  `WebReceiver.ino:323-329`'s `reinitRadio()` is the place to read it: `RegIrqFlags1`
  (0x27) carries ModeReady in bit 7 and PllLock in bit 4. Read it before and after the
  `initReceiver()` call, log both, and carry the post-reinit byte in the telemetry JSON
  built at `:406-430` as `irq1`. Settle the bus question in the same pass: write a scratch
  value to `RegOokFix` and read it back, and check `RegVersion` reads 0x24. A bus that
  cannot round-trip a register write says "SPI", not "radio".
- **The self-test has never been read on a live device.** `setup()` runs
  `signal_store::selfTest()` and seven others under `FAKE_SIGNALS` (`:563-572`) and
  `ArduinoLog` writes to `Serial0` at 921600 (`:496-501`), a hardware UART, while the port
  exposed over USB is the S3's CDC device. Under `FAKE_SIGNALS` only, point `Log.begin()`
  at `Serial` so the PASS/FAIL lines come out over USB. Guard it so a production build
  keeps `Serial0`, which is what `monitor.py`'s default baud expects. Note this reads the
  same 51 plus 22 checks that `test/host/run.sh` already runs on every commit; the value is
  proving the on-device build runs them, not the checks themselves.
- **Decode and drop counts in telemetry.** `signal_store::totalRecorded()` and
  `droppedCount()` have no caller outside `selfTest()`, though `_total` and `_dropped` are
  maintained on every record. The Receiver card reports heap, uptime and recovery count but
  not these two. Add `"decodes":%lu,"drops":%lu` to the telemetry JSON at
  `WebReceiver.ino:406-430`. The buffer is `JSON_MSG_BUFFER` 512 and `appendf` clamps, but
  the store then drops anything over `SIGNAL_PAYLOAD_MAX` 600, so check the assembled
  length on-device before assuming it fits. Add the fields to
  `dashboard/test/fixtures.js` and `receiver/test/fixtures.js` so the card tests see them.

**Proof:** on-device for all three. Build with `FAKE_SIGNALS`, run `python3 monitor.py`,
confirm the PASS lines appear over USB. For the radio registers, the only honest check is
a board with a working radio (expect ModeReady and PllLock set, `RegVersion` 0x24) and, if
one can be produced, a board with the fault. The register reads themselves cannot be host
tested; `radio_health.cpp` deliberately takes the values as parameters and that boundary
should not move. For the counts, `curl` the Receiver topic and read the JSON.

**Risk:** the `Log.begin(&Serial)` change under `FAKE_SIGNALS` changes what a monitor sees;
a production build is untouched. The register reads happen inside `reinitRadio()`, which
already runs with the receiver task stopped (`:318-322` explains why), so they do not race
the task's RSSI reads. Adding a read to a path that runs during recovery is the one place
a hung SPI transaction would hang `loop()`; use `SPIgetRegValue`, which is bounded, and not
a polling loop.

---

## Batch 9: the provisioning portal

Last, because it needs the board in hand and it is the path back from a bad flash.

**Files:** `provisioning.cpp`, `WebReceiver.ino`, `docs/install.md`, `docs/quickstart.md`,
`docs/user-manual.md`.

**Changes:**

- **The AP is open and hands out an OTA token.** `WiFi.softAP(ap, nullptr)`
  (`provisioning.cpp:214`) brings up an unencrypted network. `handleRoot()` generates a
  fresh token with `randomToken()` on every GET (`:112-113`) and renders it into the form,
  and `handleSave()` stores whatever comes back (`:188`). Anyone in range of a board
  sitting in the portal can join, submit their own SSID and a token of their choosing, and
  take the board onto their network with an OTA credential they control; `POST /$update`
  then accepts arbitrary firmware. Add a WPA2 password to the SoftAP. Derive it from the
  chip ID so it is reproducible without a label: the AP name already uses the last two MAC
  bytes (`:31-35`), so use more of the MAC or an `esp_efuse_mac_get_default()` hash,
  rendered as 8 to 10 hex characters, and print it over serial at portal start alongside
  the existing `provisioning: AP "%s" up at %s` line. Document where to find it in
  `install.md` and `quickstart.md`, which describe the first-run path.
- **`MDNS_PREFIX` has no runtime equivalent.** It only takes effect at build time
  (`WebReceiver.ino:40-42`), and the portal has no field for it, so a device provisioned
  entirely through SoftAP always uses `rtl433`. Add a text field to the form
  (`provisioning.cpp:130-141`), a small NVS-backed store for it in the pattern batch 7
  templates, and have `mdnsHostname()` (`:126-134`) prefer the stored value over the macro.
  The stored prefix also becomes `signal_store::source()` (`WebReceiver.ino:548`), which is
  the first segment of every topic key, so changing it renames every device on the
  dashboard. Say that on the form.

**Proof:** on-device only. Reset a board into the portal with the BOOT-button hold, join
the AP with the printed password, provision it, confirm it joins the network and that a
wrong password is refused. Then repeat with an mDNS prefix set and confirm both
`<prefix>-xxxxxx.local` resolves and the topic keys carry the new source.

**Risk:** the highest of any batch for lockout. A WPA2 password derived wrongly, or printed
in a format that does not match what the AP accepts, leaves a board that cannot be
provisioned at all except by reflashing over USB. Prove the derivation on a bench board
first. The mDNS prefix change renames every topic, which orphans the stored layout and
every alias, since both key on the full topic. Either say so in the form's help text or
have the portal warn. Neither of these should ever go out as an OTA to a board that is not
physically reachable.

---

## Not worth doing, or deferred

**Build-time secrets are readable in the firmware image.** `load_env.py:21-39` turns every
`.env` entry into a `-D` string macro, and `ota_token_store.cpp:34-35` and
`mqtt_publish.cpp:250-259` return them as fallbacks, so the literals link into `.rodata`.
`.env` is gitignored and untracked, so nothing is in git history, but a `.bin` shared for
flashing, or `esptool.py read_flash` on a recovered board, yields all three as plain
strings. The build-time path is the dev and CI shortcut and removing it removes the
shortcut. Mitigate by documenting the rule instead: never share a `.bin` built from a
populated `.env`, and provision through the portal for anything that leaves the bench.
Revisit if CI ever publishes an image.

**No path in for sensors that are not 433 MHz decodes.** The I2C half of this is done. The
BMP280 is initialised at `WebReceiver.ino:513-525`, read and recorded through
`signal_store::record()` at `:368-389`, and driven every 30 s from `loop()` at `:595-599`.
Delete that bullet from the backlog and fold the sensor into `architecture.md`. The
remaining half, an authenticated `POST /api/signal` taking the same rtl_433 JSON, is a
feature rather than a defect and needs its own design pass: it wants the OTA token or a
second credential, a rate limit, and a decision about whether an ingested record counts
toward `totalRecorded()`. Leave it in the backlog as a feature.

**A below-floor noise reading has no error marking on the card.** The firmware already
emits everything needed: `radio_ok`, `noise_dBm` and `rssi_thresh`
(`WebReceiver.ino:401-429`). The missing piece is the card rendering, which lives in
`dashboard/src/`, not here. Move this item to the dashboard backlog.

**A slow HTTP client can still stall the receive path.** `ChunkedResponse::flush()` waits
up to `CHUNK_WAIT_US` 150 ms per chunk with a `CHUNK_BUDGET_MS` 1.5 s budget
(`web_ui.cpp:118-119, 146-160`) before dropping the client, and the library's pulse-train
ring is two deep, so signals arriving during a stall are overwritten. The bound exists
because aborting on the first not-ready probe truncated the page. Removing the risk means
serving the page off a second task, which the single-task design deliberately avoids. A
healthy client never waits. Leave it, and leave the reasoning in `architecture.md`.

**A `POST /$update` upload blocks `loop()` for the whole transfer.**
`handleUpdateUpload()` runs synchronously inside `_server.handleClient()` for every chunk,
so `rf.loop()` does not run until the upload finishes, likely several seconds for a 1.2 MB
image. Same shape as the previous item and same answer: fixing it properly means a second
task. It happens only during a deliberate flash, when dropped decodes do not matter.

**The compiled decoders are 15% of the image.** 172,009 bytes of `.flash.text` for 319
decoders, against an `app0` of 4 MB at 28% used. False decodes are filtered in firmware.
Nothing motivates narrowing `MY_DEVICES`. Delete the entry.

**Every `mqtts://` bridge is pinned to ISRG Root X1.** `mqtt_publish.cpp:25-57, 132` sets
that one CA, so a broker not chained to Let's Encrypt fails its handshake with nothing but
a dot that never turns green. The fix is a configurable CA, which needs a form field, a
multi-KB NVS entry on a partition batch 7 is already careful with, and a decision about
whether to allow no verification at all. Defer until someone has a broker that needs it.
Cheap partial mitigation, worth folding into batch 4: log the `WiFiClientSecure` handshake
error so the reason reaches the serial log.

**Each record is serialised twice.** `mqtt_publish::onRecord` writes the doc into a
601-byte stack buffer (`:281-283`) and `signal_store::record()` writes the identical doc
into `sub.payload` a few lines later (`signal_store.cpp:272`). Serialising once means
changing the hook contract from "gets the doc" to "gets the serialised payload", which
breaks `device_hooks::dispatch`, the other hook, because it mutates the doc. Worth doing
only if the decode path measures hot. It has not been measured.

---

## Where the backlog did not match the code

- **`DEVICE_STALE_HOURS=0` does disable expiry.** The backlog says the `staleMs == 0` early
  return "skips only the device loop". It does not: the return at
  `signal_store.cpp:371-373` is the first statement in `sweepStale()`, ahead of both the
  device loop and the `sweepSubStale()` call at `:382`, so a zero window sweeps nothing at
  all. `selfTest()` asserts exactly this at `:549-550`. The rest of that entry holds: with
  `DEVICE_STALE_HOURS` non-zero, `SUB_STALE_MS` caps retention at one hour.
- **`OTA_TOKEN_STORE_MAX` is 33, not 32.** `ota_token_store.h:5-6` documents it as 32 hex
  characters plus the NUL, and `ota_token_store.cpp:46` enforces `strlen(t) <
  OTA_TOKEN_STORE_MAX`. The usable length is 32, so the mismatch with a 48-character
  `.env` token is real, but a fix that sets the constant to 32 would allow only 31
  characters.
- **The portal's token field is `maxlength="32"`.** `provisioning.cpp:137`. A 48-character
  token pasted into a browser is truncated by the input before it is submitted, so the 400
  at `:178-181` needs a hand-built POST. The observable symptom on a browser is a silently
  shortened token, not an error.
- **The keepalive line reference is off by one path.** The backlog cites `web_ui.cpp:985`
  as the place a stopped client is not routed through `releaseSlot()`. That line is inside
  the `!socketReadyToWrite` branch, which does call `releaseSlot(i)`. The path that stops a
  client without releasing the slot is `sendFrameOrDrop` at `:988`.
- **The replay cursor is 68 indices, not 64.** `SIGNAL_SUB_TABLE` 32 plus `ALIAS_SLOTS` 32
  plus layout, location, tz and units.
- **The NVS capacity framing is not supported by either accounting.** The heading says the
  20 KB partition "cannot promise" the blobs. The entry's own numbers are about 16 KB
  usable against an 8.8 KB worst case, and `architecture.md:314-320` puts the worst case at
  about 11 KB against 20 KB and calls the partition three times what the firmware can use.
  Neither shows a capacity shortfall. The verified problem is the single-page contiguous
  run that `putString` needs, which is what `layout_store.h:9-13` documents hitting near
  2.7 KB. I did not measure live NVS utilisation on the device; that number is still open.
- **`fetch_coredump.sh`'s hardcoded offset currently agrees with the table.**
  `partitions.csv:16` is `coredump, data, coredump, 0xFF0000, 0x10000`, which is what
  `tools/fetch_coredump.sh:10` passes. The item is a staleness risk, not a live bug.
- **Line references have drifted a few lines in two files.** In `signal_store.cpp` the slot
  claim is at `:251-254` and the sub-claim failure at `:264-268`, not `:252-254` and
  `:268-272`. In `web_ui.cpp` the OTA token compare is at `:600-601`, not `:593-598`.
- **Eight copies of `check()` is exactly right** for the firmware: `signal_store`,
  `alias_store`, `layout_store`, `location_store`, `units_store`, `wifi_store`,
  `ota_token_store`, `mqtt_publish_store`. Three more live in the host tests with a
  different signature and are not part of the same duplication.
- **`signal_store::indexOf` has no coverage at all**, not just a weak check. The backlog
  groups it with `alias_store::indexOf`, whose check passes for the wrong reason;
  `signal_store::indexOf` is never called from `selfTest()`, and
  `test/host/signal_store_test.cpp` is a nine-line shim that only calls `selfTest()`.
