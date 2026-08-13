# Card Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third tab, Cards, that renders each tracked device as a card in a per-browser editable grid.

**Architecture:** The page is a PROGMEM string with no build step. A new `cards_html.h` holds a second PROGMEM array with the Cards markup, CSS, and script; `handleRoot()` streams `INDEX_HTML` then `CARDS_HTML` as one response. The card view is a second renderer over the existing `devices` Map — no new endpoints, no change to the data path. Layout state lives in one localStorage key. A Node test harness extracts the same PROGMEM literals the firmware serves, serves them over HTTP with a mock `/api/state` and `/events`, and Playwright drives that page, so the browser behaviour is testable without a radio or a flash.

**Tech Stack:** C++ (Arduino/ESP32, PlatformIO), vanilla browser JS (no libraries, no bundler), Node 22 + `@playwright/test` for tests.

## Global Constraints

- No JS libraries and no build step for the page. Hand-rolled pointer events for drag (`pointerdown` / `pointermove` / `pointerup` with `setPointerCapture`).
- No new HTTP endpoints and no firmware behaviour changes beyond streaming the second PROGMEM array.
- One localStorage key: `rtl433.cards.v1`.
- Value order never moves between cards.
- Storage entries are never pruned. Devices or fields absent from storage get defaults and are appended.
- Corrupt or unparseable JSON is discarded and defaults rebuild. If localStorage throws, state lives in memory for the session.
- Writes happen on each completed edit action, never during a drag.
- Re-rendering is suppressed while a drag is in progress.
- Font size for every value in a card: `2.4rem × √(cells ÷ visibleCount)`, clamped to `0.9rem`–`2.6rem`, where `cells` is the card's span area (1, 2, or 4).
- Grid: `repeat(auto-fill, minmax(170px, 1fr))`, fixed row height ~150px, `grid-auto-flow: dense`.
- Expected flash-size delta under 15 KB.
- Docs change in the same commit as the code. Prose follows the house style in `~/.claude/CLAUDE.md`: plain words, no filler, no marketing, comments say why and never what.
- Never open a pull request. Commit to the current branch (`card-dashboard`) only.

---

## File Structure

| File | Responsibility |
|---|---|
| `cards_html.h` (create) | `CARDS_HTML` PROGMEM array: the `<section id="view-cards">` markup, all card CSS, all card script, and the closing `</body></html>`. |
| `index_html.h` (modify) | Gains the Cards nav button and a `renderCards` no-op hook; loses its closing `</body></html>`; `showTab` iterates a `TABS` list. |
| `web_ui.cpp` (modify) | `handleRoot()` streams both arrays through one `ChunkedResponse`. |
| `test/harness.js` (create) | Extracts the PROGMEM literals, serves the assembled page plus a mock `/api/state` and `/events`, exposes `emit()` for driving live signals from a test. |
| `test/fixtures.js` (create) | Sample rtl_433 payloads shared by tests. |
| `test/cards.spec.js` (create) | Playwright tests for the Cards view. |
| `playwright.config.js`, `package.json` (create) | Test runner config. |
| `README.md`, `docs/backlog.md` (modify) | Document the Cards tab and the test setup. |

`cards_html.h` grows across Tasks 3–7. Each task appends one clearly bounded region to the same three blocks (CSS, markup, script), so the file stays one PROGMEM array as the spec requires.

---

### Task 1: Test harness and a baseline test

**Files:**
- Create: `package.json`, `playwright.config.js`, `test/harness.js`, `test/fixtures.js`, `test/cards.spec.js`
- Modify: `.gitignore`

**Model:** `sonnet` — multi-file setup, and the harness must match the real page's fetch/SSE contract.

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `test/harness.js` exports `startServer(opts) -> Promise<Server>` where `Server` is `{ url: string, emit(payload: object, meta?: {rssi?: number, count?: number}): void, close(): Promise<void> }`. `opts.devices` is an array of payload objects seeded into `/api/state`.
  - `test/fixtures.js` exports `ACURITE` (object), `OREGON` (object), `THERMO` (object).

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "rtl433-web-receiver-tests",
  "private": true,
  "type": "commonjs",
  "scripts": {
    "test": "playwright test"
  },
  "devDependencies": {
    "@playwright/test": "^1.49.0"
  }
}
```

- [ ] **Step 2: Add test artifacts to `.gitignore`**

Append these lines to `.gitignore`:

```
node_modules
test-results
playwright-report
```

- [ ] **Step 3: Install the runner**

Run: `npm install`
Expected: `added N packages`. Playwright browsers are already cached under `~/.cache/ms-playwright`; if `npx playwright test` later reports a missing browser, run `npx playwright install chromium`.

- [ ] **Step 4: Create `playwright.config.js`**

```js
const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./test",
  timeout: 15000,
  expect: { timeout: 5000 },
  fullyParallel: false,
  workers: 1,
  use: { headless: true },
});
```

- [ ] **Step 5: Create `test/fixtures.js`**

```js
const ACURITE = {
  model: "Acurite-5n1", id: 396, channel: "A", protocol: 40,
  sequence_num: 0, battery_ok: 1, wind_avg_mi_h: 4.6,
  temperature_F: 71.2, humidity: 38, mic: "CHECKSUM",
};

const OREGON = {
  model: "Oregon-THN132N", id: 23, channel: 1, protocol: 12,
  battery_ok: 1, temperature_C: 19.4, mic: "CRC",
};

const THERMO = {
  model: "Fineoffset-WH2", id: 174, protocol: 55,
  battery_ok: 0, temperature_C: 4.1, humidity: 91, mic: "CRC",
};

module.exports = { ACURITE, OREGON, THERMO };
```

- [ ] **Step 6: Create `test/harness.js`**

`index_html.h` currently ends with `</body></html>`; `cards_html.h` does not exist yet. The harness tolerates both so it works before and after Task 2.

```js
const fs = require("fs");
const http = require("http");
const path = require("path");

const ROOT = path.join(__dirname, "..");

// The firmware serves these arrays verbatim, so the tests must read the same
// source rather than a copy that can drift.
function progmem(file, name) {
  const full = path.join(ROOT, file);
  if (!fs.existsSync(full)) return "";
  const src = fs.readFileSync(full, "utf8");
  const re = new RegExp(name + "\\[\\]\\s*PROGMEM\\s*=\\s*R\"rawliteral\\(([\\s\\S]*?)\\)rawliteral\";");
  const m = src.match(re);
  if (!m) throw new Error("no " + name + " literal in " + file);
  return m[1];
}

function page() {
  return progmem("index_html.h", "INDEX_HTML") + progmem("cards_html.h", "CARDS_HTML");
}

