# Mobile card grid cap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cap the dashboard's rendered column count on narrow viewports so a phone gets legible cards, without changing the layout the browser saves.

**Architecture:** `grid.js` derives a view column count from viewport width (`MIN_CELL = 110`), clamped by the saved `cardState.grid.cols`. Rendering and gestures read the derived value; `deriveTemplate()`, `postLayout()`, and everything that persists keep reading the saved one. Three `style.css` fixes reserve the bottom band, ellipsize long field names, and widen the label cap.

**Tech Stack:** Preact + `@preact/signals`, esbuild bundle (`build.js`), Playwright specs (`test/*.spec.js`) and `node:test` unit tests (`test/*.test.js`).

## Global Constraints

- Working directory for every command is `dashboard/`. Paths in this plan are relative to it unless they start with `docs/superpowers/`, which is repo-root.
- `MIN_CELL = 110` exactly. It is the number that gives a 390 px phone 3 columns.
- The saved layout is untouched: `cardState`, `deriveTemplate()`, `postLayout()`, `applyTemplate()`, the `$layout` payload shape, the receiver and the bridge get no changes.
- `1rem = 16px` (`:root` sets no font-size; `body`'s 14px does not affect rem).
- Playwright's default viewport is 1280×720, where the cap is inert. Any spec that needs the cap must set the viewport itself.
- Run the full suite with `node --run test` (`node --test test/*.test.js && playwright test`). A single spec: `npx playwright test test/<file>.spec.js`.
- Comments follow the repo rule: say why, never what, one or two lines, and only when the code cannot say it.
- Never open a pull request. Commit to the current branch (`mobile-grid-cap`).

---

### Task 1: The view column count

**Files:**
- Modify: `src/grid.js:7-31` (add `MIN_CELL`, `viewCols`, `viewColsSignal`; rewrite `measureGrid`)
- Modify: `src/main.jsx:184-190` (expose `viewCols` to tests)
- Modify: `test/cards.spec.js:383-425` (two existing tests whose arithmetic the cap changes)
- Test: `test/mobile-grid.spec.js` (create)

**Model:** `sonnet` — multi-file, and two existing tests have to be re-reasoned rather than transcribed.

**Interfaces:**
- Produces: `viewCols(): number` and `viewColsSignal` (a `@preact/signals` `signal`) exported from `src/grid.js`. `viewCols()` returns the last value `measureGrid()` computed, initially `6`. Also `window.viewCols` (getter, reads `viewColsSignal.value`) for specs.
- Consumes: `gridSize()` from `./store.js` (already imported), returning `{ cols, rows }`.

- [ ] **Step 1: Write the failing spec**

Create `test/mobile-grid.spec.js`:

```js
import { test, expect } from "@playwright/test";
import { startServer } from "./harness.js";
import { ACURITE, topicOf } from "./fixtures.js";

const ACURITE_KEY = topicOf(ACURITE);
const CARD = `.card:not(.ghostcard)[data-key$="${ACURITE_KEY}"]`;

let server;

test.afterEach(async () => { if (server) await server.close(); server = null; });

async function open(page) {
  server = await startServer({ devices: [ACURITE] });
  await page.goto(server.url);
  await expect(page.locator("#status")).toHaveText(/^live/);
  await page.evaluate(() => {
    setHideNewCards(false);
    cardState = { ...cardState, hidden: [] };
    saveCardState();
  });
  await expect(page.locator(CARD)).toBeVisible();
}

function columnCount(page) {
  return page.evaluate(() =>
    getComputedStyle(document.getElementById("cards")).gridTemplateColumns.split(/\s+/).length);
}

test("a 390px viewport renders three columns", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await page.waitForTimeout(120);

  expect(await page.evaluate(() => viewCols)).toBe(3);
  expect(await columnCount(page)).toBe(3);
});

test("a desktop viewport still renders the saved six columns", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page);
  await page.waitForTimeout(120);

  expect(await page.evaluate(() => viewCols)).toBe(6);
  expect(await columnCount(page)).toBe(6);
});

test("a capped grid sizes its cell from width alone and scrolls instead", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await page.waitForTimeout(120);

  const m = await page.evaluate(() => {
    const g = document.getElementById("cards");
    const cs = getComputedStyle(g);
    return {
      cell: cellSide,
      width: g.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
      rows: cs.gridTemplateRows,
    };
  });
  expect(m.cell).toBeCloseTo(m.width / 3, 1);
  expect(m.rows.split(/\s+/).length).not.toBe(4);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx playwright test test/mobile-grid.spec.js`
Expected: FAIL — `viewCols` is not defined on `window`, and the grid renders 6 columns at 390 px.

- [ ] **Step 3: Add the view column count to `src/grid.js`**

Replace lines 7-31 of `src/grid.js` with:

```js
let cell = 150

export function cellSide() { return cell }

export const cellSignal = signal(cell)

// The width below which a cell stops being legible: at 110px a 390px phone
// gets 3 columns rather than the 6 the saved desktop layout asks for.
const MIN_CELL = 110

let viewColsN = 6

export function viewCols() { return viewColsN }

export const viewColsSignal = signal(viewColsN)

export function measureGrid() {
  const grid = $("cards")
  if (!grid || grid.clientWidth <= 0) return
  const g = gridSize()
  const cs = getComputedStyle(grid)
  const width = grid.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
  // rect.top is viewport-relative, so scroll position would shift the fit.
  const top = grid.getBoundingClientRect().top + window.scrollY
  const height = window.innerHeight - top
                 - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)
  const cols = Math.max(1, Math.min(Math.floor(width / MIN_CELL), g.cols))
  viewColsN = cols
  viewColsSignal.value = cols
  if (cols < g.cols) {
    // Fewer columns means more rows than the screen holds. Fitting them all is
    // what produced the unreadable cell; the page scrolls instead.
    cell = width / cols
  } else {
    // The 20px floor is a legibility minimum, not a guarantee: honoring it when
    // the viewport can't fit g.cols at 20px would overflow the page sideways.
    const fit = Math.min(width / cols, height / g.rows)
    cell = width / cols >= 20 ? Math.max(20, fit) : fit
  }
  cellSignal.value = cell
  grid.style.setProperty("--cell", cell + "px")
  grid.style.gridTemplateColumns = "repeat(" + cols + ",var(--cell))"
  grid.style.gridTemplateRows = cols < g.cols ? "" : "repeat(" + g.rows + ",var(--cell))"
}
```

- [ ] **Step 4: Expose `viewCols` to specs**

In `src/main.jsx`, the import on line 15 currently reads:

```js
import { measureGrid, installGestures, cellSignal, fitValues, dragging, resizing, gestureInFlight } from './grid.js'
```

Change it to:

```js
import { measureGrid, installGestures, cellSignal, viewColsSignal, fitValues, dragging, resizing, gestureInFlight } from './grid.js'
```

and in the `Object.defineProperties(window, { ... })` block, directly after the `cellSide` line, add:

```js
    viewCols: { get: () => viewColsSignal.value },
```

- [ ] **Step 5: Run the new spec**

Run: `npx playwright test test/mobile-grid.spec.js`
Expected: PASS, 3 tests.

- [ ] **Step 6: Run the whole suite to find what the cap moved**

Run: `node --run test`
Expected: FAIL in `test/cards.spec.js` — two tests. At 640×900 the usable width is about 593 px, so `floor(593/110) = 5` and the grid no longer renders 6 columns; and at 360 px wide with 24 columns the grid caps to 2 columns, so the 20 px floor is not reached.

- [ ] **Step 7: Update the cell-side test to widths where the cap is inert**

In `test/cards.spec.js`, in the test named `the cell side is the smaller of the two divisions and re-measures on resize`, change the loop's viewport list:

```js
  for (const [w, h] of [[1200, 800], [900, 900], [1400, 500]]) {
```

(`640` becomes `900`: at 900 px the usable width is about 853 px and `floor(853/110) = 7`, which clamps back to the saved 6, so the old arithmetic still holds.)

- [ ] **Step 8: Update the overflow test to assert the invariant, not the old column count**

In `test/cards.spec.js`, replace the whole test named `the 20px floor never overflows the viewport width` with:

```js
test("the rendered grid never overflows the viewport width", async ({ page }) => {
  await open(page, [ACURITE]);
  await page.setViewportSize({ width: 360, height: 800 });
  await setGrid(page, 24, 4);
  await page.waitForTimeout(120);

  const m = await page.evaluate(() => {
    const g = document.getElementById("cards");
    const cs = getComputedStyle(g);
    return {
      cell: cellSide,
      cols: viewCols,
      width: g.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
    };
  });
  expect(m.cols).toBeLessThan(24);
  expect(m.cell * m.cols).toBeLessThanOrEqual(m.width + 0.5);
});
```

- [ ] **Step 9: Run the whole suite**

Run: `node --run test`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/grid.js src/main.jsx test/mobile-grid.spec.js test/cards.spec.js
git commit -m "feat(dashboard): cap the rendered column count on narrow viewports"
```

---

### Task 2: Cards and the resize handle read the view column count

**Files:**
- Modify: `src/cards.jsx:9-10` (import), `src/cards.jsx:17-20` (signal read), `src/cards.jsx:82-84` (span clamp)
- Modify: `src/grid.js:246-254` (`resizeMove` clamps to `viewCols()`)
- Test: `test/mobile-grid.spec.js` (append two tests)

**Model:** `sonnet` — two files plus signal-subscription reasoning about a memoized component.

**Interfaces:**
- Consumes: `viewCols()` and `viewColsSignal` from Task 1.
- Produces: nothing new. `Card` renders `gridColumn: span min(c.w, viewCols())`; a resize drag cannot exceed `viewCols()`.

- [ ] **Step 1: Write the failing tests**

Append to `test/mobile-grid.spec.js`:

```js
test("a card wider than the cap renders at the cap", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await page.evaluate(k => setCardSize(k, 5, 2), await page.evaluate(() =>
    Object.keys(cardState.cards).find(k => k.includes("Acurite"))));
  await page.waitForTimeout(120);

  await expect(page.locator(CARD)).toHaveCSS("grid-column", /span 3/);
});

