# Drag-and-drop active targets implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make dashboard drag-and-drop predictable with visible active drop targets and distinct drag ghosts for cards and values.

**Architecture:** Add an absolutely positioned overlay layer that contains drop-zone elements computed from the current card/value rectangles. Only the zone nearest the pointer is highlighted. The existing `moveCard`/`moveValue` logic is reused, but the drop target is read from the active zone's data attribute instead of from midpoint distance.

**Tech Stack:** Vanilla JS (pointer events), CSS, Playwright tests.

## Global Constraints

- Rendering is suppressed while a drag is in flight (`gestureInFlight()`), so drag artifacts must be created and removed via direct DOM manipulation, not through React/render state.
- Drop zones must only exist for the type being dragged: card drag = card-level zones only; value drag = value-level zones inside the source card only.
- Only the active target zone is visibly rendered.

---

### Task 1: Add drop-layer helpers and zone creation

**Files:**
- Modify: `dashboard/src/grid.js`
- Test: `dashboard/test/cards.spec.js` (existing drag tests should still pass)

**Interfaces:**
- Consumes: `el()` from `./units.js`
- Produces: `createDropLayer(container, kind)`, `cardDropZones(layer)`, `valueDropZones(card, layer)`, `clearDropZones()`

- [ ] **Step 1: Import `el` from `units.js`**

```javascript
// dashboard/src/grid.js
import { splitUnit, el } from './units.js'
```

- [ ] **Step 2: Add helper functions above `beginDrag`**

```javascript
function makeZone(layer, left, top, width, height, before) {
  const z = el('div', 'drop-zone')
  z.style.position = 'absolute'
  z.style.left = left + 'px'
  z.style.top = top + 'px'
  z.style.width = Math.max(0, width) + 'px'
  z.style.height = Math.max(0, height) + 'px'
  z.dataset.before = before
  layer.append(z)
  return z
}

function createDropLayer(container, kind) {
  const layer = el('div', 'drop-layer ' + kind + '-layer')
  const r = container.getBoundingClientRect()
  layer.style.position = 'fixed'
  layer.style.left = r.left + 'px'
  layer.style.top = r.top + 'px'
  layer.style.width = r.width + 'px'
  layer.style.height = r.height + 'px'
  layer.style.pointerEvents = 'none'
  layer.style.zIndex = '4'
  document.body.append(layer)
  return layer
}

function clearDropZones() {
  document.querySelectorAll('.drop-layer').forEach(n => n.remove())
}
```

- [ ] **Step 3: Add zone creation functions**

```javascript
function cardDropZones(layer) {
  const cards = [...document.querySelectorAll('#cards .card')]
  if (!cards.length) return []
  const gridRect = document.getElementById('cards').getBoundingClientRect()

  // Group cards by visual row.
  const rows = []
  for (const card of cards) {
    const r = card.getBoundingClientRect()
    const row = rows.find(row => Math.abs(row.top - r.top) < 5)
    if (row) row.cards.push({ card, rect: r })
    else rows.push({ top: r.top, cards: [{ card, rect: r }] })
  }
  rows.sort((a, b) => a.top - b.top)
  for (const row of rows) row.cards.sort((a, b) => a.rect.left - b.rect.left)

  const zones = []
  const first = rows[0].cards[0].rect
  zones.push(makeZone(layer, gridRect.left, first.top, first.left - gridRect.left, first.height, rows[0].cards[0].card.dataset.key))

  const lastRow = rows[rows.length - 1]
  const last = lastRow.cards[lastRow.cards.length - 1]
  zones.push(makeZone(layer, last.rect.right, last.rect.top, gridRect.right - last.rect.right, last.rect.height, ''))

  for (const row of rows) {
    for (let i = 0; i < row.cards.length - 1; i++) {
      const a = row.cards[i].rect
      const b = row.cards[i + 1].rect
      zones.push(makeZone(layer, a.right, a.top, b.left - a.right, a.height, b.card.dataset.key))
    }
  }

  for (let i = 0; i < rows.length - 1; i++) {
    const tops = rows[i].cards.map(c => c.rect.bottom)
    const bottoms = rows[i + 1].cards.map(c => c.rect.top)
    const y = Math.max(...tops)
    const y2 = Math.min(...bottoms)
    zones.push(makeZone(layer, gridRect.left, y, gridRect.width, y2 - y, rows[i + 1].cards[0].card.dataset.key))
  }

  return zones
}

function valueDropZones(card, layer) {
  const values = [...card.querySelectorAll('.val')]
  if (!values.length) return []
  const bodyRect = card.querySelector('.body').getBoundingClientRect()

  // Values are in a CSS grid. Adjacent cells share an edge.
  const cells = values.map(v => ({ v, r: v.getBoundingClientRect() }))
  const zones = []

  // Before first value: a strip at the body edge. Use the first cell's edge.
  const first = cells[0].r
  zones.push(makeZone(layer, bodyRect.left, bodyRect.top, first.left - bodyRect.left, bodyRect.height, values[0].dataset.f))

  // After last value.
  const last = cells[cells.length - 1].r
  zones.push(makeZone(layer, last.right, bodyRect.top, bodyRect.right - last.right, bodyRect.height, ''))

  // Between horizontally adjacent values.
  for (let i = 0; i < cells.length; i++) {
    for (let j = i + 1; j < cells.length; j++) {
      const a = cells[i].r
      const b = cells[j].r
      if (Math.abs(a.right - b.left) < 3 && a.top === b.top) {
        zones.push(makeZone(layer, a.right, a.top, b.left - a.right, a.height, b.v.dataset.f))
      }
    }
  }

  // Between vertically adjacent values.
  for (let i = 0; i < cells.length; i++) {
    for (let j = i + 1; j < cells.length; j++) {
      const a = cells[i].r
      const b = cells[j].r
      if (Math.abs(a.bottom - b.top) < 3 && a.left === b.left) {
        zones.push(makeZone(layer, a.left, a.bottom, a.width, b.top - a.bottom, b.v.dataset.f))
      }
    }
  }

  return zones
}
```