function startServer(opts = {}) {
  const started = Date.now();
  const now = () => Date.now() - started;
  const devices = new Map();
  const events = [];
  const streams = new Set();

  function put(payload, meta = {}) {
    const key = payload.model + "/" + (payload.id !== undefined ? payload.id : payload.channel);
    const prev = devices.get(key);
    const rec = {
      key: key,
      model: payload.model,
      rssi: meta.rssi !== undefined ? meta.rssi : -72,
      lastSeen: now(),
      count: meta.count !== undefined ? meta.count : (prev ? prev.count + 1 : 1),
      payload: JSON.stringify(payload),
    };
    devices.set(key, rec);
    events.unshift({ at: rec.lastSeen, payload: rec.payload });
    if (events.length > 40) events.length = 40;
    return rec;
  }

  for (const p of opts.devices || []) put(p);

  const server = http.createServer((req, res) => {
    const url = req.url.split("?")[0];
    if (url === "/") {
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      res.end(page());
      return;
    }
    if (url === "/api/state") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({
        now: now(), total: events.length, dropped: 0,
        devices: [...devices.values()], events: events,
      }));
      return;
    }
    if (url === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      });
      res.write("retry: 3000\n\n");
      streams.add(res);
      req.on("close", () => streams.delete(res));
      return;
    }
    res.writeHead(404).end("not found");
  });

  return new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        url: "http://127.0.0.1:" + server.address().port + "/",
        emit(payload, meta) {
          const rec = put(payload, meta);
          const frame = "event: signal\ndata: " + JSON.stringify({
            at: rec.lastSeen, now: now(), key: rec.key,
            rssi: rec.rssi, count: rec.count, payload: rec.payload,
          }) + "\n\n";
          for (const s of streams) s.write(frame);
        },
        close() {
          for (const s of streams) s.end();
          return new Promise(done => server.close(done));
        },
      });
    });
  });
}

module.exports = { startServer, page };
```

- [ ] **Step 7: Write the failing baseline test**

Create `test/cards.spec.js`:

```js
const { test, expect } = require("@playwright/test");
const { startServer } = require("./harness");
const { ACURITE, OREGON } = require("./fixtures");

let server;

test.afterEach(async () => { if (server) await server.close(); server = null; });

async function open(page, devices) {
  server = await startServer({ devices: devices || [] });
  await page.goto(server.url);
  await expect(page.locator("#status")).toHaveText("live");
  return server;
}

test("the served page lists devices and streams live signals", async ({ page }) => {
  await open(page, [ACURITE]);
  await expect(page.locator("#devices tr")).toHaveCount(1);
  await expect(page.locator("#devices tr").first()).toContainText("Acurite-5n1");

  server.emit(OREGON);
  await expect(page.locator("#devices tr")).toHaveCount(2);
});
```

- [ ] **Step 8: Run it**

Run: `npx playwright test`
Expected: PASS, 1 test. This test exercises the page as it is today; it is the harness's proof, and every later task builds on it. If it fails, the harness is wrong, not the page.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json playwright.config.js test .gitignore
git commit -m "Add a Playwright harness that serves the PROGMEM page"
```

---

### Task 2: Serve a second PROGMEM array and add the Cards tab

**Files:**
- Create: `cards_html.h`
- Modify: `index_html.h:35-37` (nav), `index_html.h:204-211` (tab switching), `index_html.h:217-218` (closing tags), `web_ui.cpp:202-217` (`handleRoot`)
- Test: `test/cards.spec.js`

**Model:** `sonnet` — coordinated edits across C++ and the page, with a stream-splitting change that silently breaks the page if botched.

**Interfaces:**
- Consumes: `startServer` from Task 1.
- Produces:
  - `cards_html.h` defines `static const char CARDS_HTML[] PROGMEM` and owns the closing `</body></html>`.
  - `index_html.h` script exposes a mutable binding `let renderCards = () => {};` that `CARDS_HTML` reassigns, plus `const TABS = ["devices", "log", "cards"];` and the existing `devices` Map, `showTab(name)`, `ageText(ms)`, `readings(obj)`, `META`.

- [ ] **Step 1: Write the failing test**

Append to `test/cards.spec.js`:

```js
test("the Cards tab shows an empty grid and switches views", async ({ page }) => {
  await open(page, [ACURITE]);
  await expect(page.locator("#view-cards")).toBeHidden();

  await page.click("#tab-cards");
  await expect(page.locator("#view-cards")).toBeVisible();
  await expect(page.locator("#view-devices")).toBeHidden();
  await expect(page.locator("#tab-cards")).toHaveAttribute("aria-selected", "true");

  await page.click("#tab-devices");
  await expect(page.locator("#view-cards")).toBeHidden();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx playwright test -g "Cards tab shows an empty grid"`
Expected: FAIL — `#tab-cards` never becomes visible (the element does not exist).

- [ ] **Step 3: Add the Cards nav button in `index_html.h`**

Replace the `<nav>` block (currently `index_html.h:34-37`):

```html
  <nav>
    <button id="tab-devices" aria-selected="true">Devices</button>
    <button id="tab-log" aria-selected="false">Log</button>
    <button id="tab-cards" aria-selected="false">Cards</button>
  </nav>
```

- [ ] **Step 4: Generalise tab switching in `index_html.h`**

Replace the tab block (currently `index_html.h:204-211`):

```js
const TABS = ["devices", "log", "cards"];
for (const n of TABS) document.getElementById("tab-" + n).onclick = () => showTab(n);
function showTab(name) {
  for (const n of TABS) {
    document.getElementById("tab-" + n).setAttribute("aria-selected", String(n === name));
    document.getElementById("view-" + n).hidden = n !== name;
  }
}
```

- [ ] **Step 5: Add the `renderCards` hook in `index_html.h`**

After `let refreshSeq = 0;` (currently `index_html.h:54`) add:

```js
// CARDS_HTML is streamed after this script and reassigns this.
let renderCards = () => {};
```

In `upsert()`, after `renderDevices();` add `renderCards();`.
In `refresh()`, after the final `renderLog();` add `renderCards();`.
Replace `setInterval(renderDevices, 1000);` with:

```js
setInterval(() => { renderDevices(); renderCards(); }, 1000);
```

- [ ] **Step 6: Drop the closing tags from `index_html.h`**

Delete the `</body>` and `</html>` lines (currently `index_html.h:217-218`) so the literal ends after `</script>`. The file's last lines become:

```
</script>
)rawliteral";
```

- [ ] **Step 7: Create `cards_html.h`**

```cpp
#pragma once

#include <Arduino.h>

static const char CARDS_HTML[] PROGMEM = R"rawliteral(
<section id="view-cards" hidden>
  <div id="cards"></div>
</section>
<style>
#cards { display:grid; grid-template-columns:repeat(auto-fill,minmax(170px,1fr));
         grid-auto-rows:150px; grid-auto-flow:dense; gap:1.4rem 1rem; padding:1.6rem 1rem 1rem; }
</style>
<script>
</script>
</body>
</html>
)rawliteral";
```

