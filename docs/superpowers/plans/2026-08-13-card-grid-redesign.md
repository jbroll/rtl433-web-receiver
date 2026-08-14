# Card Grid Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Cards tab's auto-fill grid and square/horizontal/vertical aspect model with a user-sized grid of square cells, cards that span whole cells, and a type size derived from the measured cell.

**Architecture:** `#cards` becomes an explicit `repeat(cols, var(--cell))` × `repeat(rows, var(--cell))` grid. A single `measureGrid()` computes the square cell side as `min(width/cols, height/rows)` and writes `--cell`, so the grid letterboxes into the viewport. Each card stores `w`/`h` in cells instead of an aspect; the value grid inside it is `w` columns by `max(h, ceil(V/w))` rows, and the font size follows from the measured cell. A corner handle resizes a card by whole cells using the same hand-rolled pointer events as the existing card and value drags.

**Tech Stack:** Vanilla JS and CSS inside a PROGMEM string literal (`cards_html.h`), Playwright tests under `test/`, PlatformIO for the flash measurement.

## Global Constraints

- Everything lives in `cards_html.h` inside the `R"rawliteral(...)rawliteral"` block. No build step, no bundler, no external libraries.
- The storage key stays `rtl433.cards.v1`. Stored entries are never pruned automatically; only Forget layouts clears them.
- Writes to localStorage happen on each completed edit action and never during a drag or a resize.
- Corrupt JSON is discarded and defaults rebuild. A throwing `localStorage` sets `storageBroken` and leaves state in memory for the session.
- `cardState.cards` keeps its null prototype (`Object.create(null)`), so a stored `__proto__` key cannot become a prototype link.
- Columns and rows are clamped to 1–24 inclusive, integers only. Grid defaults to 6 × 4.
- Font size formula: `0.42 × (h × cell ÷ valueRows)` px, rounded to a whole pixel, clamped to 11–64px.
- Default card size for `V` visible values: `w = ceil(sqrt(V))`, `h = ceil(V / w)`, with `V` floored at 1.
- Tests run with `npx playwright test`. `fullyParallel: false`, one worker.
- Comments follow the repo's style: why, not what; one or two lines; none where the code already says it.

---

### Task 1: The grid, the state model, and card rendering

**Files:**
- Modify: `cards_html.h` (CSS block `:11-67`, JS `:69-283`)
- Test: `test/cards.spec.js`

**Model:** `opus` — the core swap; storage migration, layout measurement, and rendering all change together and the existing suite has to be re-aimed at the new model.

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces, all global in the page scope:
  - `GRID_MIN = 1`, `GRID_MAX = 24` (numbers)
  - `cellSide` (number, px; the measured square cell side)
  - `blankState()` → `{ grid: {cols, rows}, order: [], hidden: [], cards: <null-proto object> }`
  - `gridNum(v, fallback)` → integer in 1–24, else `fallback`
  - `defaultSize(count)` → `{ w, h }`
  - `migrateSize(c)` → `{ w, h }` or `{}` when the entry carries neither a size nor an aspect
  - `measureGrid()` → void; sets `cellSide`, `--cell`, and the grid templates
  - `valueFont(h, cell, rows)` → string such as `"32px"`
  - `ensureCard(key, merged)` → card entry with `w` and `h` filled in
  - A card entry is `{ name?, w, h, valueOrder, hiddenValues }`. The `aspect` field no longer exists on a loaded entry.

- [ ] **Step 1: Rewrite the failing state and layout tests**

Replace the existing tests named `"corrupt storage is discarded and defaults rebuild"`, `"a field added later appends without disturbing stored order"`, `"a __proto__ key in stored cards can't taint an untouched device's defaults"`, `"value font follows cells over visible count"`, `"a card with more than six visible values spans 2x2"`, and `"hiding a value grows the rest"` in `test/cards.spec.js` with the following. Delete the test named `"the aspect button cycles square, horizontal, vertical"` outright.

Add these helpers just below the existing `cardState(page)` helper:

```js
async function setSize(page, key, w, h) {
  await page.evaluate(([k, w, h]) => {
    cardState.cards[k].w = w;
    cardState.cards[k].h = h;
    renderCards();
  }, [key, w, h]);
}

async function setGrid(page, cols, rows) {
  await page.evaluate(([c, r]) => {
    cardState.grid = { cols: c, rows: r };
    measureGrid();
    renderCards();
  }, [cols, rows]);
}

function spans(page, sel) {
  return page.locator(sel).evaluate(n => {
    const s = getComputedStyle(n);
    return { col: s.gridColumnStart + " " + s.gridColumnEnd, row: s.gridRowStart + " " + s.gridRowEnd };
  });
}
```

The replacement tests:

```js
test("a field added later appends without disturbing stored order", async ({ page }) => {
  await open(page, [ACURITE]);
  await page.click("#tab-cards");
  const order = await page.evaluate(() => {
    cardState = { grid: { cols: 6, rows: 4 }, order: ["k"], hidden: [],
      cards: { k: { w: 1, h: 1, valueOrder: ["humidity", "temperature_F"], hiddenValues: [] } } };
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
  expect(s).toEqual({
    grid: { cols: 6, rows: 4 },
    order: ["Acurite-5n1/396"],
    hidden: [],
    cards: {
      "Acurite-5n1/396": {
        w: 2, h: 2,
        valueOrder: ["battery_ok", "wind_avg_mi_h", "temperature_F", "humidity"],
        hiddenValues: ["battery_ok"],
      },
    },
  });
});

test("a __proto__ key in stored cards can't taint an untouched device's defaults", async ({ page }) => {
  await open(page, [ACURITE]);
  // Written as raw JSON text: an object literal's __proto__ key sets a
  // prototype rather than an own property, which would defeat the test.
  const payload = '{"order":[],"hidden":[],"cards":{"__proto__":' +
    '{"w":4,"h":4,"valueOrder":["bogus"],"hiddenValues":["bogus"]}}}';
  await page.evaluate((p) => localStorage.setItem("rtl433.cards.v1", p), payload);
  await page.reload();
  await expect(page.locator("#status")).toHaveText("live");

  const result = await page.evaluate(() => {
    try {
      const merged = { temperature_F: 71.2, humidity: 38, battery_ok: 1 };
      ensureCard("toString", merged);
      return { ok: true, card: cardState.cards["toString"] };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });
  expect(result.ok).toBe(true);
  expect(result.card.w).toBe(2);
  expect(result.card.h).toBe(1);
  expect(result.card.valueOrder).toEqual(["temperature_F", "humidity", "battery_ok"]);
  expect(result.card.hiddenValues).toEqual(["battery_ok"]);
});

test("default card size packs values into the most compact rectangle", async ({ page }) => {
  await open(page, [ACURITE]);
  await page.click("#tab-cards");
  const sizes = await page.evaluate(() =>
    [1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => { const s = defaultSize(n); return [s.w, s.h]; }));
  expect(sizes).toEqual([[1, 1], [2, 1], [2, 2], [2, 2], [3, 2], [3, 2], [3, 3], [3, 3], [3, 3]]);
});

test("an Acurite 5n1 with three readings defaults to 2x2", async ({ page }) => {
  await open(page, [ACURITE]);
  await page.click("#tab-cards");
  const c = (await cardState(page)).cards["Acurite-5n1/396"];
  expect([c.w, c.h]).toEqual([2, 2]);
  expect(await spans(page, CARD)).toEqual({ col: "span 2 span 2", row: "span 2 span 2" });
});

test("value font follows the measured box", async ({ page }) => {
  await open(page, [ACURITE]);
  await page.click("#tab-cards");
  const sizes = await page.evaluate(() => ({
    one: valueFont(1, 150, 1), two: valueFont(2, 150, 2),
    packed: valueFont(1, 150, 4), floor: valueFont(1, 20, 1), ceil: valueFont(3, 200, 1),
  }));
  expect(sizes).toEqual({ one: "63px", two: "63px", packed: "16px", floor: "11px", ceil: "64px" });
});

test("the cell side is the smaller of the two divisions and re-measures on resize", async ({ page }) => {
  await open(page, [ACURITE]);
  await page.click("#tab-cards");
  await setGrid(page, 6, 4);

  const read = () => page.evaluate(() => {
    const g = document.getElementById("cards");
    const cs = getComputedStyle(g);
    return {
      cell: cellSide,
      width: g.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
      height: window.innerHeight - g.getBoundingClientRect().top
              - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom),
      prop: parseFloat(cs.getPropertyValue("--cell")),
    };
  });

  for (const [w, h] of [[1200, 800], [640, 900], [1400, 500]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(120);
    const m = await read();
    expect(m.cell).toBeCloseTo(Math.min(m.width / 6, m.height / 4), 1);
    expect(m.prop).toBeCloseTo(m.cell, 1);
  }
});

test("hiding a value in a card smaller than its value count grows the rest", async ({ page }) => {
  await open(page, [LONGNAME]);
  await page.click("#tab-cards");
  await setSize(page, LONG_KEY, 2, 1);
  const font = () => page.locator(LONG_CARD + ' .val[data-f="temperature_F"] .fv')
    .evaluate(n => parseFloat(n.style.fontSize));

  // Seven values in two columns need four rows; hiding one drops it to three.
  const before = await font();
  await page.click("#edit-cards");
  await page.click(LONG_CARD + ' .val[data-f="rain_mm"]');
  await page.click("#edit-cards");
  expect(await font()).toBeGreaterThan(before);
});

test("an old aspect entry migrates to a width and height", async ({ page }) => {
  await open(page, [ACURITE, OREGON, THERMO]);
  await page.evaluate(() => localStorage.setItem("rtl433.cards.v1", JSON.stringify({
    order: ["Acurite-5n1/396", "Oregon-THN132N/23", "Fineoffset-WH2/174"],
    hidden: [],
    cards: {
      "Acurite-5n1/396": { aspect: "h", valueOrder: [], hiddenValues: [] },
      "Oregon-THN132N/23": { aspect: "v", valueOrder: [], hiddenValues: [] },
      "Fineoffset-WH2/174": { aspect: "sq", valueOrder: [], hiddenValues: [] },
    },
  })));
  await page.reload();
  await page.click("#tab-cards");

  const cards = (await cardState(page)).cards;
  expect([cards["Acurite-5n1/396"].w, cards["Acurite-5n1/396"].h]).toEqual([2, 1]);
  expect([cards["Oregon-THN132N/23"].w, cards["Oregon-THN132N/23"].h]).toEqual([1, 2]);
  expect([cards["Fineoffset-WH2/174"].w, cards["Fineoffset-WH2/174"].h]).toEqual([1, 1]);
  expect(cards["Acurite-5n1/396"].aspect).toBeUndefined();
});

test("an entry with neither a size nor an aspect is sized from its value count", async ({ page }) => {
  await open(page, [LONGNAME]);
  await page.evaluate(k => localStorage.setItem("rtl433.cards.v1", JSON.stringify({
    order: [k], hidden: [], cards: { [k]: { valueOrder: [], hiddenValues: [] } },
  })), LONG_KEY);
  await page.reload();
  await page.click("#tab-cards");

  // Eight readings, battery_ok hidden as a status field, leaves seven visible.
  const c = (await cardState(page)).cards[LONG_KEY];
  expect([c.w, c.h]).toEqual([3, 3]);
});
```