test("a card wider than the cap keeps its stored width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  const key = await page.evaluate(() =>
    Object.keys(cardState.cards).find(k => k.includes("Acurite")));
  await page.evaluate(k => setCardSize(k, 5, 2), key);
  await page.waitForTimeout(120);

  const c = await page.evaluate(k => cardState.cards[k], key);
  expect(c.w).toBe(5);
});
```

- [ ] **Step 2: Run to verify the first fails**

Run: `npx playwright test test/mobile-grid.spec.js`
Expected: FAIL — the card renders `span 5`, overflowing the 3-column grid. The second test passes already and is there to pin that the clamp is render-only.

- [ ] **Step 3: Clamp the rendered span**

In `src/cards.jsx`, change the import on lines 8-10 to add `viewCols` and `viewColsSignal`:

```js
import { editing, renaming, dragging, resizing, gestureInFlight,
         measureGrid, fitValues, textWidthEm, cellSignal, viewCols, viewColsSignal,
         trackFit, beginDrag, beginResize, setRenaming, currentDrag, currentResize } from './grid.js'
```

In `CardsView`, beside the existing signal reads (lines 17-20), add `viewColsSignal.value` so a change in the cap re-renders the grid:

```js
  // Read cellSignal and cardState to trigger re-render on changes
  cellSignal.value
  viewColsSignal.value
  cardState.value
  settings.value