- [ ] **Step 4: Run existing drag tests**

Run: `cd dashboard && npx playwright test test/cards.spec.js -g "dragging a card reorders"`
Expected: PASS (no behavior changed yet)

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/grid.js
git commit -m "feat(dashboard): add drop-zone helper functions"
```

---

### Task 2: Highlight active zone and use it on drop

**Files:**
- Modify: `dashboard/src/grid.js`

**Interfaces:**
- Consumes: `createDropLayer`, `cardDropZones`, `valueDropZones`, `clearDropZones`
- Produces: updated `dragMove`, `endDrag`, and dragging state holding `zones`

- [ ] **Step 1: Extend dragging state and ghost creation**

In `dragMove`, after `d.node.classList.add("lifting")`:

```javascript
d.zones = d.field
  ? valueDropZones(d.card, createDropLayer(d.card.querySelector('.body'), 'value'))
  : cardDropZones(createDropLayer(document.getElementById('cards'), 'card'))
```

- [ ] **Step 2: Add active-zone update on pointer move**

Add after the ghost positioning in `dragMove`:

```javascript
let active = null
let best = Infinity
for (const z of d.zones || []) {
  const r = z.getBoundingClientRect()
  const cx = r.left + r.width / 2
  const cy = r.top + r.height / 2
  const dist = Math.hypot(ev.clientX - cx, ev.clientY - cy)
  if (dist < best) { best = dist; active = z }
}
for (const z of d.zones || []) z.classList.toggle('active', z === active)
```

- [ ] **Step 3: Replace midpoint drop logic with active zone**

Replace the body of `endDrag` with:

```javascript
function endDrag(ev) {
  const d = dragging
  if (!d || ev.pointerId !== d.pointerId) return
  dragging = null
  d.card.cancelPress()
  if (d.ghost) d.ghost.remove()
  d.node.classList.remove('lifting')

  if (d.moved && d.zones) {
    const active = d.zones.find(z => z.classList.contains('active'))
    if (active) {
      const before = active.dataset.before || null
      if (d.field) moveValue(d.key, d.field, before)
      else moveCard(d.key, before)
    }
  }
  clearDropZones()
  requestRender()
}
```

- [ ] **Step 4: Run existing drag tests**

Run: `cd dashboard && npx playwright test test/cards.spec.js -g "dragging"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/grid.js
git commit -m "feat(dashboard): highlight active drop zone and drop onto it"
```

---

### Task 3: Style drop zones and distinguish card/value ghosts

**Files:**
- Modify: `dashboard/src/style.css`
- Modify: `dashboard/src/grid.js` (ghost class)

- [ ] **Step 1: Set ghost class based on drag type**

In `dragMove`, replace the ghost creation line with:

```javascript
const ghostCls = 'ghostcard ' + (d.field ? 'value-ghost' : 'card-ghost')
d.ghost = el('div', ghostCls, d.field ? splitUnit(d.field).name : displayName(d.key))
```

- [ ] **Step 2: Add CSS for drop layers, zones, and ghosts**

Append to `dashboard/src/style.css`:

```css
.drop-layer { position:fixed; left:0; top:0; right:0; bottom:0; pointer-events:none; z-index:4; }
.drop-zone { opacity:0; transition:opacity .1s; }
.drop-zone.active { opacity:1; }