Move the `LONG_KEY` and `LONG_CARD` constants (currently at `test/cards.spec.js:411-412`) and the `CARD` constant (currently `:162`) up to just below the `require` lines at the top of the file, so the tests above can use them.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx playwright test`
Expected: FAIL. The new tests fail on `defaultSize is not defined`, `measureGrid is not defined`, `cellSide is not defined`, and a `cardState` shape without a `grid` key.

- [ ] **Step 3: Replace the CSS block**

In `cards_html.h`, replace lines 12–42 (from `#cards {` through the closing brace of the `@media (max-width:400px)` block) with:

```css
#cards { display:grid; grid-auto-flow:dense; grid-auto-rows:var(--cell,150px);
         justify-content:start; align-content:start; padding:1.6rem 1rem 1rem; }
.card { position:relative; margin:.35rem; border:1px solid var(--line); border-radius:.7rem;
        padding:.5rem .45rem .6rem; overflow:hidden; }
.card.flash { animation:flash 1s ease-out; }
.card .lbl { position:absolute; top:-.65em; right:.7rem; max-width:calc(100% - 1.4rem);
             padding:0 .4rem; background:Canvas; font-size:.75rem;
             display:flex; align-items:baseline; overflow:hidden; }
.card .lbl .nm { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0;
                 flex:1 1 auto; }
.card .lbl .rs { opacity:.6; margin-left:.35rem; flex:0 0 auto; white-space:nowrap;
                 font-variant-numeric:tabular-nums; }
.card .age { position:absolute; right:.5rem; bottom:.25rem; font-size:.65rem; opacity:.5;
             font-variant-numeric:tabular-nums; }
.card .body { display:grid; align-items:stretch; gap:.2rem .6rem; height:100%; overflow:hidden; }
.card .val { display:flex; flex-direction:column; justify-content:center; line-height:1.05;
             min-width:0; min-height:0; align-self:stretch; overflow:hidden; }
.card .fn { font-size:.6rem; text-transform:uppercase; letter-spacing:.05em; opacity:.6;
            overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.card .fv { font-variant-numeric:tabular-nums; white-space:nowrap; overflow:hidden;
            text-overflow:ellipsis; display:block; }
.card .fv .u { font-size:.5em; opacity:.65; margin-left:.12em; }
```

The gap moves off the grid and onto each card's margin, so the cell arithmetic stays exact. `.val`
stretches to its track and clips inside it rather than being centred at its content height, so a card
packed with more values than it has room for cannot push its own box past the cell it spans.

Then in the remaining CSS, drop the `.ca` selectors. Replace:

```css
.card .cx, .card .ca { position:absolute; top:.25rem; z-index:1; font:inherit; font-size:.7rem;
```
with
```css
.card .cx { position:absolute; top:.25rem; z-index:1; font:inherit; font-size:.7rem;
```

Delete the line `.card .ca { left:2rem; }`, and replace:

```css
#view-cards.editing .card .cx, #view-cards.editing .card .ca { display:block; }
```
with
```css
#view-cards.editing .card .cx { display:block; }
```

- [ ] **Step 4: Replace state loading, sizing, and measurement**

In the JS block, replace `blankState()` (line 79) with:

```js
const GRID_MIN = 1, GRID_MAX = 24;

// Null prototype: a stored "__proto__" key must not become a prototype link.
function blankState() {
  return { grid: { cols: 6, rows: 4 }, order: [], hidden: [], cards: Object.create(null) };
}

function gridNum(v, fallback) {
  return Number.isInteger(v) && v >= GRID_MIN && v <= GRID_MAX ? v : fallback;
}

function defaultSize(count) {
  const v = Math.max(1, count);
  const w = Math.ceil(Math.sqrt(v));
  return { w: w, h: Math.ceil(v / w) };
}

// Entries written before the grid carry an aspect instead of a size. One with
// neither returns empty and ensureCard() sizes it from its value count.
function migrateSize(c) {
  const w = gridNum(c.w, 0), h = gridNum(c.h, 0);
  if (w && h) return { w: w, h: h };
  if (c.aspect === "h") return { w: 2, h: 1 };
  if (c.aspect === "v") return { w: 1, h: 2 };
  if (c.aspect === "sq") return { w: 1, h: 1 };
  return {};
}
```

In `loadCardState()`, replace the `cardState = { order: ..., hidden: ..., cards: ... }` assignment with:

```js
  const g = s.grid && typeof s.grid === "object" ? s.grid : {};
  cardState = {
    grid: { cols: gridNum(g.cols, 6), rows: gridNum(g.rows, 4) },
    order: Array.isArray(s.order) ? s.order.filter(k => typeof k === "string") : [],
    hidden: Array.isArray(s.hidden) ? s.hidden.filter(k => typeof k === "string") : [],
    cards: Object.create(null),
  };
```

and replace the per-card assignment inside the `for (const k of Object.keys(cards))` loop with:

```js
    const size = migrateSize(c);
    cardState.cards[k] = {
      name: typeof c.name === "string" ? c.name : undefined,
      w: size.w, h: size.h,
      valueOrder: Array.isArray(c.valueOrder) ? c.valueOrder.filter(f => typeof f === "string") : [],
      hiddenValues: Array.isArray(c.hiddenValues) ? c.hiddenValues.filter(f => typeof f === "string") : [],
    };
```

- [ ] **Step 5: Size a card on first detection**

Replace `ensureCard()` (lines 113–133) with:

```js
function ensureCard(key, merged) {
  let c = cardState.cards[key];
  const fields = Object.keys(merged || {});
  if (!c) {
    c = {
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
  if (!c.w || !c.h) {
    const size = defaultSize(visibleValues(key, merged).length);
    c.w = size.w;
    c.h = size.h;
  }
  if (cardState.order.indexOf(key) < 0) cardState.order.push(key);
  return c;
}
```

- [ ] **Step 6: Replace the sizing helpers with the measurement**

Delete `cardCells()` (lines 163–167) and `bodyCols()` (lines 169–174). Replace `valueFont()` (lines 176–179) with:

```js
let cellSide = 150;

// Square cells sized to fit the whole grid on screen, so the shorter of the two
// divisions wins and the other axis letterboxes.
function measureGrid() {
  const grid = document.getElementById("cards");
  if (!grid || grid.clientWidth <= 0) return;
  const g = cardState.grid;
  const cs = getComputedStyle(grid);
  const width = grid.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const height = window.innerHeight - grid.getBoundingClientRect().top
                 - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  cellSide = Math.max(20, Math.min(width / g.cols, height / g.rows));
  grid.style.setProperty("--cell", cellSide + "px");
  grid.style.gridTemplateColumns = "repeat(" + g.cols + ",var(--cell))";
  grid.style.gridTemplateRows = "repeat(" + g.rows + ",var(--cell))";
}

function valueFont(h, cell, rows) {
  const px = Math.round(0.42 * h * cell / Math.max(1, rows));
  return Math.min(64, Math.max(11, px)) + "px";
}
```

- [ ] **Step 7: Render cards on the new grid**

In `buildCard()`, replace lines 199–216 (from `function buildCard` down to and including the `const font = ...` line) with:

```js
function buildCard(rec, c) {
  const key = rec.key;
  const vis = visibleValues(key, rec.merged);
  const g = cardState.grid;
  const w = Math.max(1, Math.min(c.w, g.cols));
  const h = Math.max(1, Math.min(c.h, g.rows));

  const card = el("div", "card");
  card.style.gridColumn = "span " + w;
  card.style.gridRow = "span " + h;
  card.dataset.key = key;
  if (rec.flashUntil > Date.now()) card.classList.add("flash");

  const lbl = el("div", "lbl");
  lbl.append(el("span", "nm", cardLabel(key)), el("span", "rs", rec.rssi === undefined ? "" : String(rec.rssi)));

  const body = el("div", "body");
  const shown = editing ? c.valueOrder.filter(f => rec.merged[f] !== undefined) : vis;
  const valueRows = Math.max(h, Math.ceil(shown.length / w));
  body.style.gridTemplateColumns = "repeat(" + w + ",minmax(0,1fr))";
  body.style.gridTemplateRows = "repeat(" + valueRows + ",minmax(0,1fr))";
  const font = valueFont(h, cellSide, valueRows);
```

Then delete the aspect button. Replace lines 233–236:

```js
  const cx = el("button", "cx", "✕");
  cx.onclick = ev => { ev.stopPropagation(); toggleCardHidden(key); };
  const ca = el("button", "ca", "▭");
  ca.onclick = ev => { ev.stopPropagation(); cycleAspect(key); };
```
with
```js
  const cx = el("button", "cx", "✕");
  cx.onclick = ev => { ev.stopPropagation(); toggleCardHidden(key); };
```

and replace the append line (269):

```js
  card.append(lbl, body, el("div", "age", ageText(Date.now() - rec.seenAt)), cx, ca);
```
with
```js
  card.append(lbl, body, el("div", "age", ageText(Date.now() - rec.seenAt)), cx);
```

Delete `cycleAspect()` (lines 305–311) and the `const ASPECTS = ["sq", "h", "v"];` line (287).

- [ ] **Step 8: Measure before every render, and on resize**

In `renderCards`, add the measurement as the first statement after the drag guard:

```js
renderCards = function () {
  const grid = document.getElementById("cards");
  if (!grid) return;
  if (dragging) return;
  measureGrid();
  const seeded = new Map();
```

At the bottom of the script, above the final `renderCards();` call, add:

```js
// The section is hidden until its tab is shown, so the first real measurement
// has to wait for that click; the tab's own handler runs first and unhides it.
document.getElementById("tab-cards").addEventListener("click", () => { measureGrid(); renderCards(); });
window.addEventListener("resize", () => { measureGrid(); renderCards(); });
```

- [ ] **Step 9: Fix the remaining tests that referenced the aspect model**

In `test/cards.spec.js`, in the test named `"Forget layouts clears stored state and rebuilds defaults"`, replace the `.ca` click and the class assertion:

```js
  await page.click(CARD + " .cx");
  await page.click(CARD + " .ca");
  expect((await cardState(page)).hidden).toEqual(["Acurite-5n1/396"]);
```
with
```js
  await page.click(CARD + " .cx");
  expect((await cardState(page)).hidden).toEqual(["Acurite-5n1/396"]);
```

and
```js
  await expect(page.locator(CARD)).not.toHaveClass(/ghost/);
  await expect(page.locator(CARD)).toHaveClass(/\bsq\b/);
  await expect(page.locator("#cards .card")).toHaveCount(2);
```
with
```js
  await expect(page.locator(CARD)).not.toHaveClass(/ghost/);
  expect(await spans(page, CARD)).toEqual({ col: "span 2 span 2", row: "span 2 span 2" });
  await expect(page.locator("#cards .card")).toHaveCount(2);
```

- [ ] **Step 10: Run the tests to verify they pass**

Run: `npx playwright test`
Expected: PASS, every test.

- [ ] **Step 11: Commit**

```bash
git add cards_html.h test/cards.spec.js
git commit -m "Lay cards on a measured grid of square cells"
```