```

In `Card` (lines 82-84), replace:

```js
  const g = cardState.value.grid
  const w = Math.max(1, Math.min(c.w, g.cols))
  const h = Math.max(1, Math.min(c.h, g.rows))
```

with:

```js
  const g = cardState.value.grid
  const w = Math.max(1, Math.min(c.w, viewCols()))
  const h = Math.max(1, Math.min(c.h, g.rows))
```

- [ ] **Step 4: Clamp the resize gesture**

In `src/grid.js`, in `resizeMove`, replace:

```js
  const g = gridSize()
  r.w = Math.max(1, Math.min(g.cols, r.w0 + Math.round((ev.clientX - r.x0) / cell)))
  r.h = Math.max(1, Math.min(g.rows, r.h0 + Math.round((ev.clientY - r.y0) / cell)))
```

with:

```js
  const g = gridSize()
  // A card cannot be dragged wider than the grid on screen.
  r.w = Math.max(1, Math.min(viewCols(), r.w0 + Math.round((ev.clientX - r.x0) / cell)))
  r.h = Math.max(1, Math.min(g.rows, r.h0 + Math.round((ev.clientY - r.y0) / cell)))
```

- [ ] **Step 5: Run the spec and then the suite**

Run: `npx playwright test test/mobile-grid.spec.js`
Expected: PASS, 5 tests.

Run: `node --run test`
Expected: PASS. The existing resize tests in `test/cards.spec.js` run at the default 1280×720 viewport, where `viewCols()` equals the saved `g.cols`, so their clamps are unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/cards.jsx src/grid.js test/mobile-grid.spec.js
git commit -m "feat(dashboard): render and resize cards against the view column count"
```

