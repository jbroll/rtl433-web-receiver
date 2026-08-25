# Alias and Units Replication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the aliases and units a receiver holds reach a dashboard served by the bridge, so `weather.rkroll.com` shows the same names and units as the receiver's own page.

**Architecture:** The receiver already mirrors `$layout`, `$location`, `$units` and `$tz` to every configured broker through `mqtt_publish`, both on write and on connect. Aliases are the one stored kind with no publish path: `mqtt_publish` has no alias function and `replayAll()` does not walk `alias_store`. Task 1 adds that path. `$units` needs no code — the plumbing works, the receiver has simply never had a units value written to it, so Task 2 writes one.

**Tech Stack:** ESP32-S3 firmware (Arduino, PlatformIO, PubSubClient, ArduinoJson), the node bridge on `weather.rkroll.com`, the preact dashboard.

## Global Constraints

- **Never open a pull request.** Work lands on `main` locally. Nothing is pushed unless John says so.
- Docs change in the same commit as the code they describe. For firmware internals that is `receiver/docs/architecture.md`.
- Deferred work goes in a backlog document, never a code comment.
- Comments say why, never what. One or two lines. Default to none.
- The receiver is updated over OTA (`node tools/flash-ota.js <ip>`), never USB `pio -t upload`. Its address is `192.168.1.240`, MAC `f0:f5:bd:43:54:c8`.
- `OTA_TOKEN` comes from `receiver/.env`.
- Full suite: `bin/test.sh` from the repo root.

---

### Task 1: Give the receiver a units value to publish

**Files:** none. This task writes NVS on the device and verifies the existing path.

**Model:** `haiku` — verification commands only; the one action is a click John makes.

**Interfaces:**
- Consumes: nothing.
- Produces: a retained `rtl433-4354c8/$units` on the bridge. Task 3's end-to-end check expects it.

**Why there is no code change:** `dashboard/src/settings.js:173` `publishUnits()` POSTs to `${location.origin}/$units`, gated on the origin being a configured source. `receiver/web_ui.cpp:469` accepts it and `:484` calls `mqtt_publish::publishUnits()`. Every link works. `GET http://192.168.1.240/$units` answers `no message` because nothing has ever called it — `publishUnits()` fires only from a unit change or the Save button, and neither has happened since 7fdc1ab landed.

- [ ] **Step 1: Record the failing state**

```bash
curl -s -m 6 'http://192.168.1.240/$units'; echo
curl -s -N -m 8 'https://weather.rkroll.com/events?f=%23' | grep -c '\$units'
```

Expected: `no message` from the receiver, `0` from the bridge.

- [ ] **Step 2: Write the units (John does this)**

Open `http://192.168.1.240/` in a browser. In the Settings gear, pick the units you want (imperial, or metric explicitly), or press **Save as default layout**, which calls `publishUnits()` alongside `postLayout()`.

- [ ] **Step 3: Verify the receiver stored it**

```bash
curl -s -m 6 'http://192.168.1.240/$units'; echo
```

Expected: a JSON object, e.g. `{"units":"imperial","decimals":1,"custom":{"temp":"F","rain":"in","wind":"mi/h","pressure":"hPa"}}`

- [ ] **Step 4: Verify it reached the bridge**

```bash
curl -s -N -m 8 'https://weather.rkroll.com/events?f=%23' | grep -o '"topic":"[^"]*\$units"'
```

Expected: `"topic":"rtl433-4354c8/$units"`

- [ ] **Step 5: No commit**

Nothing in the working tree changed. Move to Task 2.

---

### Task 2: Publish `$alias` from the receiver over MQTT

**Files:**
- Modify: `receiver/mqtt_publish.h` — add the `publishAlias` declaration after `publishUnits` (currently `:28-29`)
- Modify: `receiver/mqtt_publish.cpp` — add the `alias_store.h` include, the payload helper, the alias walk in `replayAll()` (currently ends at `:183`), and `publishAlias()`
- Modify: `receiver/web_ui.cpp:399` — call `mqtt_publish::publishAlias` from `handleAliasPost`
- Modify: `receiver/docs/architecture.md` — the `mqtt_publish.h` / `mqtt_publish.cpp` entry, around `:205-235`