---

### Task 2: The column and row inputs

**Files:**
- Modify: `cards_html.h` (the `#view-cards` markup, the CSS block, the JS block)
- Test: `test/cards.spec.js`

**Model:** `sonnet` — a small self-contained control wired to `measureGrid()`.

**Interfaces:**
- Consumes: `GRID_MIN`, `GRID_MAX`, `gridNum`, `measureGrid`, `cardState.grid`, `saveCardState`, `renderCards` from Task 1.
- Produces: elements `#grid-cols` and `#grid-rows`, and `syncGridInputs()` → void, which writes `cardState.grid` back into the two inputs.

- [ ] **Step 1: Write the failing tests**

Append to `test/cards.spec.js`:

```js
test("the grid inputs are hidden until edit mode and set the tracks", async ({ page }) => {
  await open(page, [ACURITE]);
  await page.click("#tab-cards");
  await expect(page.locator("#grid-size")).toBeHidden();

  await page.click("#edit-cards");
  await expect(page.locator("#grid-size")).toBeVisible();
  await expect(page.locator("#grid-cols")).toHaveValue("6");
  await expect(page.locator("#grid-rows")).toHaveValue("4");

  await page.fill("#grid-cols", "8");
  await page.locator("#grid-cols").blur();
  await page.fill("#grid-rows", "3");
  await page.locator("#grid-rows").blur();

  expect((await cardState(page)).grid).toEqual({ cols: 8, rows: 3 });
  const tracks = await page.locator("#cards").evaluate(n => ({
    cols: getComputedStyle(n).gridTemplateColumns.split(" ").length,
    rows: getComputedStyle(n).gridTemplateRows.split(" ").length,
  }));
  expect(tracks).toEqual({ cols: 8, rows: 3 });
});

test("an out-of-range or non-numeric input reverts to the last good value", async ({ page }) => {
  await open(page, [ACURITE]);
  await edit(page);
  await page.fill("#grid-cols", "9");
  await page.locator("#grid-cols").blur();
  expect((await cardState(page)).grid.cols).toBe(9);

  for (const bad of ["0", "25", "-3", ""]) {
    await page.fill("#grid-cols", bad);
    await page.locator("#grid-cols").blur();
    await expect(page.locator("#grid-cols")).toHaveValue("9");
    expect((await cardState(page)).grid.cols).toBe(9);
  }
});

test("the grid size survives a reload and Forget layouts resets it", async ({ page }) => {
  await open(page, [ACURITE]);
  await edit(page);
  await page.fill("#grid-rows", "7");
  await page.locator("#grid-rows").blur();

  await page.reload();
  await edit(page);
  await expect(page.locator("#grid-rows")).toHaveValue("7");

  page.once("dialog", d => d.accept());
  await page.click("#forget-cards");
  await expect(page.locator("#grid-rows")).toHaveValue("4");
  expect(await cardState(page)).toBeNull();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx playwright test -g "grid input" -g "out-of-range" -g "survives a reload"`
Expected: FAIL, `#grid-size` not found.

- [ ] **Step 3: Add the markup**

In `cards_html.h`, replace the `#view-cards` section (lines 6–10) with:

```html
<section id="view-cards" hidden>
  <button id="edit-cards" title="Edit layout">&#9998;</button>
  <button id="forget-cards" title="Forget saved layouts">Forget layouts</button>
  <span id="grid-size" title="Grid columns and rows">
    <input id="grid-cols" type="number" min="1" max="24" aria-label="Grid columns">
    <span>&times;</span>
    <input id="grid-rows" type="number" min="1" max="24" aria-label="Grid rows">
  </span>
  <div id="cards"></div>
</section>
```

- [ ] **Step 4: Style it beside the other two controls**

Add to the CSS block, next to the `#forget-cards` rules:

```css
#grid-size { position:fixed; right:12rem; bottom:1rem; z-index:2; font-size:.75rem;
             display:none; align-items:center; gap:.25rem; }
#view-cards.editing #grid-size { display:flex; }
#grid-size input { font:inherit; font-size:.75rem; width:3.2rem; padding:.3rem .35rem;
                   border-radius:1.2rem; border:1px solid var(--line); background:Canvas;
                   color:inherit; text-align:center; }
```

- [ ] **Step 5: Wire the inputs**

Add just below the `#forget-cards` click handler in the JS block:

```js
function syncGridInputs() {
  document.getElementById("grid-cols").value = String(cardState.grid.cols);
  document.getElementById("grid-rows").value = String(cardState.grid.rows);
}

function applyGridInput(input, key) {
  const n = gridNum(parseInt(input.value, 10), 0);
  if (n) {
    cardState.grid[key] = n;
    saveCardState();
  }
  input.value = String(cardState.grid[key]);
  measureGrid();
  renderCards();
}

document.getElementById("grid-cols").onchange = ev => applyGridInput(ev.target, "cols");
document.getElementById("grid-rows").onchange = ev => applyGridInput(ev.target, "rows");
syncGridInputs();
```

`parseInt("", 10)` is `NaN`, which `gridNum` rejects along with 0, 25, and -3, so the input reverts.

- [ ] **Step 6: Reset the inputs when layouts are forgotten**

In `forgetLayouts()`, add the sync and the re-measure:

```js
function forgetLayouts() {
  try { localStorage.removeItem(CARDS_KEY); } catch (e) { storageBroken = true; }
  cardState = blankState();
  syncGridInputs();
  measureGrid();
  renderCards();
}
```

- [ ] **Step 7: Run the full suite**

Run: `npx playwright test`
Expected: PASS, every test.

- [ ] **Step 8: Commit**