- [ ] **Step 8: Stream both arrays from `handleRoot()`**

In `web_ui.cpp`, add `#include "cards_html.h"` beside the `index_html.h` include, then replace `handleRoot()` (currently `web_ui.cpp:202-217`):

```cpp
static void streamProgmem(Print& out, const char* text) {
  size_t total = strlen_P(text);
  char   buf[256];
  for (size_t off = 0; off < total; off += sizeof(buf)) {
    size_t n = min(sizeof(buf), total - off);
    memcpy_P(buf, text + off, n);
    out.write(reinterpret_cast<const uint8_t*>(buf), n);
  }
}

static void handleRoot() {
  WiFiClient client = _server.client();
  _server.setContentLength(CONTENT_LENGTH_UNKNOWN);
  _server.sendHeader("Cache-Control", "no-store");
  _server.send(200, "text/html", "");

  ChunkedResponse out(_server, client);
  streamProgmem(out, INDEX_HTML);
  streamProgmem(out, CARDS_HTML);
  out.finish();
}
```

- [ ] **Step 9: Run the tests**

Run: `npx playwright test`
Expected: PASS, 2 tests.

- [ ] **Step 10: Verify the firmware still builds**

Run: `pio run -e esp32s3-generic 2>&1 | tail -20`
Expected: `SUCCESS`. Record the reported Flash percentage and byte count; Task 7 compares against it.

- [ ] **Step 11: Commit**

```bash
git add index_html.h cards_html.h web_ui.cpp test/cards.spec.js
git commit -m "Serve a Cards tab from a second PROGMEM array"
```

---

### Task 3: Layout state and persistence

**Files:**
- Modify: `cards_html.h` (script block)
- Test: `test/cards.spec.js`

**Model:** `sonnet` — the defaults-versus-storage precedence rules are subtle and every later task depends on them.

**Interfaces:**
- Consumes: `META`, `readings(obj)`, `devices` Map from `INDEX_HTML`.
- Produces, all in `CARDS_HTML`'s script scope:
  - `const CARDS_KEY = "rtl433.cards.v1";`
  - `let cardState` shaped `{ order: string[], hidden: string[], cards: { [key]: { name?: string, aspect: "sq"|"h"|"v", valueOrder: string[], hiddenValues: string[] } } }`
  - `loadCardState()` — reads localStorage into `cardState`, rebuilding defaults on any failure.
  - `saveCardState()` — writes `cardState`; on a throw sets `storageBroken = true` and keeps memory state.
  - `ensureCard(key, merged) -> entry` — creates the entry with defaults if absent, appends `key` to `cardState.order` if absent, appends any field of `merged` not already in `valueOrder` (status fields also into `hiddenValues`), and returns the entry. Never saves.
  - `visibleValues(key, merged) -> string[]` — `valueOrder` filtered to fields present in `merged` and not in `hiddenValues`.
  - `orderedKeys() -> string[]` — `cardState.order` filtered to keys present in `devices`.
  - `cardHidden(key) -> boolean`

- [ ] **Step 1: Write the failing tests**

Append to `test/cards.spec.js`:

```js
async function cardState(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem("rtl433.cards.v1") || "null"));
}

test("a new device gets defaults: appended, visible, status fields hidden", async ({ page }) => {
  await open(page, [ACURITE]);
  await page.click("#tab-cards");

  const state = await page.evaluate(() => {
    const merged = { temperature_F: 71.2, humidity: 38, battery_ok: 1, wind_avg_mi_h: 4.6 };
    ensureCard("Acurite-5n1/396", merged);
    saveCardState();
    return { s: cardState, vis: visibleValues("Acurite-5n1/396", merged) };
  });

  expect(state.s.order).toEqual(["Acurite-5n1/396"]);
  expect(state.s.cards["Acurite-5n1/396"].hiddenValues).toEqual(["battery_ok"]);
  expect(state.s.cards["Acurite-5n1/396"].valueOrder)
    .toEqual(["temperature_F", "humidity", "battery_ok", "wind_avg_mi_h"]);
  expect(state.vis).toEqual(["temperature_F", "humidity", "wind_avg_mi_h"]);
});

test("a field added later appends without disturbing stored order", async ({ page }) => {
  await open(page, [ACURITE]);
  await page.click("#tab-cards");
  const order = await page.evaluate(() => {
    cardState = { order: ["k"], hidden: [],
      cards: { k: { aspect: "sq", valueOrder: ["humidity", "temperature_F"], hiddenValues: [] } } };
    ensureCard("k", { temperature_F: 1, humidity: 2, rain_in: 3 });
    return cardState.cards.k.valueOrder;
  });
  expect(order).toEqual(["humidity", "temperature_F", "rain_in"]);
});

test("corrupt storage is discarded and defaults rebuild", async ({ page }) => {
  await open(page, [ACURITE]);
  await page.evaluate(() => localStorage.setItem("rtl433.cards.v1", "{not json"));
  await page.reload();
  await expect(page.locator("#status")).toHaveText("live");
  const s = await page.evaluate(() => cardState);
  expect(s).toEqual({ order: [], hidden: [], cards: {} });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx playwright test -g "defaults|appends without|corrupt storage"`
Expected: 3 FAIL — `ensureCard is not defined`.

- [ ] **Step 3: Implement the state layer**

In `cards_html.h`, replace the empty `<script>` block with:

```js
const CARDS_KEY = "rtl433.cards.v1";

// rtl_433 flags rather than readings: useful, but not what a card is for.
const STATUS_FIELDS = new Set(["battery_ok", "battery", "battery_low", "test", "tamper",
                               "status", "integrity", "alarm", "learn", "unknown"]);

let cardState = { order: [], hidden: [], cards: {} };
let storageBroken = false;

function blankState() { return { order: [], hidden: [], cards: {} }; }

function loadCardState() {
  cardState = blankState();
  let raw;
  try { raw = localStorage.getItem(CARDS_KEY); } catch (e) { storageBroken = true; return; }
  if (!raw) return;
  let s;
  try { s = JSON.parse(raw); } catch (e) { return; }
  if (!s || typeof s !== "object") return;
  cardState = {
    order: Array.isArray(s.order) ? s.order.filter(k => typeof k === "string") : [],
    hidden: Array.isArray(s.hidden) ? s.hidden.filter(k => typeof k === "string") : [],
    cards: {},
  };
  const cards = s.cards && typeof s.cards === "object" ? s.cards : {};
  for (const k of Object.keys(cards)) {
    const c = cards[k];
    if (!c || typeof c !== "object") continue;
    cardState.cards[k] = {
      name: typeof c.name === "string" ? c.name : undefined,
      aspect: c.aspect === "h" || c.aspect === "v" ? c.aspect : "sq",
      valueOrder: Array.isArray(c.valueOrder) ? c.valueOrder.filter(f => typeof f === "string") : [],
      hiddenValues: Array.isArray(c.hiddenValues) ? c.hiddenValues.filter(f => typeof f === "string") : [],
    };
  }
}

function saveCardState() {
  if (storageBroken) return;
  try { localStorage.setItem(CARDS_KEY, JSON.stringify(cardState)); }
  catch (e) { storageBroken = true; }
}

function ensureCard(key, merged) {
  let c = cardState.cards[key];
  const fields = Object.keys(merged || {});
  if (!c) {
    const visible = fields.filter(f => !STATUS_FIELDS.has(f));
    c = {
      aspect: visible.length > 3 ? "h" : "sq",
      valueOrder: fields.slice(),
      hiddenValues: fields.filter(f => STATUS_FIELDS.has(f)),
    };
    cardState.cards[key] = c;
  } else {
    for (const f of fields) {
      if (c.valueOrder.indexOf(f) >= 0) continue;
      c.valueOrder.push(f);
      if (STATUS_FIELDS.has(f)) c.hiddenValues.push(f);
    }
  }
  if (cardState.order.indexOf(key) < 0) cardState.order.push(key);
  return c;
}

function visibleValues(key, merged) {
  const c = cardState.cards[key];
  if (!c) return [];
  return c.valueOrder.filter(f => merged[f] !== undefined && c.hiddenValues.indexOf(f) < 0);
}

function cardHidden(key) { return cardState.hidden.indexOf(key) >= 0; }

function orderedKeys() { return cardState.order.filter(k => devices.has(k)); }

loadCardState();
```

- [ ] **Step 4: Run the tests**

Run: `npx playwright test`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add cards_html.h test/cards.spec.js
git commit -m "Store card layout in localStorage with per-device defaults"
```

---

### Task 4: Render the cards

**Files:**
- Modify: `cards_html.h` (CSS and script blocks)
- Test: `test/cards.spec.js`

**Model:** `sonnet` — layout maths plus DOM construction from a prose spec.

**Interfaces:**
- Consumes: Task 3's state layer; `devices`, `ageText`, `readings` from `INDEX_HTML`.
- Produces:
  - `renderCards()` reassigned over the `INDEX_HTML` no-op. Renders `#cards`.
  - `cardCells(key, visibleCount) -> 1|2|4`
  - `valueFont(cells, visibleCount) -> string` (a `rem` value)
  - `splitUnit(field) -> { name: string, unit: string }`
  - DOM contract used by every later task: each card is `div.card[data-key]` carrying an aspect class `sq`/`h`/`v` (plus `wide` when it spans 2×2); inside it `div.lbl` (with `span.nm` and `span.rs`), `div.body` containing `div.val[data-f]` blocks (each with `div.fn` and `div.fv`), and `div.age`.

- [ ] **Step 1: Write the failing tests**

Append to `test/cards.spec.js`:

```js
test("a card renders label, visible values, rssi and age", async ({ page }) => {
  await open(page, [ACURITE]);
  await page.click("#tab-cards");

  const card = page.locator('.card[data-key="Acurite-5n1/396"]');
  await expect(card).toHaveCount(1);
  await expect(card.locator(".nm")).toHaveText("Acurite-5n1/396");
  await expect(card.locator(".rs")).toHaveText("-72");
  await expect(card.locator(".val")).toHaveCount(3);
  await expect(card.locator('.val[data-f="battery_ok"]')).toHaveCount(0);
  await expect(card.locator('.val[data-f="temperature_F"] .fv')).toContainText("71.2");
  await expect(card.locator(".age")).not.toBeEmpty();
});

test("value font follows cells over visible count", async ({ page }) => {
  await open(page, [ACURITE]);
  await page.click("#tab-cards");
  const sizes = await page.evaluate(() => ({
    one: valueFont(1, 1), three: valueFont(1, 3), big: valueFont(4, 8), floor: valueFont(1, 40),
  }));
  expect(sizes.one).toBe("2.4rem");
  expect(sizes.three).toBe("1.386rem");
  expect(sizes.big).toBe("1.697rem");
  expect(sizes.floor).toBe("0.9rem");
});

test("a card with more than six visible values spans 2x2", async ({ page }) => {
  await open(page, [ACURITE]);
  await page.click("#tab-cards");
  const cells = await page.evaluate(() => {
    cardState.cards["k"] = { aspect: "sq", valueOrder: [], hiddenValues: [] };
    return [cardCells("k", 3), cardCells("k", 7)];
  });
  expect(cells).toEqual([1, 4]);
});

test("a live update flashes the card", async ({ page }) => {
  await open(page, [ACURITE]);
  await page.click("#tab-cards");
  server.emit(ACURITE);
  await expect(page.locator('.card[data-key="Acurite-5n1/396"]')).toHaveClass(/flash/);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx playwright test -g "card renders label|value font|spans 2x2|flashes the card"`
Expected: 4 FAIL — no `.card` elements, `valueFont is not defined`.

- [ ] **Step 3: Add the card CSS**

In `cards_html.h`, replace the `<style>` block with:

```css
#cards { display:grid; grid-template-columns:repeat(auto-fill,minmax(170px,1fr));
         grid-auto-rows:150px; grid-auto-flow:dense; gap:1.4rem 1rem; padding:1.6rem 1rem 1rem; }
.card { position:relative; border:1px solid var(--line); border-radius:.7rem;
        padding:.7rem .6rem .9rem; overflow:hidden; }
.card.h { grid-column:span 2; }
.card.v { grid-row:span 2; }
.card.wide { grid-column:span 2; grid-row:span 2; }
.card.flash { animation:flash 1s ease-out; }
.card .lbl { position:absolute; top:-.65em; right:.7rem; padding:0 .4rem;
             background:Canvas; font-size:.75rem; white-space:nowrap; }
.card .lbl .rs { opacity:.6; margin-left:.35rem; font-variant-numeric:tabular-nums; }
.card .age { position:absolute; right:.5rem; bottom:.25rem; font-size:.65rem; opacity:.5;
             font-variant-numeric:tabular-nums; }
.card .body { display:flex; flex-wrap:wrap; align-content:flex-start; gap:.2rem .9rem;
              height:100%; overflow:hidden; }
.card .val { line-height:1.05; }
.card .fn { font-size:.6rem; text-transform:uppercase; letter-spacing:.05em; opacity:.6; }
.card .fv { font-variant-numeric:tabular-nums; white-space:nowrap; }
.card .fv .u { font-size:.5em; opacity:.65; margin-left:.12em; }
@media (max-width:520px) {
  #cards { grid-template-columns:repeat(auto-fill,minmax(140px,1fr)); }
}
@media (max-width:400px) {
  #cards { grid-template-columns:1fr; }
  .card.h, .card.wide { grid-column:span 1; }
}
```

- [ ] **Step 4: Implement rendering**