**Model:** `sonnet` — four files across two layers, and the buffer sizing and the delete semantics are judgment, not transcription.

**Interfaces:**
- Consumes: `alias_store::topicAt(uint8_t)`, `alias_store::nameAt(uint8_t)` (both `NULL` for a free entry), `ALIAS_SLOTS` (32) and `ALIAS_NAME_MAX` (32) from `receiver/alias_store.h`.
- Produces: `void mqtt_publish::publishAlias(const char* topic, const char* name)`.

**Two things to get right:**

An alias topic already carries the source segment — `alias_store` holds `rtl433-4354c8/BMP280/0x76/$alias`, and `handleAliasPost` rejects anything not under the receiver's own source. So it is published verbatim, not under `<clientId>/` the way `$layout` and friends are.

An empty name is a delete. `bridge/src/broker.js:154` deletes its cached topic on a zero-length publish carrying the retain flag, and `server.js:109` then answers 404. Publishing `""` retained is therefore what removes a name from the bridge; publishing nothing at all would leave the old name retained forever.

- [ ] **Step 1: Record the failing state**

```bash
echo "receiver:"; curl -s -N -m 8 'http://192.168.1.240/events?f=%23' | grep -c '\$alias'
echo "bridge:";   curl -s -N -m 8 'https://weather.rkroll.com/events?f=%23' | grep -c '\$alias'
```

Expected: a non-zero count from the receiver (6 at the time of writing), `0` from the bridge. That gap is the bug.

- [ ] **Step 2: Declare `publishAlias`**

In `receiver/mqtt_publish.h`, directly after the `publishUnits` declaration and before `publishTz`:

```cpp
// Publishes one alias, retained. An alias topic already carries the source
// segment, so it goes out verbatim rather than under <clientId>. An empty
// name publishes a zero-length retained message, which is what deletes the
// bridge's retained copy. Same fire-and-forget behavior as onRecord.
void publishAlias(const char* topic, const char* name);
```

- [ ] **Step 3: Add the include and the payload helper**

In `receiver/mqtt_publish.cpp`, add to the include block (which runs `layout_store.h`, `location_store.h`, `units_store.h`, `mqtt_publish_store.h`, `signal_store.h`, `tz_store.h`):

```cpp
#include "alias_store.h"
```

Then, inside `namespace mqtt_publish {` and above `replayAll()`:

```cpp
// Every one of ALIAS_NAME_MAX characters can escape to \u00xx, plus two
// quotes and the terminator.
#define ALIAS_PAYLOAD_MAX (ALIAS_NAME_MAX * 6 + 3)

static size_t aliasPayload(char* out, size_t outSize, const char* name) {
  JsonDocument doc;
  doc.set(name);
  size_t n = serializeJson(doc, out, outSize);
  return n > 0 && n < outSize ? n : 0;
}
```

- [ ] **Step 4: Walk the alias table in `replayAll()`**

In `receiver/mqtt_publish.cpp`, in `replayAll()`, after the `units` block and before the `$tz` block:

```cpp
  for (uint8_t i = 0; i < ALIAS_SLOTS; i++) {
    const char* topic = alias_store::topicAt(i);
    const char* name  = alias_store::nameAt(i);
    if (topic == nullptr || name == nullptr || name[0] == '\0') continue;
    char   payload[ALIAS_PAYLOAD_MAX];
    size_t pn = aliasPayload(payload, sizeof(payload), name);
    if (pn > 0 && c.mqtt.publish(topic, payload, true)) sent++;
  }
```

- [ ] **Step 5: Implement `publishAlias`**

In `receiver/mqtt_publish.cpp`, after `publishUnits()` and before `publishTz()`:

```cpp
void publishAlias(const char* topic, const char* name) {
  if (_connCount == 0) return;
  if (topic == nullptr || topic[0] == '\0') return;
  char payload[ALIAS_PAYLOAD_MAX];
  // A cleared alias is a zero-length retained publish, the only thing that
  // drops the bridge's retained copy.
  payload[0] = '\0';
  if (name != nullptr && name[0] != '\0'
      && aliasPayload(payload, sizeof(payload), name) == 0) return;
  for (uint8_t i = 0; i < _connCount; i++) {
    Connection& c = _conn[i];
    if (c.enabled && c.mqtt.connected()) c.mqtt.publish(topic, payload, true);
  }
}
```