---

### Task 3: The three card style fixes

**Files:**
- Modify: `src/style.css:52-53` (`.card` padding), `src/style.css:54` (`.card .lbl` max-width), `src/style.css:71-86` (`.fn` children)
- Test: `test/mobile-grid.spec.js` (append two tests)

**Model:** `sonnet` — the CSS edits are verbatim, but the rectangle-intersection spec needs judgment about which elements to compare.

**Interfaces:**
- Consumes: `CARD`, `open()`, and the `server` fixture already defined at the top of `test/mobile-grid.spec.js` by Task 1.
- Produces: nothing other tasks read.

- [ ] **Step 1: Write the failing tests**

Append to `test/mobile-grid.spec.js`:

```js
test("the bottom strip is not drawn through the values", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await page.waitForTimeout(120);

  const overlaps = await page.evaluate(() => {
    const bad = [];
    for (const card of document.querySelectorAll("#cards .card")) {
      const body = card.querySelector(".body");
      for (const sel of [".btm", ".age"]) {
        const node = card.querySelector(sel);
        if (!body || !node) continue;
        const a = body.getBoundingClientRect(), b = node.getBoundingClientRect();
        const hit = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
        if (hit) bad.push(card.dataset.key + " " + sel);
      }
    }
    return bad;
  });
  expect(overlaps).toEqual([]);
});

test("a long field name ellipsizes rather than clipping mid-word", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await page.waitForTimeout(120);

  const styles = await page.locator("#cards .card .fn > span:first-child").evaluateAll(
    els => els.map(e => getComputedStyle(e).textOverflow));
  expect(styles.length).toBeGreaterThan(0);
  expect(styles.every(s => s === "ellipsis")).toBe(true);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx playwright test test/mobile-grid.spec.js`
Expected: FAIL on both — `.body` is `height:100%` over the whole content box so it overlaps `.btm` and `.age`, and `.fn > span:first-child` computes `text-overflow: clip`.

- [ ] **Step 3: Reserve the bottom band**

In `src/style.css`, change:

```css
.card { position:relative; margin:.35rem; border:1px solid var(--line); border-radius:.7rem;
        padding:.5rem .45rem .6rem; }
```

to:

```css
/* The bottom padding reserves the band .btm and .age are absolutely placed in;
   .body is height:100% over what is left. .age is on every card. */
.card { position:relative; margin:.35rem; border:1px solid var(--line); border-radius:.7rem;
        padding:.5rem .45rem 1.15rem; }
```

- [ ] **Step 4: Widen the label cap**

In the same file, in the `.card .lbl` rule, change `max-width:calc(100% - 1.4rem)` to `max-width:calc(100% - .9rem)`. The rule becomes:

```css
.card .lbl { position:absolute; top:-.65em; right:.7rem; max-width:calc(100% - .9rem);
             padding:0 .4rem; background:Canvas; font-size:.75rem;
             display:flex; align-items:baseline; overflow:hidden;
             pointer-events:auto; z-index:1; }
```

- [ ] **Step 5: Ellipsize the field name**

In the same file, directly after the `.card .fn { ... }` rule, add:

```css
.card .fn > span:first-child {
  min-width:0;
  overflow:hidden;
  text-overflow:ellipsis;
}
```

and in the `.card .fn .u { ... }` rule add `flex:0 0 auto;`, so it reads:

```css
.card .fn .u { 
  font-weight:inherit; 
  color:inherit; 
  opacity:inherit; 
  margin-left:.5em; 
  flex:0 0 auto;
}
```

- [ ] **Step 6: Run the spec and then the suite**

Run: `npx playwright test test/mobile-grid.spec.js`
Expected: PASS, 7 tests.

Run: `node --run test`
Expected: PASS. If a font-fit assertion in `test/fontfit.spec.js` or `test/cards.spec.js` moves, it is because the taller bottom padding shrinks the value box; report the exact failing assertion rather than loosening it.

- [ ] **Step 7: Commit**

```bash
git add src/style.css test/mobile-grid.spec.js
git commit -m "fix(dashboard): reserve the card's bottom band and ellipsize long field names"
```

---

### Task 4: A capped view cannot rewrite the site default

**Files:**
- Modify: `src/main.jsx` (expose `deriveTemplate` to specs)
- Test: `test/mobile-grid.spec.js` (append one test)

**Model:** `haiku` — one import line, one exposure line, one test, all given verbatim.