Append to the `cards_html.h` script, after `loadCardState();`:

```js
// rtl_433 puts the unit in the field name, so the name and the unit come apart
// here rather than from a table of every sensor.
const UNITS = [["_mi_h", "mi/h"], ["_km_h", "km/h"], ["_m_s", "m/s"], ["_hPa", "hPa"],
               ["_kPa", "kPa"], ["_in", "in"], ["_mm", "mm"], ["_F", "\u00b0F"],
               ["_C", "\u00b0C"], ["_V", "V"], ["_deg", "\u00b0"], ["_ppm", "ppm"]];

function splitUnit(field) {
  for (const [suffix, unit] of UNITS) {
    if (field.length > suffix.length && field.endsWith(suffix)) {
      return { name: field.slice(0, -suffix.length).replace(/_/g, " "), unit: unit };
    }
  }
  if (field === "humidity") return { name: "humidity", unit: "%" };
  return { name: field.replace(/_/g, " "), unit: "" };
}

function cardCells(key, visibleCount) {
  const aspect = (cardState.cards[key] || {}).aspect || "sq";
  if (aspect === "sq") return visibleCount > 6 ? 4 : 1;
  return 2;
}

function valueFont(cells, visibleCount) {
  const raw = 2.4 * Math.sqrt(cells / Math.max(1, visibleCount));
  return Math.min(2.6, Math.max(0.9, Math.round(raw * 1000) / 1000)) + "rem";
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function cardLabel(key) {
  const c = cardState.cards[key];
  return c && c.name ? c.name : key;
}

function buildCard(rec) {
  const key = rec.key;
  const c = ensureCard(key, rec.merged);
  const vis = visibleValues(key, rec.merged);
  const cells = cardCells(key, vis.length);

  const card = el("div", "card " + c.aspect);
  if (c.aspect === "sq" && cells === 4) card.className = "card sq wide";
  card.dataset.key = key;
  if (rec.flashUntil > Date.now()) card.classList.add("flash");

  const lbl = el("div", "lbl");
  lbl.append(el("span", "nm", cardLabel(key)), el("span", "rs", rec.rssi === undefined ? "" : String(rec.rssi)));

  const body = el("div", "body");
  const font = valueFont(cells, vis.length);
  for (const f of vis) {
    const v = el("div", "val");
    v.dataset.f = f;
    const parts = splitUnit(f);
    v.append(el("div", "fn", parts.name));
    const fv = el("div", "fv", String(rec.merged[f]));
    fv.style.fontSize = font;
    if (parts.unit) fv.append(el("span", "u", parts.unit));
    v.append(fv);
    body.append(v);
  }

  card.append(lbl, body, el("div", "age", ageText(Date.now() - rec.seenAt)));
  return card;
}

renderCards = function () {
  const grid = document.getElementById("cards");
  if (!grid) return;
  const cards = [];
  for (const key of orderedKeys()) {
    if (cardHidden(key)) continue;
    cards.push(buildCard(devices.get(key)));
  }
  grid.replaceChildren(...cards);
};

renderCards();
```

`orderedKeys()` only returns keys already in `cardState.order`, and `ensureCard` is what puts them there, so `renderCards` must seed unseen devices first. Add this loop at the top of `renderCards`, before building:

```js
  for (const rec of devices.values()) ensureCard(rec.key, rec.merged);
```

Defaults created this way are not persisted until an edit writes them, which is what the spec's "defaults apply only when a device or field has no stored entry" requires.

- [ ] **Step 5: Run the tests**

Run: `npx playwright test`
Expected: PASS, 9 tests.

- [ ] **Step 6: Commit**

```bash
git add cards_html.h test/cards.spec.js
git commit -m "Render each device as a card"
```

---

### Task 5: Edit mode — visibility, hide, aspect, rename

**Files:**
- Modify: `cards_html.h` (markup, CSS, script)
- Test: `test/cards.spec.js`

**Model:** `sonnet` — event wiring and state mutation across several controls.

**Interfaces:**
- Consumes: Task 4's DOM contract and `renderCards()`.
- Produces:
  - `let editing = false;` and `#edit-cards` toggle button in `#view-cards`.
  - `toggleValue(key, field)`, `toggleCardHidden(key)`, `cycleAspect(key)`, `renameCard(key, name)` — each mutates `cardState`, calls `saveCardState()`, then `renderCards()`.
  - In edit mode each card also carries `button.cx` (hide), `button.ca` (aspect); hidden values render as `div.val.ghost`, hidden cards as `div.card.ghost` at the end of the grid.

- [ ] **Step 1: Write the failing tests**

Append to `test/cards.spec.js`:

```js
const CARD = '.card[data-key="Acurite-5n1/396"]';

async function edit(page) {
  await page.click("#tab-cards");
  await page.click("#edit-cards");
  await expect(page.locator("#view-cards")).toHaveClass(/editing/);
}

test("edit mode toggles a value's visibility and persists it", async ({ page }) => {
  await open(page, [ACURITE]);
  await edit(page);

  await page.click(CARD + ' .val[data-f="humidity"]');
  await expect(page.locator(CARD + ' .val[data-f="humidity"]')).toHaveClass(/ghost/);
  expect((await cardState(page)).cards["Acurite-5n1/396"].hiddenValues).toContain("humidity");

  await page.click("#edit-cards");
  await expect(page.locator(CARD + ' .val[data-f="humidity"]')).toHaveCount(0);

  await page.reload();
  await page.click("#tab-cards");
  await expect(page.locator(CARD + ' .val[data-f="humidity"]')).toHaveCount(0);
});

test("hiding a value grows the rest", async ({ page }) => {
  await open(page, [ACURITE]);
  await page.click("#tab-cards");
  const before = await page.locator(CARD + ' .val[data-f="temperature_F"] .fv').evaluate(n => n.style.fontSize);
  await page.click("#edit-cards");
  await page.click(CARD + ' .val[data-f="humidity"]');
  await page.click("#edit-cards");
  const after = await page.locator(CARD + ' .val[data-f="temperature_F"] .fv').evaluate(n => n.style.fontSize);
  expect(parseFloat(after)).toBeGreaterThan(parseFloat(before));
});

test("the aspect button cycles square, horizontal, vertical", async ({ page }) => {
  await open(page, [ACURITE]);
  await edit(page);
  await page.evaluate(() => { cardState.cards["Acurite-5n1/396"].aspect = "sq"; renderCards(); });

  await page.click(CARD + " .ca");
  await expect(page.locator(CARD)).toHaveClass(/\bh\b/);
  await page.click(CARD + " .ca");
  await expect(page.locator(CARD)).toHaveClass(/\bv\b/);
  await page.click(CARD + " .ca");
  await expect(page.locator(CARD)).toHaveClass(/\bsq\b/);
  expect((await cardState(page)).cards["Acurite-5n1/396"].aspect).toBe("sq");
});

test("hiding a card ghosts it in edit mode and drops it in normal mode", async ({ page }) => {
  await open(page, [ACURITE, OREGON]);
  await edit(page);
  await page.click(CARD + " .cx");
  await expect(page.locator(CARD)).toHaveClass(/ghost/);
  await expect(page.locator("#cards .card").last()).toHaveAttribute("data-key", "Acurite-5n1/396");

  await page.click("#edit-cards");
  await expect(page.locator(CARD)).toHaveCount(0);
  expect((await cardState(page)).hidden).toEqual(["Acurite-5n1/396"]);

  await page.click("#edit-cards");
  await page.click(CARD + " .cx");
  await expect(page.locator(CARD)).not.toHaveClass(/ghost/);
  expect((await cardState(page)).hidden).toEqual([]);
});

test("renaming the label sticks, and an empty name reverts to the key", async ({ page }) => {
  await open(page, [ACURITE]);
  await edit(page);
  await page.dblclick(CARD + " .nm");
  await page.fill(CARD + " .lbl input", "Roof station");
  await page.press(CARD + " .lbl input", "Enter");
  await expect(page.locator(CARD + " .nm")).toHaveText("Roof station");
  expect((await cardState(page)).cards["Acurite-5n1/396"].name).toBe("Roof station");

  await page.dblclick(CARD + " .nm");
  await page.fill(CARD + " .lbl input", "");
  await page.press(CARD + " .lbl input", "Enter");
  await expect(page.locator(CARD + " .nm")).toHaveText("Acurite-5n1/396");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx playwright test -g "edit mode|grows the rest|aspect button|Hiding a card|renaming"`