```bash
git add cards_html.h test/cards.spec.js
git commit -m "Set the card grid's columns and rows in edit mode"
```

---

### Task 3: The corner resize handle

**Files:**
- Modify: `cards_html.h` (CSS block, `buildCard`, the drag section, `renderCards`)
- Test: `test/cards.spec.js`

**Model:** `sonnet` — hand-rolled pointer handling that has to coexist with the existing card and value drags.

**Interfaces:**
- Consumes: `cellSide`, `cardState.grid`, `saveCardState`, `renderCards`, `el` from Task 1.
- Produces: global `resizing` (null when idle, else `{key, card, x0, y0, w0, h0, w, h, pointerId}`), `beginResize(ev, card, w, h)`, `resizeMove(ev)`, `endResize(ev)`, and a `.rz` button in every card.

- [ ] **Step 1: Write the failing tests**

Append to `test/cards.spec.js`:

```js
async function dragHandle(page, sel, dx, dy) {
  const box = await page.locator(sel + " .rz").boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 10 });
  await page.mouse.up();
}

test("the resize handle only appears in edit mode", async ({ page }) => {
  await open(page, [ACURITE]);
  await page.click("#tab-cards");
  await expect(page.locator(CARD + " .rz")).toBeHidden();
  await page.click("#edit-cards");
  await expect(page.locator(CARD + " .rz")).toBeVisible();
});

test("dragging the corner snaps to whole cells and persists", async ({ page }) => {
  await open(page, [ACURITE]);
  await edit(page);
  const cell = await page.evaluate(() => cellSide);

  await dragHandle(page, CARD, cell, cell);
  expect(await spans(page, CARD)).toEqual({ col: "span 3 span 3", row: "span 3 span 3" });
  const c = (await cardState(page)).cards["Acurite-5n1/396"];
  expect([c.w, c.h]).toEqual([3, 3]);

  await page.reload();
  await page.click("#tab-cards");
  expect(await spans(page, CARD)).toEqual({ col: "span 3 span 3", row: "span 3 span 3" });
});

test("a resize clamps at one cell and at the grid's own dimensions", async ({ page }) => {
  await open(page, [ACURITE]);
  await edit(page);
  await setGrid(page, 6, 4);

  await dragHandle(page, CARD, -4000, -4000);
  let c = (await cardState(page)).cards["Acurite-5n1/396"];
  expect([c.w, c.h]).toEqual([1, 1]);

  await dragHandle(page, CARD, 4000, 4000);
  c = (await cardState(page)).cards["Acurite-5n1/396"];
  expect([c.w, c.h]).toEqual([6, 4]);
});

test("a drag on the handle moves neither the card nor a value", async ({ page }) => {
  await open(page, [ACURITE, OREGON]);
  await edit(page);
  const cell = await page.evaluate(() => cellSide);
  const fieldsBefore = await page.locator(CARD + " .val").evaluateAll(n => n.map(v => v.dataset.f));

  await dragHandle(page, CARD, cell, 0);

  const keys = await page.locator("#cards .card").evaluateAll(n => n.map(c => c.dataset.key));
  expect(keys).toEqual(["Acurite-5n1/396", "Oregon-THN132N/23"]);
  expect(await page.locator(CARD + " .val").evaluateAll(n => n.map(v => v.dataset.f))).toEqual(fieldsBefore);
  await expect(page.locator(".ghostcard")).toHaveCount(0);
});

test("a card resized larger renders larger type", async ({ page }) => {
  await open(page, [ACURITE]);
  await page.click("#tab-cards");
  const font = () => page.locator(CARD + ' .val[data-f="temperature_F"] .fv')
    .evaluate(n => parseFloat(n.style.fontSize));

  await setSize(page, "Acurite-5n1/396", 1, 1);
  const small = await font();
  await setSize(page, "Acurite-5n1/396", 4, 4);
  expect(await font()).toBeGreaterThan(small);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx playwright test -g "resize" -g "corner" -g "handle"`
Expected: FAIL, `.rz` never resolves.

- [ ] **Step 3: Style the handle**

Add to the CSS block, below the `.card .cx` rules:

```css
.card .rz { position:absolute; right:0; bottom:0; width:1.2rem; height:1.2rem; z-index:1;
            padding:0; border:none; background:none; color:inherit; cursor:nwse-resize;
            touch-action:none; display:none; }
.card .rz::after { content:""; position:absolute; right:.25rem; bottom:.25rem;
                   width:.5rem; height:.5rem; opacity:.55;
                   border-right:2px solid currentColor; border-bottom:2px solid currentColor; }
#view-cards.editing .card .rz { display:block; }
#view-cards.editing .card .age { right:1.4rem; }
```

- [ ] **Step 4: Add the handle to every card**

In `buildCard()`, alongside the `cx` button, add:

```js
  const rz = el("button", "rz", "");
  rz.onpointerdown = ev => {
    if (!editing || ev.button !== 0) return;
    ev.stopPropagation();
    beginResize(ev, card, w, h);
  };
```

and extend the append:

```js
  card.append(lbl, body, el("div", "age", ageText(Date.now() - rec.seenAt)), cx, rz);
```

- [ ] **Step 5: Handle the resize gesture**

Add below `beginDrag()` in the drag section:

```js
let resizing = null;

function beginResize(ev, card, w, h) {
  resizing = { key: card.dataset.key, card: card, x0: ev.clientX, y0: ev.clientY,
               w0: w, h0: h, w: w, h: h, pointerId: ev.pointerId };
  card.setPointerCapture(ev.pointerId);
}

function resizeMove(ev) {
  const r = resizing;
  if (!r || ev.pointerId !== r.pointerId) return;
  const g = cardState.grid;
  r.w = Math.max(1, Math.min(g.cols, r.w0 + Math.round((ev.clientX - r.x0) / cellSide)));
  r.h = Math.max(1, Math.min(g.rows, r.h0 + Math.round((ev.clientY - r.y0) / cellSide)));
  r.card.style.gridColumn = "span " + r.w;
  r.card.style.gridRow = "span " + r.h;
}

function endResize(ev) {
  const r = resizing;
  if (!r || ev.pointerId !== r.pointerId) return;
  resizing = null;
  const c = cardState.cards[r.key];
  if (c) { c.w = r.w; c.h = r.h; saveCardState(); }
  renderCards();
}
```

- [ ] **Step 6: Route the document pointer events and suppress the tick**

Replace the three document listeners at the bottom of the script:

```js
document.addEventListener("pointermove", dragMove);
document.addEventListener("pointerup", endDrag);
document.addEventListener("pointercancel", endDrag);
```
with
```js
document.addEventListener("pointermove", ev => { dragMove(ev); resizeMove(ev); });
document.addEventListener("pointerup", ev => { endDrag(ev); endResize(ev); });
document.addEventListener("pointercancel", ev => { endDrag(ev); endResize(ev); });
```

and change the guard in `renderCards`:

```js
  if (dragging || resizing) return;
```

- [ ] **Step 7: Run the full suite**

Run: `npx playwright test`
Expected: PASS, every test.

- [ ] **Step 8: Commit**

```bash
git add cards_html.h test/cards.spec.js
git commit -m "Resize a card by its corner, snapped to whole cells"
```

---

### Task 4: Overflow across card sizes, and the negative-value gap

**Files:**
- Test: `test/cards.spec.js`
- Modify: `test/fixtures.js`

**Model:** `sonnet` — closes the two test gaps the spec names; a real failure here means a layout fix in `cards_html.h`.

**Interfaces:**
- Consumes: `setSize`, `setGrid`, `CARD`, `LONG_KEY`, `LONG_CARD` from Task 1.
- Produces: a `FREEZER` fixture exported from `test/fixtures.js`.

- [ ] **Step 1: Add a below-zero fixture**

In `test/fixtures.js`, add above the `module.exports` line:

```js
// rtl_433 reports temperatures below zero; fmtValue branches on Math.abs.
const FREEZER = {
  model: "Fineoffset-WH51", id: 88, channel: 2, protocol: 55,
  battery_ok: 1, temperature_C: -12.345, temperature_F: -4.5678, humidity: 71, mic: "CRC",
};
```

and change the export to:

```js
module.exports = { ACURITE, OREGON, THERMO, LONGNAME, FREEZER };
```

- [ ] **Step 2: Write the failing tests**

In `test/cards.spec.js`, add `FREEZER` to the `require("./fixtures")` destructure, then replace the test named `"values spread across the card without overflowing it"` with:

```js
test("values spread across the card without overflowing it", async ({ page }) => {
  await open(page, [LONGNAME]);
  await page.click("#tab-cards");

  const card = page.locator(LONG_CARD);
  const body = card.locator(".body");
  const bodyBox = await body.boundingBox();
  const boxes = await body.locator(".val").evaluateAll(nodes => nodes.map(n => {
    const r = n.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  }));
  expect(boxes.length).toBeGreaterThan(3);
  const spanX = Math.max(...boxes.map(b => b.right)) - Math.min(...boxes.map(b => b.left));
  const spanY = Math.max(...boxes.map(b => b.bottom)) - Math.min(...boxes.map(b => b.top));
  expect(spanX).toBeGreaterThan(bodyBox.width * 0.8);
  expect(spanY).toBeGreaterThan(bodyBox.height * 0.7);
});

test("no card overflows its box at any size or value count", async ({ page }) => {
  await open(page, [LONGNAME, ACURITE, OREGON]);
  await page.click("#tab-cards");
  await setGrid(page, 6, 4);

  const overflow = sel => page.locator(sel).evaluate(n => ({
    w: n.scrollWidth - n.clientWidth, h: n.scrollHeight - n.clientHeight,
  }));

  for (const [key, sel] of [[LONG_KEY, LONG_CARD], ["Acurite-5n1/396", CARD],
                            ["Oregon-THN132N/23", '.card[data-key="Oregon-THN132N/23"]']]) {
    for (const [w, h] of [[1, 1], [2, 1], [1, 2], [2, 2], [3, 2], [3, 3], [6, 4]]) {
      await setSize(page, key, w, h);
      const card = await overflow(sel);
      expect(card.w, `${key} ${w}x${h} card width`).toBeLessThanOrEqual(0);
      expect(card.h, `${key} ${w}x${h} card height`).toBeLessThanOrEqual(0);
      const body = await overflow(sel + " .body");
      expect(body.w, `${key} ${w}x${h} body width`).toBeLessThanOrEqual(0);
      expect(body.h, `${key} ${w}x${h} body height`).toBeLessThanOrEqual(0);
    }
  }
});

test("fmtValue rounds by magnitude and leaves non-numbers untouched", async ({ page }) => {
  await open(page, [ACURITE]);
  await page.click("#tab-cards");
  const out = await page.evaluate(() => [
    fmtValue(71.234), fmtValue(4.6), fmtValue(0.0300), fmtValue(1013.25),
    fmtValue(38), fmtValue("CHECKSUM"), fmtValue(true),
    fmtValue(-12.345), fmtValue(-4.5678), fmtValue(-0.004), fmtValue(-1013.25),
  ]);
  expect(out).toEqual(["71.2", "4.6", "0.03", "1013.3", "38", "CHECKSUM", "true",
                      "-12.3", "-4.57", "0", "-1013.3"]);
});

test("a below-zero reading renders with its sign and unit", async ({ page }) => {
  await open(page, [FREEZER]);
  await page.click("#tab-cards");
  const card = page.locator('.card[data-key="Fineoffset-WH51/88"]');
  await expect(card.locator('.val[data-f="temperature_C"] .fv')).toHaveText("-12.3°C");
  await expect(card.locator('.val[data-f="temperature_F"] .fv')).toHaveText("-4.57°F");
});
```