**Interfaces:**
- Consumes: `deriveTemplate()` from `src/layout_template.js`, which returns `{ grid: { cols, rows }, order, models }`.
- Produces: `window.deriveTemplate`.

Note: the spec calls this a unit test. It is written as a Playwright assertion instead, because the guarantee is that `deriveTemplate()` reads the saved grid *while the view is capped*, and only a real viewport produces a cap. A `node:test` version could not observe the cap at all.

- [ ] **Step 1: Write the failing test**

Append to `test/mobile-grid.spec.js`:

```js
test("saving from a capped view writes the saved column count, not the cap", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await page.waitForTimeout(120);

  const m = await page.evaluate(() => ({ view: viewCols, template: deriveTemplate() }));
  expect(m.view).toBe(3);
  expect(m.template.grid.cols).toBe(6);
  expect(m.template.grid.rows).toBe(4);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx playwright test test/mobile-grid.spec.js -g "capped view writes"`
Expected: FAIL — `deriveTemplate is not defined`.

- [ ] **Step 3: Expose `deriveTemplate`**

In `src/main.jsx`, add an import beside the other `src` imports:

```js
import { deriveTemplate } from './layout_template.js'
```

and add `deriveTemplate` to the `Object.assign(window, { ... })` list, on the line that already carries `measureGrid, fmtValue, fitValues,`:

```js
    measureGrid, fmtValue, fitValues, deriveTemplate,
```

- [ ] **Step 4: Run the spec and then the suite**

Run: `npx playwright test test/mobile-grid.spec.js`
Expected: PASS, 8 tests.

Run: `node --run test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main.jsx test/mobile-grid.spec.js
git commit -m "test(dashboard): a capped view still derives the saved six-column template"
```

---

### Task 5: Documentation, and delete the spec

**Files:**
- Modify: `docs/architecture.md` (a `## Grid sizing` section after `## Modules`, before `## Drag zones`)
- Modify: `docs/backlog.md` (one entry)
- Delete: `docs/superpowers/specs/2026-08-25-mobile-grid-cap-design.md` (repo-root)
- Delete: `docs/superpowers/plans/2026-08-25-mobile-grid-cap.md` (repo-root — this plan)

**Model:** `haiku` — prose given verbatim, plus two deletions.

**Interfaces:**
- Consumes: nothing. Runs last.
- Produces: nothing.

- [ ] **Step 1: Add the architecture section**

In `dashboard/docs/architecture.md`, insert this immediately before the `## Drag zones` heading:

```markdown
## Grid sizing

`measureGrid()` in `grid.js` derives a view column count from the viewport:
`clamp(1, floor(usableWidth / 110), grid.cols)`. 110px is the width below which
a cell stops being legible; at any desktop width the clamp lands on the saved
`grid.cols` and the derived count is inert.

The derived count is separate from the saved `cardState.grid.cols`, and only
rendering reads it: the card's rendered span, the resize gesture's upper bound,
and `gridTemplateColumns`. `deriveTemplate()` reads `cardState` directly, so
saving a layout from a phone writes the same template as saving from a desktop
rather than pushing 3 columns onto every other browser, and a card moved or
resized on the phone still applies to the real grid.

When the derived count is below the saved one, the cell is sized from width
alone rather than from `min(width/cols, height/rows)`, and `gridTemplateRows` is
left to `grid-auto-rows`. Fewer columns means more rows than a phone screen
holds, and shrinking the cell until they all fit is what made cards illegible in
the first place. The page scrolls instead.

`.card`'s bottom padding reserves the band `.btm` and `.age` are absolutely
placed in. `.body` is `height:100%` of what is left, so the bottom row is not
drawn through the values at any cell size.
```

- [ ] **Step 2: Add the backlog entry**

Append to the list in `dashboard/docs/backlog.md`:

```markdown
- The view column cap is derived from width alone. A landscape phone gets the same 3
  columns a portrait one does at the same width, and a very short window still scrolls
  rather than fitting.
```

- [ ] **Step 3: Delete the working documents**

```bash
git rm ../docs/superpowers/specs/2026-08-25-mobile-grid-cap-design.md
git rm ../docs/superpowers/plans/2026-08-25-mobile-grid-cap.md
```

- [ ] **Step 4: Run the whole suite one more time**

Run: `node --run test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docs/architecture.md docs/backlog.md
git commit -m "docs(dashboard): the view column cap and the reserved bottom band"
```