Expected: 5 FAIL — `#edit-cards` does not exist.

- [ ] **Step 3: Add the edit toggle to the markup**

Replace the `<section id="view-cards">` block in `cards_html.h`:

```html
<section id="view-cards" hidden>
  <button id="edit-cards" title="Edit layout">&#9998;</button>
  <div id="cards"></div>
</section>
```

- [ ] **Step 4: Add edit-mode CSS**

Append to the `cards_html.h` `<style>` block:

```css
#edit-cards { position:fixed; right:1rem; bottom:1rem; z-index:2; font:inherit;
              width:2.4rem; height:2.4rem; border-radius:50%; cursor:pointer;
              border:1px solid var(--line); background:Canvas; color:inherit; }
#view-cards.editing #edit-cards { background:#8883; }
#view-cards.editing .card { cursor:grab; touch-action:none; }
#view-cards.editing .val { cursor:pointer; }
.card.ghost, .val.ghost { opacity:.35; }
.card .cx, .card .ca { position:absolute; top:.25rem; font:inherit; font-size:.7rem;
                       line-height:1; padding:.15rem .3rem; background:Canvas; color:inherit;
                       border:1px solid var(--line); border-radius:.3rem; cursor:pointer;
                       display:none; }
.card .cx { left:.3rem; }
.card .ca { left:2rem; }
#view-cards.editing .card .cx, #view-cards.editing .card .ca { display:block; }
.card .lbl input { font:inherit; font-size:.75rem; width:9rem; background:Canvas; color:inherit;
                   border:1px solid var(--line); }
```

- [ ] **Step 5: Implement edit mode**

Append to the `cards_html.h` script (before the final `renderCards();` call, which stays last):

```js
let editing = false;

const ASPECTS = ["sq", "h", "v"];

function toggleValue(key, field) {
  const c = cardState.cards[key];
  if (!c) return;
  const i = c.hiddenValues.indexOf(field);
  if (i < 0) c.hiddenValues.push(field); else c.hiddenValues.splice(i, 1);
  saveCardState();
  renderCards();
}

function toggleCardHidden(key) {
  const i = cardState.hidden.indexOf(key);
  if (i < 0) cardState.hidden.push(key); else cardState.hidden.splice(i, 1);
  saveCardState();
  renderCards();
}

function cycleAspect(key) {
  const c = cardState.cards[key];
  if (!c) return;
  c.aspect = ASPECTS[(ASPECTS.indexOf(c.aspect) + 1) % ASPECTS.length];
  saveCardState();
  renderCards();
}

function renameCard(key, name) {
  const c = cardState.cards[key];
  if (!c) return;
  const trimmed = name.trim();
  if (trimmed) c.name = trimmed; else delete c.name;
  saveCardState();
  renderCards();
}

function startRename(key, lbl) {
  const input = document.createElement("input");
  input.value = cardState.cards[key] && cardState.cards[key].name ? cardState.cards[key].name : "";
  lbl.replaceChildren(input);
  input.focus();
  input.select();
  let done = false;
  const finish = commit => {
    if (done) return;
    done = true;
    if (commit) renameCard(key, input.value); else renderCards();
  };
  input.onkeydown = ev => {
    if (ev.key === "Enter") finish(true);
    else if (ev.key === "Escape") finish(false);
  };
  input.onblur = () => finish(true);
}

document.getElementById("edit-cards").onclick = () => {
  editing = !editing;
  document.getElementById("view-cards").classList.toggle("editing", editing);
  renderCards();
};
```

- [ ] **Step 6: Render the edit affordances**

In `buildCard`, the hidden-value blocks must appear in edit mode. Replace the value loop's source list and add the ghost class:

```js
  const shown = editing ? c.valueOrder.filter(f => rec.merged[f] !== undefined) : vis;
  const font = valueFont(cells, vis.length);
  for (const f of shown) {
    const v = el("div", "val");
    if (c.hiddenValues.indexOf(f) >= 0) v.classList.add("ghost");
    ...
```

The rest of the loop body is unchanged. Note the font still uses `vis.length`, so ghosting a value in edit mode does not resize the card's type.

Before `card.append(lbl, body, ...)`, add the buttons and the rename handler:

```js
  if (cardHidden(key)) card.classList.add("ghost");

  const cx = el("button", "cx", "\u2715");
  cx.onclick = ev => { ev.stopPropagation(); toggleCardHidden(key); };
  const ca = el("button", "ca", "\u25ad");
  ca.onclick = ev => { ev.stopPropagation(); cycleAspect(key); };
  card.append(cx, ca);

  lbl.ondblclick = ev => { if (editing) { ev.stopPropagation(); startRename(key, lbl); } };
  let pressTimer = 0;
  lbl.onpointerdown = () => {
    if (!editing) return;
    pressTimer = setTimeout(() => startRename(key, lbl), 600);
  };
  lbl.onpointerup = lbl.onpointerleave = () => clearTimeout(pressTimer);
```

And wire the value click:

```js
    v.onclick = () => { if (editing) toggleValue(key, f); };
```

- [ ] **Step 7: Put hidden cards at the end in edit mode**

Replace the body of `renderCards`'s build loop:

```js
renderCards = function () {
  const grid = document.getElementById("cards");
  if (!grid) return;
  for (const rec of devices.values()) ensureCard(rec.key, rec.merged);
  const keys = orderedKeys();
  const shown = keys.filter(k => !cardHidden(k));
  if (editing) shown.push(...keys.filter(cardHidden));
  grid.replaceChildren(...shown.map(k => buildCard(devices.get(k))));
};
```

- [ ] **Step 8: Run the tests**

Run: `npx playwright test`
Expected: PASS, 14 tests.

- [ ] **Step 9: Commit**

```bash
git add cards_html.h test/cards.spec.js
git commit -m "Add card edit mode: visibility, hide, aspect, rename"
```

---

### Task 6: Drag to reorder cards and values

**Files:**
- Modify: `cards_html.h` (script)
- Test: `test/cards.spec.js`

**Model:** `opus` — hand-rolled pointer dragging with two modes, a suppressed render, and a click/drag threshold; subtle to get right and easy to get subtly wrong.

**Interfaces:**
- Consumes: Task 5's edit mode, the `div.card[data-key]` / `div.val[data-f]` DOM contract.
- Produces:
  - `let dragging = null;` — non-null suppresses `renderCards()`.
  - `moveCard(key, beforeKey|null)` — reorders `cardState.order`; `null` means append.
  - `moveValue(key, field, beforeField|null)` — reorders that card's `valueOrder` only.
  - `CLICK_SLOP = 6` — pointer travel in px under which a drag counts as a click.

- [ ] **Step 1: Write the failing tests**

Append to `test/cards.spec.js`:

```js
async function dragTo(page, from, to) {
  const a = await page.locator(from).boundingBox();
  const b = await page.locator(to).boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
  await page.mouse.up();
}

test("dragging a card reorders the grid and persists", async ({ page }) => {
  await open(page, [ACURITE, OREGON, THERMO]);
  await edit(page);
  const keys = () => page.locator("#cards .card").evaluateAll(n => n.map(c => c.dataset.key));
  expect(await keys()).toEqual(["Acurite-5n1/396", "Oregon-THN132N/23", "Fineoffset-WH2/174"]);

  await dragTo(page, CARD + " .lbl", '.card[data-key="Fineoffset-WH2/174"]');
  expect(await keys()).toEqual(["Oregon-THN132N/23", "Fineoffset-WH2/174", "Acurite-5n1/396"]);

  await page.reload();
  await page.click("#tab-cards");
  expect(await keys()).toEqual(["Oregon-THN132N/23", "Fineoffset-WH2/174", "Acurite-5n1/396"]);
});

test("dragging a value reorders within its card only", async ({ page }) => {
  await open(page, [ACURITE, OREGON]);
  await edit(page);
  const fields = () => page.locator(CARD + " .val").evaluateAll(n => n.map(v => v.dataset.f));
  const before = await fields();

  await dragTo(page, CARD + ' .val[data-f="temperature_F"]', CARD + ' .val[data-f="wind_avg_mi_h"]');
  const after = await fields();
  expect(after).not.toEqual(before);
  expect(after.slice().sort()).toEqual(before.slice().sort());

  const other = await page.locator('.card[data-key="Oregon-THN132N/23"] .val').count();
  expect(other).toBeGreaterThan(0);
  expect((await cardState(page)).cards["Oregon-THN132N/23"]).toBeUndefined();
});

test("cards are inert outside edit mode", async ({ page }) => {
  await open(page, [ACURITE, OREGON]);
  await page.click("#tab-cards");
  await dragTo(page, CARD + " .lbl", '.card[data-key="Oregon-THN132N/23"]');
  const keys = await page.locator("#cards .card").evaluateAll(n => n.map(c => c.dataset.key));
  expect(keys).toEqual(["Acurite-5n1/396", "Oregon-THN132N/23"]);
});

test("a live signal does not re-render mid-drag", async ({ page }) => {
  await open(page, [ACURITE, OREGON]);
  await edit(page);
  const box = await page.locator(CARD + " .lbl").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 80, box.y + 40, { steps: 5 });
  await expect(page.locator(".ghostcard")).toHaveCount(1);
  server.emit(OREGON);
  await page.waitForTimeout(200);
  await expect(page.locator(".ghostcard")).toHaveCount(1);
  await page.mouse.up();
  await expect(page.locator(".ghostcard")).toHaveCount(0);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx playwright test -g "dragging a card|dragging a value|inert outside|mid-drag"`
Expected: 4 FAIL — order unchanged, no `.ghostcard`.

- [ ] **Step 3: Add drag CSS**

Append to the `cards_html.h` `<style>` block:

```css
.ghostcard { position:fixed; z-index:5; pointer-events:none; opacity:.75;
             border:1px solid var(--line); border-radius:.7rem; background:Canvas;
             padding:.3rem .6rem; font-size:.8rem; }
.card.lifting { opacity:.35; }
```

- [ ] **Step 4: Implement dragging**

Append to the `cards_html.h` script, before the final `renderCards();`:

```js
const CLICK_SLOP = 6;
let dragging = null;

function moveCard(key, beforeKey) {
  const order = cardState.order;
  const from = order.indexOf(key);
  if (from < 0) return;
  order.splice(from, 1);
  const to = beforeKey === null ? order.length : order.indexOf(beforeKey);
  order.splice(to < 0 ? order.length : to, 0, key);
  saveCardState();
}

function moveValue(key, field, beforeField) {
  const c = cardState.cards[key];
  if (!c) return;
  const order = c.valueOrder;
  const from = order.indexOf(field);
  if (from < 0) return;
  order.splice(from, 1);
  const to = beforeField === null ? order.length : order.indexOf(beforeField);
  order.splice(to < 0 ? order.length : to, 0, field);
  saveCardState();
}

// The drop slot is the first sibling whose midpoint is past the pointer, which
// is what makes a drag onto the right half of a card land after it.
function dropBefore(nodes, x, y) {
  for (const n of nodes) {
    const r = n.getBoundingClientRect();
    if (y < r.top + r.height / 2 || (y < r.bottom && x < r.left + r.width / 2)) return n;
  }
  return null;
}

function beginDrag(ev, card, val) {
  const key = card.dataset.key;
  dragging = {
    key: key, field: val ? val.dataset.f : null,
    x0: ev.clientX, y0: ev.clientY, moved: false, node: val || card,
    ghost: null, pointerId: ev.pointerId,
  };
  card.setPointerCapture(ev.pointerId);
}

function dragMove(ev, card) {
  const d = dragging;
  if (!d) return;
  if (!d.moved) {
    if (Math.hypot(ev.clientX - d.x0, ev.clientY - d.y0) < CLICK_SLOP) return;
    d.moved = true;
    d.ghost = el("div", "ghostcard", d.field ? splitUnit(d.field).name : cardLabel(d.key));
    document.body.append(d.ghost);
    d.node.classList.add("lifting");
  }
  d.ghost.style.left = ev.clientX + 12 + "px";
  d.ghost.style.top = ev.clientY + 12 + "px";
}

function endDrag(ev, card) {
  const d = dragging;
  dragging = null;
  if (!d) return;
  if (d.ghost) d.ghost.remove();
  d.node.classList.remove("lifting");
  if (!d.moved) { renderCards(); return; }
  if (d.field) {
    const vals = [...card.querySelectorAll(".val")].filter(v => v.dataset.f !== d.field);
    const before = dropBefore(vals, ev.clientX, ev.clientY);
    moveValue(d.key, d.field, before ? before.dataset.f : null);
  } else {
    const cards = [...document.querySelectorAll("#cards .card")].filter(c => c.dataset.key !== d.key);
    const before = dropBefore(cards, ev.clientX, ev.clientY);
    moveCard(d.key, before ? before.dataset.key : null);
  }
  renderCards();
}
```