- [ ] **Step 6: Call it from the alias POST handler**

In `receiver/web_ui.cpp`, in `handleAliasPost`, the line after `web_ui::broadcastAlias(path, name);`:

```cpp
  web_ui::broadcastAlias(path, name);
  mqtt_publish::publishAlias(path, name);
```

`mqtt_publish.h` is already included by `web_ui.cpp` — `handleLayoutPost` calls `mqtt_publish::publishLayout` at `:428`.

- [ ] **Step 7: Compile**

```bash
cd receiver && pio run -e esp32s3-generic
```

Expected: `SUCCESS`. A `-Werror` build, so an unused variable or a narrowing conversion fails here.

- [ ] **Step 8: Run the host suite**

```bash
bash bin/test.sh
```

Expected: `all suites passed`. Nothing here covers `mqtt_publish.cpp` — it pulls in `PubSubClient` and `WiFi`, which `test/host/arduino_shim` does not fake — so this is a no-regression check, not a check of the new code. Steps 9 through 11 are what verify the change.

- [ ] **Step 9: Update the architecture doc**

In `receiver/docs/architecture.md`, in the paragraph that begins "`onRecord()`, registered as a second `signal_store` record hook", add after that paragraph's description of the store publishers:

```markdown
`publishAlias()` is the one publisher whose topic is not built from the client
id. An alias topic already carries the source segment, and `handleAliasPost`
refuses one outside the receiver's own source, so it is published as it
stands. A cleared alias goes out as a zero-length retained publish, which is
what makes a bridge drop its retained copy rather than serve a name that no
longer exists. `replayAll()` walks all `ALIAS_SLOTS` on connect for the same
reason it replays the four stores: a bridge that restarts loses its retained
set, and nothing else would put the names back.
```

- [ ] **Step 10: Commit**

```bash
cd /home/john/src/rtl433-web-receiver
git add receiver/mqtt_publish.h receiver/mqtt_publish.cpp receiver/web_ui.cpp receiver/docs/architecture.md
git commit -m "$(cat <<'MSG'
feat(receiver): publish $alias to every configured broker

mqtt_publish carried $layout, $location, $units and $tz but never aliases, and
replayAll() did not walk alias_store, so a name set on the receiver stayed on the
receiver. The dashboard on weather.rkroll.com showed six devices under their raw
model/id while the receiver's own page showed their names.

An alias topic already carries the source segment, so publishAlias() publishes it
verbatim rather than under <clientId>. A cleared alias goes out as a zero-length
retained publish, which is what bridge/src/broker.js treats as a delete.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

- [ ] **Step 11: Flash over OTA**

```bash
cd receiver && node tools/flash-ota.js 192.168.1.240
```

Expected: HTTP 200, then the board restarts. Give it a minute and confirm it is back:

```bash
curl -s -m 10 'http://192.168.1.240/rtl433-4354c8/Receiver/0' | head -c 200; echo
```

Expected: JSON with a `build` matching the new commit and `boot_count` one higher than before.

- [ ] **Step 12: Verify aliases reached the bridge**

```bash
curl -s -N -m 10 'https://weather.rkroll.com/events?f=%23' | grep -o '"topic":"[^"]*\$alias"' | sort
```

Expected: the same alias topics the receiver lists in Step 1's first command. If the count is short, the receiver has not reconnected to the broker yet — `replayAll()` runs on connect and the backoff is `MQTT_RECONNECT_BACKOFF_MS` (30 s). Wait and re-run.

- [ ] **Step 13: Verify a delete clears the bridge**

A curl POST carries no `Origin` header, which `sameOriginOrBare()` allows, so no token is involved here.

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'Content-Type: application/json' -d '"Scratch"' \
  'http://192.168.1.240/rtl433-4354c8/BMP280/0x76/$alias'
sleep 2
curl -s -m 6 'https://weather.rkroll.com/rtl433-4354c8/BMP280/0x76/$alias'; echo
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'Content-Type: application/json' -d '""' \
  'http://192.168.1.240/rtl433-4354c8/BMP280/0x76/$alias'
sleep 2
curl -s -m 6 'https://weather.rkroll.com/rtl433-4354c8/BMP280/0x76/$alias'; echo
```