`fmtValue` branches on `Math.abs(v) >= 10`, so -12.345 takes the one-decimal path and -4.5678 the
two-decimal one. `fmtValue(-0.004)` is `"0"`: `(-0.004).toFixed(2)` is `"-0.00"`, `parseFloat` of that
is `-0`, and `String(-0)` is `"0"`.

- [ ] **Step 3: Run the tests**

Run: `npx playwright test -g "overflows" -g "fmtValue" -g "below-zero" -g "spread"`
Expected: the two `fmtValue`/below-zero tests FAIL first (missing fixture and cases) then PASS after Step 1. The overflow sweep must PASS against the Task 1–3 layout; if it fails, that is a real defect in `cards_html.h` to fix here before moving on.

- [ ] **Step 4: Run the full suite**

Run: `npx playwright test`
Expected: PASS, every test.

- [ ] **Step 5: Commit**

```bash
git add test/cards.spec.js test/fixtures.js cards_html.h
git commit -m "Check card overflow across sizes and readings below zero"
```

---

### Task 5: Flash measurement, docs, and cleanup

**Files:**
- Modify: `README.md:84-98` (the Cards section)
- Modify: `docs/backlog.md`
- Delete: `docs/superpowers/specs/2026-08-13-card-grid-redesign.md`
- Delete: `docs/superpowers/plans/2026-08-13-card-grid-redesign.md`

**Model:** `sonnet` — a build measurement plus prose that has to match what actually shipped.

**Interfaces:**
- Consumes: the finished `cards_html.h`.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Measure the flash delta**

```bash
git stash list  # expect empty; the tree must be clean
pio run -e esp32s3-generic 2>&1 | tail -6
```

Record the `Flash: [====  ] NN.N% (used X bytes from Y bytes)` line. Then measure the merge-base:

```bash
git switch --detach $(git merge-base HEAD main)
pio run -e esp32s3-generic 2>&1 | tail -6
git switch -
```

Record the second figure. The delta is the branch's flash cost. Expected: roughly neutral against the tip of `card-dashboard`, since `bodyCols`, `cardCells`, the aspect handling, and two media queries came out while the grid measurement, the inputs, and the resize went in.

If `pio run` cannot fetch its toolchain or the fork dependency, fall back to measuring the literal itself and say so in the backlog note:

```bash
git show $(git merge-base HEAD main):cards_html.h | wc -c
wc -c cards_html.h
```

- [ ] **Step 2: Rewrite the README Cards section**

Replace `README.md` lines 84–98 with:

```markdown
## Cards

The Cards tab lays each tracked device on a grid of square cells. Two number
inputs in edit mode set the columns and rows, 6 × 4 by default and 1–24 each;
the cell side is whichever of width ÷ columns and height ÷ rows is smaller, so
the grid fits on screen with margin on the other axis.

A card spans whole cells. On first detection it is sized to hold its visible
readings one per cell, in the most compact rectangle: one reading gives 1×1,
three or four give 2×2, seven through nine give 3×3. Dragging the corner handle
in edit mode resizes it, snapped to whole cells, from 1×1 up to the grid's own
dimensions. Type size follows the measured cell, so a bigger card reads bigger.
Cards that do not fit in the set number of rows render below the fold.

The pencil button opens edit mode, where cards drag to reorder, values drag to
reorder within their card, clicking a value hides it, ✕ hides the card, and
double-clicking the label renames it. A long device name in the label
ellipsizes rather than overflowing the card; readings round to one or two
decimal places for display, without changing the stored values.

Layout is per browser, in localStorage under `rtl433.cards.v1`. It is never
sent to the device, so two browsers can arrange the same receiver differently.
Layouts are never dropped on their own, so a sensor that goes quiet and returns
keeps its card. Forget layouts, in edit mode, clears them all.
```

- [ ] **Step 3: Update the backlog**

In `docs/backlog.md`:

Under `## Gaps in the page tests`, delete the first two bullets (the negative-reading bullet and the overflow-aspect bullet), both now covered. Keep the third bullet about `forgetLayouts()` and the Escape path.

Under `## Smaller items`, delete the final bullet about the 1.9rem font base and the `bodyCols()` ratio constants. Replace it with:

```markdown
- The card type size is `0.42 × (h × cell ÷ valueRows)` px clamped to 11–64.
  The factor and the clamp were picked against the synthetic fixtures, not
  measured against real sensors on a real screen. Both are one-line changes.
```

Under `## The card page costs more flash than budgeted`, replace the first two sentences with the measured figures from Step 1, in the form: `The Cards tab now costs N bytes against a design expectation of under 15 KB. The grid redesign moved it by M bytes.` Leave the rest of that section as it stands.

- [ ] **Step 4: Delete the spec and this plan**

```bash
git rm docs/superpowers/specs/2026-08-13-card-grid-redesign.md
git rm docs/superpowers/plans/2026-08-13-card-grid-redesign.md
```

- [ ] **Step 5: Verify before claiming completion**

```bash
npx playwright test
git status --short
```
Expected: every test passes; the only remaining changes are the ones staged in this task.

- [ ] **Step 6: Commit**

```bash
git add README.md docs/backlog.md
git commit -m "Document the card grid and record its flash cost"
```