- [ ] **Step 5: Wire the handlers into `buildCard`**

Add before `return card;` in `buildCard`:

```js
  card.onpointerdown = ev => {
    if (!editing || ev.button !== 0) return;
    if (ev.target.closest("button") || ev.target.closest("input")) return;
    beginDrag(ev, card, ev.target.closest(".val"));
  };
  card.onpointermove = ev => dragMove(ev, card);
  card.onpointerup = card.onpointercancel = ev => endDrag(ev, card);
```

The value's own `onclick` from Task 5 still fires after a stationary pointerup, which is what makes a sub-slop drag a toggle. Guard it against a real drag by changing the Task 5 handler to:

```js
    v.onclick = () => { if (editing && !dragMoved) toggleValue(key, f); };
```

and record the flag in `endDrag` before it clears state:

```js
let dragMoved = false;
```

Set `dragMoved = d.moved;` as the first line after `if (!d) return;` in `endDrag`, and reset it to `false` at the start of `beginDrag`.

- [ ] **Step 6: Suppress rendering mid-drag**

Add as the first line of `renderCards`'s body, after the `grid` lookup:

```js
  if (dragging) return;
```

`endDrag` calls `renderCards()` after clearing `dragging`, so the drop still repaints.

- [ ] **Step 7: Run the tests**

Run: `npx playwright test`
Expected: PASS, 18 tests.

- [ ] **Step 8: Commit**

```bash
git add cards_html.h test/cards.spec.js
git commit -m "Drag cards and values to reorder in edit mode"
```

---

### Task 7: Flash budget, hardware check, and docs

**Files:**
- Modify: `README.md`, `docs/backlog.md`
- Verify: `platformio.ini` (`FAKE_SIGNALS`)

**Model:** `sonnet` — prose under a house style plus a build measurement.

**Interfaces:**
- Consumes: everything above.
- Produces: no code.

- [ ] **Step 1: Measure the flash delta**

```bash
git stash list >/dev/null
pio run -e esp32s3-generic 2>&1 | grep -E "Flash|RAM"
git stash push -- cards_html.h index_html.h web_ui.cpp 2>/dev/null && \
  pio run -e esp32s3-generic 2>&1 | grep -E "Flash|RAM"; \
  git stash pop
```

Expected: the two Flash byte counts differ by under 15 KB. If the delta is larger, note the actual figure in the commit message rather than silently accepting it.

- [ ] **Step 2: Run the whole suite once more**

Run: `npx playwright test`
Expected: PASS, 18 tests.

- [ ] **Step 3: Verify against a real board or FAKE_SIGNALS**

Uncomment `'-DFAKE_SIGNALS=true'` in `platformio.ini`, then:

```bash
pio run -e esp32s3-generic -t upload
```

Open the device page, switch to Cards, and confirm a card appears and ticks. Re-comment the flag afterwards and leave `platformio.ini` unchanged in git. If no board is attached, record in the commit message that this step was skipped.

- [ ] **Step 4: Update `README.md`**

In the "Pages and endpoints" table, change the `/` row to:

```
| `/` | the live page: a device table, a raw log, and a card dashboard, behind tabs |
```

Add a section after "Pages and endpoints":

```markdown
## Cards

The Cards tab shows each tracked device as a card. The pencil button opens edit
mode, where cards drag to reorder, values drag to reorder within their card,
clicking a value hides it, ✕ hides the card, the ▭ button cycles square,
horizontal, and vertical, and double-clicking the label renames it. Values grow
as fewer of them share a card and as the card grows.

Layout is per browser, in localStorage under `rtl433.cards.v1`. It is never
sent to the device, so two browsers can arrange the same receiver differently.
Clearing site data restores the defaults: every device visible, readings shown,
status flags such as `battery_ok` hidden.
```

In "Testing without a radio", add:

```markdown
The browser page has its own tests. `npm install` once, then `npx playwright
test`. `test/harness.js` extracts the same PROGMEM literals the firmware serves
and serves them with a mock `/api/state` and `/events`, so the tests run
without a board.
```

- [ ] **Step 5: Update `docs/backlog.md`**

Under "Smaller items", replace the last bullet's closing sentence about there being no test framework with the current state:

```markdown
- `signal_store` has a `FAKE_SIGNALS` self-test that also compiles and runs on
  the host against real ArduinoJson, which is how its 17 checks are verified.
  The page has Playwright tests under `test/`. The firmware itself is still
  compile plus hardware; a PlatformIO `native` environment would make the
  store's tests a normal `pio test`.
```

Add a new "Smaller items" bullet:

```markdown
- The card view's font-size base of 2.4rem was tuned against a handful of
  synthetic devices. A card with long field names and four or more values can
  still clip, because the body hides overflow rather than shrinking to fit.
```

- [ ] **Step 6: Commit**

```bash
git add README.md docs/backlog.md
git commit -m "Document the Cards tab and the page tests"
```

- [ ] **Step 7: Delete the working documents**

```bash
git rm docs/superpowers/specs/2026-08-13-card-dashboard-design.md \
       docs/superpowers/plans/2026-08-13-card-dashboard.md
git commit -m "Remove the card dashboard spec and plan"
```

---

## Self-Review

**Spec coverage:** Placement and serving → Task 2. Data flow (second renderer, suppressed render, flash) → Tasks 2, 4, 6. Card anatomy and font sizing → Task 4. Grid and aspect, narrow screens → Tasks 4, 5. Edit mode (both drags, toggle, aspect, hide, rename) → Tasks 5, 6. Defaults on first detection → Task 3. Persistence including corrupt JSON and a throwing localStorage → Task 3. Testing including FAKE_SIGNALS and the flash delta → Tasks 1, 7. Docs → Task 7.

**Not covered by a test, deliberately:** the `storageBroken` in-memory fallback (private browsing cannot be simulated without a browser flag), and the narrow-screen media queries (CSS-only, verified by eye in Task 7 step 3).