Expected: `204`, then `"Scratch"`, then `204`, then `no message`.

Restore whatever name that device had before this step, through the same POST.

---

### Task 3: End-to-end check on the live site

**Files:**
- Create: none. This is a verification task; it produces no commit unless it finds a defect.

**Model:** `sonnet` — reads a live page and judges whether what it sees matches the receiver.

**Interfaces:**
- Consumes: the retained `$alias` set from Task 2 and the retained `$units` from Task 1.
- Produces: nothing.

- [ ] **Step 1: Load the site in a fresh browser profile**

Write `dashboard/probe.cjs` (playwright resolves from `dashboard/node_modules`; delete the file afterwards):

```javascript
const { chromium } = require('playwright')
;(async () => {
  const b = await chromium.launch(); const p = await (await b.newContext()).newPage()
  await p.goto('https://weather.rkroll.com/', { waitUntil: 'load' })
  await p.waitForTimeout(12000)
  console.log(JSON.stringify(await p.evaluate(() => ({
    aliases: JSON.parse(localStorage.getItem('rtl433.aliases.v1') || 'null'),
    order: window.cardState.order,
    cardText: document.body.innerText.slice(0, 1200),
  })), null, 1))
  await b.close()
})()
```

```bash
cd dashboard && node probe.cjs; rm -f probe.cjs
```

- [ ] **Step 2: Check the three things against the receiver**

Expected in that output:

- `aliases` holds one entry per alias the receiver has, keyed `https://weather.rkroll.com rtl433-4354c8/<model>/<id>`, with the same names `http://192.168.1.240/events?f=%23` reports.
- `cardText` shows readings in the units Task 1 wrote — `°F` and `mi/h` if you picked imperial. Read the rendered text rather than `localStorage`: `onUnitsFrame` in `dashboard/src/settings.js:87` deliberately does not call `saveSettings()`, so a browser that merely adopted the receiver's units has no `rtl433.settings.v1` entry at all.
- `order` matches the `order` array in `rtl433-4354c8/$layout`.

If `aliases` is empty but Step 12 of Task 2 listed the topics, the gap is on the dashboard side, not the firmware's: check `applyAliasFrame` in `dashboard/src/alias.js:51` against what `stream.js` hands it.

- [ ] **Step 3: Fold the outage notes into the docs and delete them**

`docs/outage-2026-08-25.md` is untracked working notes. Its three open items outlive it:

- `OTA_TOKEN` in `.env` is 48 characters and the portal's `OTA_TOKEN_STORE_MAX` is 32, so the portal cannot store the token OTA uses. Add that to `receiver/docs/backlog.md` as its own section.
- The `listener` Pi's sshd is still down and unrelated to this repo. It belongs in neither backlog; drop it.
- A core dump is still pending in flash with no matching ELF on disk. Add that to `receiver/docs/backlog.md`.

```bash
cd /home/john/src/rtl433-web-receiver
rm docs/outage-2026-08-25.md
git add receiver/docs/backlog.md
git commit -m "$(cat <<'MSG'
docs(receiver): backlog the OTA token length mismatch and the orphaned core dump

The provisioning portal caps a stored token at OTA_TOKEN_STORE_MAX (32) while
.env's OTA_TOKEN is 48 characters, so the portal answers 400 and the board keeps
only the compiled-in fallback. Separately, a core dump from a pre-6b8b3df panic is
still in flash and the ELF that would symbolize it is gone.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

## Not in this plan

`bridge/public/index.html` was two days stale on `weather.rkroll.com`, which is why the site default layout applied to the radio cards but not the feed cards — the deployed bundle predated 0854fec. `deploy.sh update` rebuilds it (`modules/node_app/build.sh:26`), so there is no code defect; the deploy had simply not been run since Aug 23. Redeployed and verified on 2026-08-25.