.card-layer .drop-zone.active {
  border-radius:.35rem;
  background:color-mix(in srgb, Highlight 25%, transparent);
  outline:2px solid Highlight;
}

.value-layer .drop-zone.active {
  background:Highlight;
  border-radius:.2rem;
}

.ghostcard { position:fixed; z-index:5; pointer-events:none; opacity:.85;
             border:1px solid var(--line); border-radius:.7rem; background:Canvas;
             padding:.4rem .7rem; font-size:.85rem; box-shadow:0 4px 12px #0003; }
.ghostcard.card-ghost { min-width:6rem; text-align:center; font-weight:600; }
.ghostcard.value-ghost { font-size:.75rem; opacity:.9; }
```

- [ ] **Step 3: Run visual smoke test**

Run: `cd dashboard && npx playwright test test/cards.spec.js -g "dragging a card reorders" --headed`
Expected: See a ghost card and a highlighted drop zone while dragging.

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/grid.js dashboard/src/style.css
git commit -m "feat(dashboard): style active drop zones and distinct drag ghosts"
```

---

### Task 4: Add tests for zone isolation and visibility

**Files:**
- Modify: `dashboard/test/cards.spec.js`

- [ ] **Step 1: Add helper that drags to a midpoint and returns zones**

```javascript
async function activeZones(page) {
  return page.evaluate(() => ({
    card: document.querySelectorAll('.drop-layer.card-layer .drop-zone.active').length,
    value: document.querySelectorAll('.drop-layer.value-layer .drop-zone.active').length,
  }))
}
```

- [ ] **Step 2: Add test for card-drag zone isolation**

After the existing card reorder test:

```javascript
test("card drag shows only card-level drop zones", async ({ page }) => {
  await open(page, [ACURITE, OREGON, THERMO]);
  await edit(page);
  const box = await page.locator(CARD + " .lbl").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 80, box.y + 40, { steps: 5 });

  await expect(page.locator(".drop-layer")).toHaveCount(1);
  const zones = await activeZones(page);
  expect(zones.card).toBe(1);
  expect(zones.value).toBe(0);

  await page.mouse.up();
  await expect(page.locator(".drop-layer")).toHaveCount(0);
});
```

- [ ] **Step 3: Add test for value-drag zone isolation**

```javascript
test("value drag shows only value-level drop zones in the source card", async ({ page }) => {
  await open(page, [ACURITE, OREGON]);
  await edit(page);
  const from = await page.locator(CARD + ' .val[data-f="temperature_F"]').boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 20, from.y + 20, { steps: 5 });

  await expect(page.locator(".drop-layer")).toHaveCount(1);
  const zones = await activeZones(page);
  expect(zones.card).toBe(0);
  expect(zones.value).toBe(1);

  await page.mouse.up();
  await expect(page.locator(".drop-layer")).toHaveCount(0);
});
```

- [ ] **Step 4: Run new tests**

Run: `cd dashboard && npx playwright test test/cards.spec.js -g "drop zones"`
Expected: PASS

- [ ] **Step 5: Run full dashboard test suite**

Run: `cd dashboard && npm test`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add dashboard/test/cards.spec.js
git commit -m "test(dashboard): assert card and value drop zones are isolated"
```

---

### Task 5: Update user-facing documentation

**Files:**
- Modify: `dashboard/docs/user-manual.md`

- [ ] **Step 1: Add a drag-and-drop section**

Add after the "The page" section:

```markdown
## Drag-and-drop in edit mode

In edit mode, press and drag a card's label to reorder cards. Press and drag a
value inside a card to reorder values within that card. While dragging, a ghost
shows what is being moved and the active drop zone highlights where it will land.
```

- [ ] **Step 2: Commit**

```bash
git add dashboard/docs/user-manual.md
git commit -m "docs(dashboard): describe edit-mode drag and drop"
```

---

## Self-review

**Spec coverage:**
- Drag ghost distinction → Task 3.
- Drop zones before first/between/after → Task 1 zone creation and Task 2 active highlighting.
- Context-aware active zones → Task 1 functions create only the relevant zone type; Task 4 tests verify isolation.
- Drop uses active zone → Task 2 endDrag.

**Placeholder scan:** No TBD/TODO/fill-in-details found.

**Type consistency:** `dragging.zones` is added consistently in Task 2 and used in Task 2 and Task 3. `dataset.before` is read as a string and converted to `null` when empty in both card and value paths.
