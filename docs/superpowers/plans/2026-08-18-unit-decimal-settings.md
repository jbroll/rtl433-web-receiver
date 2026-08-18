# Unit and Decimal Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Global, display-only unit conversion and decimal formatting for temperature, rain, wind, and pressure, with a Settings section on the devices tab.

**Architecture:** A new `dashboard/src/settings.js` owns a `settings` signal persisted under the `rtl433.settings.v1` localStorage key. `dashboard/src/units.js` gains a pure `displayValue(field, raw, settings)` that converts each unit group through a canonical unit and formats with a decimals-aware `fmtValue`. `Value` in `cards.jsx` and the reading column in `devices-table.jsx` render through `displayValue`; a `<details>` Settings section at the top of the devices tab edits the signal.

**Tech Stack:** Plain JavaScript, Preact, `@preact/signals`, `node:test`, Playwright.

## Global Constraints

- Stored `merged` data is never modified; conversion and formatting happen only in `displayValue`.
- Settings are global, keyed `rtl433.settings.v1`, with the exact shape `{ units: "metric"|"imperial"|"custom", decimals: 0-5, custom: { temp, rain, wind, pressure } }` from the spec.
- Presets set all four groups at once; `custom` mode reads the four fields.
- Metric preset: C, mm, km/h, hPa. Imperial preset: F, in, mi/h, hPa.
- Applied everywhere readings render: cards tab (`Value` and the bottom strip) and the devices table reading column.
- NOT in scope: per-device overrides, showing both original and converted units, firmware conversion, and the pre-existing failures at `cards.spec.js:1019` and `:1045` — leave those two tests untouched and failing.
- Verified baseline (main, before this work): 8 pre-existing Playwright failures that must remain untouched and failing: `cards.spec.js:142`, `:420`, `:486`, `:1019`, `:1045`, `:1248`, `debug-device-values7.spec.js`, `debug-sweep.spec.js`. Every other test passes.
- Test commands, run from `dashboard/`: unit tests `node --test test/*.test.js`; one spec `npx playwright test test/<file>.spec.js -g "<substring>"`; full suite `npx playwright test`.
- Commit after each task.

---

### Task 1: `fmtValue(v, decimals)` and `displayValue` in `units.js`

**Files:**
- Modify: `dashboard/src/units.js`
- Modify: `dashboard/test/units.test.js`
- Modify: `dashboard/test/cards.spec.js:1034-1043`

**Interfaces:**
- Consumes: the existing `splitUnit(field) -> { name, unit }` table.
- Produces: `fmtValue(v, decimals) -> string` and `displayValue(field, raw, settings) -> { name, num, unit }`. Tasks 3 and 4 call `displayValue` with `settings.value` from `dashboard/src/settings.js` (Task 2). `displayValue` reads `settings.decimals` and `settings.custom[group]` where `custom` values are the spec labels `C|F`, `mm|in`, `mi/h|km/h|m/s`, `hPa|kPa`.

- [ ] **Step 1: Replace and extend the fmtValue tests in `units.test.js`**

Replace the test at `test/units.test.js:13-18` and add the conversion and pass-through tests below, then import `displayValue`.

```js
import { splitUnit, fmtValue, displayValue, ageText, readings, mergeReadings } from '../src/units.js'

const METRIC = { decimals: 1, custom: { temp: 'C', rain: 'mm', wind: 'km/h', pressure: 'hPa' } }
const IMPERIAL = { decimals: 1, custom: { temp: 'F', rain: 'in', wind: 'mi/h', pressure: 'hPa' } }
```

```js
test('fmtValue rounds to the requested decimals and trims trailing zeros', () => {
  assert.equal(fmtValue(71.23456789, 0), '71')
  assert.equal(fmtValue(71.23456789, 1), '71.2')
  assert.equal(fmtValue(71.23456789, 2), '71.23')
  assert.equal(fmtValue(71.23456789, 3), '71.235')
  assert.equal(fmtValue(71.23456789, 4), '71.2346')
  assert.equal(fmtValue(71.23456789, 5), '71.23457')
  assert.equal(fmtValue(3.000, 2), '3')
  assert.equal(fmtValue(-4.5678, 2), '-4.57')
  assert.equal(fmtValue('CRC', 2), 'CRC')
  assert.equal(fmtValue(true, 2), 'true')
})

test('temperature converts between Fahrenheit and Celsius', () => {
  assert.deepEqual(displayValue('temperature_F', 71.2, METRIC), { name: 'temperature', num: '21.8', unit: '°C' })
  assert.deepEqual(displayValue('temperature_C', 19.4, METRIC), { name: 'temperature', num: '19.4', unit: '°C' })
  assert.deepEqual(displayValue('temperature_C', 19.4, IMPERIAL), { name: 'temperature', num: '66.9', unit: '°F' })
  assert.deepEqual(displayValue('temperature_F', 71.2, IMPERIAL), { name: 'temperature', num: '71.2', unit: '°F' })
})

test('rain converts between millimetres and inches', () => {
  assert.deepEqual(displayValue('rain_mm', 0.03, METRIC), { name: 'rain', num: '0', unit: 'mm' })
  assert.deepEqual(displayValue('rain_mm', 0.03, { ...METRIC, decimals: 3 }), { name: 'rain', num: '0.03', unit: 'mm' })
  assert.deepEqual(displayValue('rain_mm', 25.4, IMPERIAL), { name: 'rain', num: '1', unit: 'in' })
  assert.deepEqual(displayValue('rain_in', 1, METRIC), { name: 'rain', num: '25.4', unit: 'mm' })
})

test('wind converts between mi/h, km/h and m/s', () => {
  const WIND_METRIC = { decimals: 1, custom: { temp: 'C', rain: 'mm', wind: 'km/h', pressure: 'hPa' } }
  const WIND_MPS = { ...WIND_METRIC, custom: { ...WIND_METRIC.custom, wind: 'm/s' } }
  assert.deepEqual(displayValue('wind_avg_mi_h', 4.6, WIND_METRIC), { name: 'wind avg', num: '7.4', unit: 'km/h' })
  assert.deepEqual(displayValue('wind_avg_km_h', 7.4, IMPERIAL), { name: 'wind avg', num: '4.6', unit: 'mi/h' })
  assert.deepEqual(displayValue('wind_avg_mi_h', 4.6, WIND_MPS), { name: 'wind avg', num: '2.1', unit: 'm/s' })
  assert.deepEqual(displayValue('wind_avg_m_s', 2.1, IMPERIAL), { name: 'wind avg', num: '4.7', unit: 'mi/h' })
})

test('pressure converts between hectopascals and kilopascals', () => {
  const P_KPA = { decimals: 1, custom: { temp: 'C', rain: 'mm', wind: 'km/h', pressure: 'kPa' } }
  assert.deepEqual(displayValue('pressure_hPa', 1013.25, P_KPA), { name: 'pressure', num: '101.3', unit: 'kPa' })
  assert.deepEqual(displayValue('pressure_hPa', 1013.25, METRIC), { name: 'pressure', num: '1013.3', unit: 'hPa' })
  assert.deepEqual(displayValue('pressure_kPa', 101.3, METRIC), { name: 'pressure', num: '1013', unit: 'hPa' })
})

test('fields outside a converting group pass through with their unit', () => {
  assert.deepEqual(displayValue('humidity', 38, METRIC), { name: 'humidity', num: '38', unit: '%' })
  assert.deepEqual(displayValue('battery_ok', 1, METRIC), { name: 'battery ok', num: '1', unit: '' })
  assert.deepEqual(displayValue('wind_direction_deg', 337.5, METRIC), { name: 'wind direction', num: '337.5', unit: '°' })
  assert.deepEqual(displayValue('model', 'Acurite-5n1', METRIC), { name: 'model', num: 'Acurite-5n1', unit: '' })
})
```

- [ ] **Step 2: Run the unit tests to verify they fail**

Run: `node --test test/units.test.js`
Expected: FAIL — `import ... from '../src/units.js'` errors with "No such export: displayValue" and the fmtValue assertions fail against the old magnitude-based rounding.

- [ ] **Step 3: Update the window-level fmtValue test in `cards.spec.js:1034`**

Replace the test body (lines 1034-1043) with the new semantics, since the exposed `fmtValue` signature changes:

```js
test("fmtValue rounds to fixed decimals and trims trailing zeros", async ({ page }) => {
  await open(page, [ACURITE]);
  const out = await page.evaluate(() => [
    fmtValue(71.234, 1), fmtValue(4.6, 2), fmtValue(0.0300, 3), fmtValue(1013.25, 1),
    fmtValue(38, 0), fmtValue("CHECKSUM", 2), fmtValue(true, 2),
    fmtValue(-12.345, 1), fmtValue(-4.5678, 2), fmtValue(-0.004, 1), fmtValue(-1013.25, 1),
  ]);
  expect(out).toEqual(["71.2", "4.6", "0.03", "1013.3", "38", "CHECKSUM", "true",
                      "-12.3", "-4.57", "0", "-1013.3"]);
});
```

- [ ] **Step 4: Implement `fmtValue(v, decimals)` and `displayValue` in `units.js`**

Change the `fmtValue` export at `src/units.js:53-57`:

```js
// rtl_433 sends full float precision; the card only needs enough to read at a glance.
export function fmtValue(v, decimals = 1) {
  if (typeof v !== "number") return String(v);
  return String(parseFloat(v.toFixed(decimals)));
}
```

Append the conversion machinery and `displayValue` at the end of `src/units.js`:

```js
// Unit groups that convert at display time, keyed on the display unit from splitUnit.
const GROUP_OF_UNIT = {
  "°F": "temperature", "°C": "temperature",
  "mm": "rain", "in": "rain",
  "mi/h": "wind", "km/h": "wind", "m/s": "wind",
  "hPa": "pressure", "kPa": "pressure",
};

// Every group converts through one canonical unit so any two units in the group
// compose. Settings name targets by the suffix-less labels from the spec.
const LABEL_UNIT = {
  temperature: { C: "°C", F: "°F" },
  rain: { mm: "mm", in: "in" },
  wind: { "km/h": "km/h", "mi/h": "mi/h", "m/s": "m/s" },
  pressure: { hPa: "hPa", kPa: "kPa" },
};

function toCanonical(group, unit, v) {
  switch (group) {
    case "temperature": return unit === "°F" ? (v - 32) * 5 / 9 : v;
    case "rain": return unit === "in" ? v * 25.4 : v;
    case "wind": return unit === "mi/h" ? v * 1.60934 : unit === "m/s" ? v * 3.6 : v;
    case "pressure": return unit === "kPa" ? v * 10 : v;
  }
  return v;
}

function fromCanonical(group, v, label) {
  switch (group) {
    case "temperature": return label === "F" ? v * 9 / 5 + 32 : v;
    case "rain": return label === "in" ? v / 25.4 : v;
    case "wind": return label === "mi/h" ? v / 1.60934 : label === "m/s" ? v / 3.6 : v;
    case "pressure": return label === "kPa" ? v / 10 : v;
  }
  return v;
}

export function displayValue(field, raw, settings) {
  const parts = splitUnit(field);
  const decimals = settings && Number.isInteger(settings.decimals) ? settings.decimals : 1;
  const group = typeof raw === "number" ? GROUP_OF_UNIT[parts.unit] : undefined;
  if (!group || !settings || !settings.custom || !settings.custom[group]) {
    return { name: parts.name, num: fmtValue(raw, decimals), unit: parts.unit };
  }
  const label = settings.custom[group];
  const num = fromCanonical(group, toCanonical(group, parts.unit, raw), label);
  return { name: parts.name, num: fmtValue(num, decimals), unit: LABEL_UNIT[group][label] || parts.unit };
}
```

- [ ] **Step 5: Run the unit tests to verify they pass**

Run: `node --test test/units.test.js`
Expected: PASS (all tests, including the new conversion and fmtValue tests).

- [ ] **Step 6: Run the updated window-level fmtValue spec**

Run: `npx playwright test test/cards.spec.js -g "fmtValue rounds to fixed decimals"`
Expected: PASS (the harness rebuilds the bundle, so this exercises the new `fmtValue` in the browser).

- [ ] **Step 7: Commit**

```bash
git add dashboard/src/units.js dashboard/test/units.test.js dashboard/test/cards.spec.js
git commit -m "feat(dashboard): convert and format values at display time in units.js"
```

---

### Task 2: `settings.js` — the settings signal, presets, and localStorage

**Files:**
- Create: `dashboard/src/settings.js`
- Create: `dashboard/test/settings.test.js`

**Interfaces:**
- Consumes: nothing (standalone module; `@preact/signals` only).
- Produces: `settings` signal (value shape `{ units, decimals, custom }`), `SETTINGS_KEY`, `loadSettings()`, `saveSettings()`, `setUnits(u)`, `setDecimals(d)`, `setCustomField(group, value)`. Tasks 3, 4, and 5 import `settings` and the setters from `./settings.js`.

- [ ] **Step 1: Write the failing tests in `settings.test.js`**

```js
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { settings, SETTINGS_KEY, loadSettings, saveSettings, setUnits, setDecimals, setCustomField } from '../src/settings.js'

function fakeStorage() {
  const map = new Map()
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  }
  return map
}

beforeEach(() => {
  fakeStorage()
  loadSettings()
})

test('first-load defaults are metric with one decimal', () => {
  assert.deepEqual(settings.value,
    { units: 'metric', decimals: 1, custom: { temp: 'C', rain: 'mm', wind: 'km/h', pressure: 'hPa' } })
})

test('setUnits presets set all four groups at once', () => {
  setUnits('imperial')
  assert.deepEqual(settings.value.custom, { temp: 'F', rain: 'in', wind: 'mi/h', pressure: 'hPa' })
  setUnits('metric')
  assert.deepEqual(settings.value.custom, { temp: 'C', rain: 'mm', wind: 'km/h', pressure: 'hPa' })
})

test('custom units keep the four fields while presets overwrite them', () => {
  setUnits('custom')
  setCustomField('temp', 'F')
  assert.equal(settings.value.units, 'custom')
  assert.equal(settings.value.custom.temp, 'F')
  setUnits('metric')
  assert.equal(settings.value.custom.temp, 'C')
})

test('setDecimals accepts 0-5 and rejects everything else', () => {
  for (let d = 0; d <= 5; d++) {
    setDecimals(d)
    assert.equal(settings.value.decimals, d)
  }
  setDecimals(6)
  assert.equal(settings.value.decimals, 5)
  setDecimals(-1)
  assert.equal(settings.value.decimals, 5)
  setDecimals(1.5)
  assert.equal(settings.value.decimals, 5)
})

test('setCustomField accepts the four groups only', () => {
  setCustomField('temp', 'F')
  assert.equal(settings.value.custom.temp, 'F')
  setCustomField('rain', 'in')
  assert.equal(settings.value.custom.rain, 'in')
  setCustomField('wind', 'm/s')
  assert.equal(settings.value.custom.wind, 'm/s')
  setCustomField('pressure', 'kPa')
  assert.equal(settings.value.custom.pressure, 'kPa')
  setCustomField('temp', 'K')
  assert.equal(settings.value.custom.temp, 'F')
  setCustomField('unknown', 'x')
  assert.deepEqual(settings.value.custom, { temp: 'F', rain: 'in', wind: 'm/s', pressure: 'kPa' })
})

test('changes persist to localStorage and reload', () => {
  setDecimals(3)
  setUnits('custom')
  setCustomField('wind', 'm/s')
  loadSettings()
  assert.deepEqual(settings.value,
    { units: 'custom', decimals: 3, custom: { temp: 'C', rain: 'mm', wind: 'm/s', pressure: 'hPa' } })
})

test('a stored preset keeps its custom fields aligned', () => {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ units: 'imperial', decimals: 2, custom: { temp: 'C' } }))
  loadSettings()
  assert.deepEqual(settings.value,
    { units: 'imperial', decimals: 2, custom: { temp: 'F', rain: 'in', wind: 'mi/h', pressure: 'hPa' } })
})

test('malformed storage falls back to the defaults', () => {
  localStorage.setItem(SETTINGS_KEY, 'not json')
  loadSettings()
  assert.equal(settings.value.units, 'metric')
  localStorage.setItem(SETTINGS_KEY, '{"units":"bogus","decimals":9}')
  loadSettings()
  assert.equal(settings.value.units, 'metric')
  assert.equal(settings.value.decimals, 1)
})

test('a storage exception leaves the in-memory settings usable', () => {
  globalThis.localStorage = {
    getItem: () => { throw new Error('denied') },
    setItem: () => { throw new Error('denied') },
    removeItem: () => {},
  }
  loadSettings()
  assert.equal(settings.value.units, 'metric')
  setUnits('imperial')
  assert.equal(settings.value.units, 'imperial')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/settings.test.js`
Expected: FAIL — "Cannot find module '../src/settings.js'".

- [ ] **Step 3: Write `settings.js`**

```js
import { signal } from '@preact/signals'

export const SETTINGS_KEY = 'rtl433.settings.v1'

const PRESETS = {
  metric: { temp: 'C', rain: 'mm', wind: 'km/h', pressure: 'hPa' },
  imperial: { temp: 'F', rain: 'in', wind: 'mi/h', pressure: 'hPa' },
}

const CUSTOM_VALUES = {
  temp: new Set(['C', 'F']),
  rain: new Set(['mm', 'in']),
  wind: new Set(['km/h', 'mi/h', 'm/s']),
  pressure: new Set(['hPa', 'kPa']),
}

function fresh() {
  return { units: 'metric', decimals: 1, custom: { ...PRESETS.metric } }
}

export const settings = signal(fresh())

let storageBroken = false

export function loadSettings() {
  settings.value = fresh()
  let raw
  try { raw = localStorage.getItem(SETTINGS_KEY) } catch (e) { storageBroken = true; return }
  if (!raw) return
  let s
  try { s = JSON.parse(raw) } catch (e) { return }
  if (!s || typeof s !== 'object') return
  const units = s.units === 'imperial' ? 'imperial' : s.units === 'custom' ? 'custom' : 'metric'
  const decimals = Number.isInteger(s.decimals) && s.decimals >= 0 && s.decimals <= 5 ? s.decimals : 1
  const custom = { ...PRESETS[units] }
  if (units === 'custom') {
    const c = s.custom && typeof s.custom === 'object' ? s.custom : {}
    for (const group of Object.keys(CUSTOM_VALUES)) {
      if (CUSTOM_VALUES[group].has(c[group])) custom[group] = c[group]
    }
  }
  settings.value = { units, decimals, custom }
}

export function saveSettings() {
  if (storageBroken) return
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings.value)) }
  catch (e) { storageBroken = true }
}

export function setUnits(u) {
  if (!(u in PRESETS) && u !== 'custom') return
  const custom = u === 'custom' ? { ...settings.value.custom } : { ...PRESETS[u] }
  settings.value = { units: u, decimals: settings.value.decimals, custom }
  saveSettings()
}

export function setDecimals(d) {
  if (!Number.isInteger(d) || d < 0 || d > 5) return
  settings.value = { ...settings.value, decimals: d }
  saveSettings()
}

export function setCustomField(group, value) {
  if (!CUSTOM_VALUES[group] || !CUSTOM_VALUES[group].has(value)) return
  settings.value = { ...settings.value, custom: { ...settings.value.custom, [group]: value } }
  saveSettings()
}
```

Note: the test imports `saveSettings` but never calls it directly; the setters do. Keeping it exported is fine (matches `sources.js` exporting `configured`/`storageState` for tests).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/settings.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/settings.js dashboard/test/settings.test.js
git commit -m "feat(dashboard): add global unit and decimal settings signal"
```

---

### Task 3: Render card values through `displayValue`

**Files:**
- Modify: `dashboard/src/cards.jsx`
- Modify: `dashboard/test/cards.spec.js:416` and `:656`

**Interfaces:**
- Consumes: `displayValue(field, raw, settings)` from `./units.js` (Task 1), `settings` signal from `./settings.js` (Task 2).
- Produces: card `.val .fv` shows `displayValue(field, raw, settings).num` with the unit in `.fn .u`; the bottom strip shows the same for bottom fields; `CardsView` re-renders when `settings` changes so `fitValues()` re-fits the new widths.

- [ ] **Step 1: Update the two card assertions to the converted metric values**

In `test/cards.spec.js`, test "a card renders label, visible values, rssi and age", change line 416:

```js
  await expect(card.locator('.val[data-f="temperature_F"] .fv')).toContainText("21.8");
```

In test "a bottom value carries its label, reading and unit", change line 656:

```js
  await expect(strip.locator(".bv").last()).toHaveText("21.8°C");
```

(`71.2 °F` converts to `21.8 °C` under the metric default; the bottom-strip label "temperature" at line 655 stays.)

- [ ] **Step 2: Run the specs to verify they fail**

Run: `npx playwright test test/cards.spec.js -g "renders label, visible values|bottom value carries"`
Expected: FAIL — the card still shows "71.2" and the strip "71.2°F".

- [ ] **Step 3: Wire `displayValue` into `cards.jsx`**

Change the import at `src/cards.jsx:6`:

```js
import { ageText, displayValue } from './units.js'
import { settings } from './settings.js'
```

In `CardsView`, add the settings read next to the other signal reads so a settings change re-runs the fit (the `useEffect` above calls `fitValues()` after every render):

```js
  // Read cellSignal and cardState to trigger re-render on changes
  cellSignal.value
  cardState.value
  settings.value
```

Replace the `Value` component body (lines 183-220):

```js
function Value({ rec, field, font, cardKey }) {
  const d = displayValue(field, rec.merged.value[field], settings.value)
  const fvStyle = { fontSize: font }
  const valRef = useRef(null)

  // Call trackFit after the element is mounted or when its font/size changes
  useLayoutEffect(() => {
    const valEl = valRef.current
    if (!valEl) return
    const card = valEl.closest('.card')
    if (card) {
      const valParent = valEl.parentNode
      const rowHeight = valParent ? valParent.clientHeight : 0
      trackFit(valEl, card, textWidthEm(d.num, d.unit), rowHeight)
    }
  }, [d.num, d.unit, font])

  return (
    <div
      class="val"
      data-f={field}
      onPointerDown={(ev) => {
        if (!editing.value) return
        ev.stopPropagation()
        beginDrag(ev, ev.target.closest('.card'), ev.currentTarget)
      }}
    >
      <div class="fn">
        <span>{d.name}</span>
        {d.unit && <span class="u">{d.unit}</span>}
      </div>
      <div class="fv" ref={valRef} style={fvStyle}>
        {d.num}
      </div>
    </div>
  )
}
```

Replace the `BottomStrip` value rendering (lines 228-235):

```js
      {bottom.map(f => {
        const d = displayValue(f, rec.merged.value[f], settings.value)
        return (
          <span key={f}>
            <span class="bn">{d.name}</span>
            <span class="bv">{d.num}{d.unit}</span>
          </span>
        )
      })}
```

- [ ] **Step 4: Run the specs to verify they pass**

Run: `npx playwright test test/cards.spec.js -g "renders label, visible values|bottom value carries"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/cards.jsx dashboard/test/cards.spec.js
git commit -m "feat(dashboard): render card values through displayValue"
```

---

### Task 4: Render the devices table reading column through `displayValue`

**Files:**
- Modify: `dashboard/src/devices-table.jsx`
- Modify: `dashboard/test/cards.spec.js` (add one test after the "served page lists devices" test at line 58)

**Interfaces:**
- Consumes: `displayValue` from `./units.js` (Task 1), `settings` signal from `./settings.js` (Task 2).
- Produces: the Reading cell of each device row renders `name: num unit` (e.g. `temperature: 21.8°C`), re-rendering when `settings` changes.

- [ ] **Step 1: Add the failing reading-column test to `cards.spec.js`**

Insert after the test that ends at line 58:

```js
test("the devices table shows readings converted and formatted", async ({ page }) => {
  await open(page, [ACURITE]);
  await page.click("#tab-devices");
  const reading = page.locator(`#devices tr:not(.vrow)[data-key$="${ACURITE_KEY}"] td`).nth(2);
  await expect(reading).toContainText("temperature: 21.8°C");
  await expect(reading).toContainText("wind avg: 7.4km/h");
  await expect(reading).toContainText("humidity: 38%");
});
```

- [ ] **Step 2: Run the spec to verify it fails**

Run: `npx playwright test test/cards.spec.js -g "devices table shows readings converted"`
Expected: FAIL — the cell still shows raw `temperature_F: 71.2 ...`.

- [ ] **Step 3: Wire `displayValue` into `devices-table.jsx`**

Change the imports at `src/devices-table.jsx:5`:

```js
import { ageText, displayValue } from './units.js'
import { settings } from './settings.js'
```

Replace the `reading` helper at lines 9-11:

```js
function reading(rec) {
  const s = settings.value
  return Object.keys(rec.merged.value)
    .map(k => { const d = displayValue(k, rec.merged.value[k], s); return d.name + ": " + d.num + d.unit })
    .join("  ")
}
```

- [ ] **Step 4: Run the spec to verify it passes**

Run: `npx playwright test test/cards.spec.js -g "devices table shows readings converted"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/devices-table.jsx dashboard/test/cards.spec.js
git commit -m "feat(dashboard): render the devices table reading column through displayValue"
```

---

### Task 5: Settings section UI and its Playwright spec

**Files:**
- Create: `dashboard/src/settings.jsx`
- Create: `dashboard/test/settings.spec.js`
- Modify: `dashboard/src/app.jsx`
- Modify: `dashboard/src/main.jsx`
- Modify: `dashboard/src/style.css`

**Interfaces:**
- Consumes: `settings`, `setUnits`, `setDecimals`, `setCustomField` from `./settings.js` (Task 2); `displayValue` behavior verified in Tasks 3-4.
- Produces: a `<details id="settings">` section above the devices table with `#settings-decimals`, `#settings-units`, and — only in custom mode — `#settings-temp`, `#settings-rain`, `#settings-wind`, `#settings-pressure` selects. Every change persists via the Task 2 setters.

- [ ] **Step 1: Write the failing Playwright spec `settings.spec.js`**

```js
import { test, expect } from "@playwright/test";
import { startServer } from "./harness.js";
import { ACURITE, OREGON, LONGNAME, topicOf } from "./fixtures.js";

const ACURITE_KEY = topicOf(ACURITE);
const OREGON_KEY = topicOf(OREGON);
const LONG_KEY = topicOf(LONGNAME);

let server;

test.afterEach(async () => { if (server) await server.close(); server = null; });

async function open(page, devices) {
  server = await startServer({ devices: devices || [] });
  await page.goto(server.url);
  await expect(page.locator("#status")).toHaveText(/^live/);
  await page.evaluate(() => {
    setHideNewCards(false);
    cardState = { ...cardState, hidden: [] };
    saveCardState();
  });
  await page.click("#tab-devices");
  return server;
}

async function showCards(page) {
  await page.click("#tab-cards");
}

async function openSettings(page) {
  await page.locator("#settings summary").click();
  await expect(page.locator("#settings")).toHaveJSProperty("open", true);
}

test("the settings section is collapsed on load and holds the controls", async ({ page }) => {
  await open(page, [ACURITE]);
  await expect(page.locator("#settings")).toHaveJSProperty("open", false);
  await openSettings(page);
  await expect(page.locator("#settings-decimals")).toHaveValue("1");
  await expect(page.locator("#settings-units")).toHaveValue("metric");
  await expect(page.locator("#settings-custom")).toHaveCount(0);
});

test("changing decimals re-renders the card and the devices table", async ({ page }) => {
  await open(page, [LONGNAME]);
  const card = page.locator(`.card:not(.ghostcard)[data-key$="${LONG_KEY}"]`);
  await showCards(page);
  await expect(card.locator('.val[data-f="temperature_F"] .fv')).toHaveText("21.8");
  await page.click("#tab-devices");
  await openSettings(page);
  await page.locator("#settings-decimals").selectOption("3");
  const row = page.locator(`#devices tr:not(.vrow)[data-key$="${LONG_KEY}"]`);
  await expect(row).toContainText("21.797");
  await showCards(page);
  await expect(card.locator('.val[data-f="temperature_F"] .fv')).toHaveText("21.797");
  const stored = await page.evaluate(
    k => devices.get(k).merged.temperature_F, server.url.replace(/\/$/, "") + " " + LONG_KEY);
  expect(stored).toBeCloseTo(71.23456789, 6);
});

test("switching to Imperial shows °F, in, and mi/h", async ({ page }) => {
  await open(page, [LONGNAME]);
  const card = page.locator(`.card:not(.ghostcard)[data-key$="${LONG_KEY}"]`);
  await showCards(page);
  await expect(card.locator('.val[data-f="temperature_F"] .fn .u')).toHaveText("°C");
  await page.click("#tab-devices");
  await openSettings(page);
  await page.locator("#settings-units").selectOption("imperial");
  await showCards(page);
  await expect(card.locator('.val[data-f="temperature_F"] .fn .u')).toHaveText("°F");
  await expect(card.locator('.val[data-f="temperature_F"] .fv')).toHaveText("71.2");
  await expect(card.locator('.val[data-f="wind_avg_mi_h"] .fn .u')).toHaveText("mi/h");
  await expect(card.locator('.val[data-f="rain_mm"] .fn .u')).toHaveText("in");
  await expect(card.locator('.val[data-f="pressure_hPa"] .fn .u')).toHaveText("hPa");
});

test("Imperial converts a Celsius reading to Fahrenheit", async ({ page }) => {
  await open(page, [OREGON]);
  const card = page.locator(`.card:not(.ghostcard)[data-key$="${OREGON_KEY}"]`);
  await showCards(page);
  await expect(card.locator('.val[data-f="temperature_C"] .fv')).toHaveText("19.4");
  await page.click("#tab-devices");
  await openSettings(page);
  await page.locator("#settings-units").selectOption("imperial");
  await showCards(page);
  await expect(card.locator('.val[data-f="temperature_C"] .fn .u')).toHaveText("°F");
  await expect(card.locator('.val[data-f="temperature_C"] .fv')).toHaveText("66.9");
});

test("Custom mode exposes the four selects and applies them", async ({ page }) => {
  await open(page, [LONGNAME]);
  const card = page.locator(`.card:not(.ghostcard)[data-key$="${LONG_KEY}"]`);
  await page.click("#tab-devices");
  await openSettings(page);
  await expect(page.locator("#settings-custom")).toHaveCount(0);
  await page.locator("#settings-units").selectOption("custom");
  await expect(page.locator("#settings-temp")).toBeVisible();
  await expect(page.locator("#settings-rain")).toBeVisible();
  await expect(page.locator("#settings-wind")).toBeVisible();
  await expect(page.locator("#settings-pressure")).toBeVisible();
  await expect(page.locator("#settings-temp")).toHaveValue("C");
  await showCards(page);
  await expect(card.locator('.val[data-f="temperature_F"] .fn .u')).toHaveText("°C");
  await page.click("#tab-devices");
  await page.locator("#settings-temp").selectOption("F");
  await showCards(page);
  await expect(card.locator('.val[data-f="temperature_F"] .fn .u')).toHaveText("°F");
});

test("settings changes are saved and survive a reload", async ({ page }) => {
  await open(page, [OREGON]);
  await openSettings(page);
  await page.locator("#settings-units").selectOption("imperial");
  await page.locator("#settings-decimals").selectOption("3");
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("rtl433.settings.v1")));
  expect(saved.units).toBe("imperial");
  expect(saved.decimals).toBe(3);
  expect(saved.custom).toEqual({ temp: "F", rain: "in", wind: "mi/h", pressure: "hPa" });

  await page.reload();
  await expect(page.locator("#status")).toHaveText(/^live/);
  await page.click("#tab-devices");
  await openSettings(page);
  await expect(page.locator("#settings-units")).toHaveValue("imperial");
  await expect(page.locator("#settings-decimals")).toHaveValue("3");
  await showCards(page);
  await page.evaluate(() => {
    setHideNewCards(false);
    cardState = { ...cardState, hidden: [] };
    saveCardState();
  });
  const card = page.locator(`.card:not(.ghostcard)[data-key$="${OREGON_KEY}"]`);
  await expect(card.locator('.val[data-f="temperature_C"] .fn .u')).toHaveText("°F");
});
```

- [ ] **Step 2: Run the spec to verify it fails**

Run: `npx playwright test test/settings.spec.js`
Expected: FAIL — no `#settings` element in the bundle.

- [ ] **Step 3: Write `settings.jsx`**

```jsx
import { settings, setUnits, setDecimals, setCustomField } from './settings.js'

const DECIMALS = [0, 1, 2, 3, 4, 5]

const GROUPS = {
  temp: { label: 'Temperature', options: [['C', '°C'], ['F', '°F']] },
  rain: { label: 'Rain', options: [['mm', 'mm'], ['in', 'in']] },
  wind: { label: 'Wind', options: [['km/h', 'km/h'], ['mi/h', 'mi/h'], ['m/s', 'm/s']] },
  pressure: { label: 'Pressure', options: [['hPa', 'hPa'], ['kPa', 'kPa']] },
}

export function SettingsView() {
  const s = settings.value

  return (
    <details id="settings">
      <summary>Settings</summary>
      <div>
        <label>
          Decimals
          <select id="settings-decimals" value={s.decimals}
                  onChange={(e) => setDecimals(parseInt(e.target.value, 10))}>
            {DECIMALS.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        </label>
        <label>
          Units
          <select id="settings-units" value={s.units}
                  onChange={(e) => setUnits(e.target.value)}>
            <option value="metric">Metric</option>
            <option value="imperial">Imperial</option>
            <option value="custom">Custom</option>
          </select>
        </label>
      </div>
      {s.units === 'custom' && (
        <div id="settings-custom">
          {Object.entries(GROUPS).map(([group, { label, options }]) => (
            <label key={group}>
              {label}
              <select id={`settings-${group}`} value={s.custom[group]}
                      onChange={(e) => setCustomField(group, e.target.value)}>
                {options.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
              </select>
            </label>
          ))}
        </div>
      )}
    </details>
  )
}
```

- [ ] **Step 4: Mount the section in `app.jsx`**

Add the import after `import { DevicesView } from './devices-table.jsx'` (line 6):

```js
import { SettingsView } from './settings.jsx'
```

Change the devices section (lines 42-44):

```jsx
      <section id="view-devices" hidden={tab.value !== 'devices'}>
        <SettingsView />
        <DevicesView />
      </section>
```

- [ ] **Step 5: Load settings at boot in `main.jsx`**

Add to the imports (near line 8):

```js
import { loadSettings } from './settings.js'
```

Add the call after `loadSources()` (line 162):

```js
loadSettings()
```

- [ ] **Step 6: Style the section in `style.css`**

Append:

```css
#settings { padding:.6rem 1rem; border-bottom:1px solid var(--line); }
#settings summary { cursor:pointer; font-weight:600; }
#settings label { margin-right:1rem; white-space:nowrap; }
#settings select { font:inherit; background:Canvas; color:inherit; border:1px solid var(--line); }
```

- [ ] **Step 7: Run the spec to verify it passes**

Run: `npx playwright test test/settings.spec.js`
Expected: PASS (all 6 tests).

- [ ] **Step 8: Commit**

```bash
git add dashboard/src/settings.jsx dashboard/src/app.jsx dashboard/src/main.jsx dashboard/src/style.css dashboard/test/settings.spec.js
git commit -m "feat(dashboard): add Settings section to the devices tab"
```

---

### Task 6: Full verification and docs

**Files:**
- Modify: `dashboard/docs/user-manual.md`
- Modify: `dashboard/docs/architecture.md`

**Interfaces:**
- Consumes: everything from Tasks 1-5.

- [ ] **Step 1: Run the full unit test suite**

Run: `node --test test/*.test.js`
Expected: PASS (all unit tests).

- [ ] **Step 2: Run the full Playwright suite**

Run: `npx playwright test`
Expected: exactly the 8 pre-existing failures from the Global Constraints, nothing more. All updated tests (`cards.spec.js` lines 416, 656, 1034, the new reading-column test) and all 6 `settings.spec.js` tests pass.

- [ ] **Step 3: Document the feature in `user-manual.md`**

In `dashboard/docs/user-manual.md`, add a "Settings" subsection covering: the collapsed Settings section at the top of the Devices tab; the Decimals select (0-5, trailing zeros trimmed); the Units select (Metric, Imperial, Custom); the four custom selects that appear in Custom mode; conversion of temperature, rain, wind, and pressure at display time only; and that stored readings are never modified.

- [ ] **Step 4: Document the display pipeline in `architecture.md`**

In `dashboard/docs/architecture.md`, record: `units.js` owns `splitUnit`, `fmtValue(v, decimals)`, and `displayValue(field, raw, settings)`; each unit group converts through a canonical unit; `settings.js` owns the `rtl433.settings.v1` signal and presets; `cards.jsx` and `devices-table.jsx` render readings through `displayValue`; settings changes re-run the card fit because `CardsView` reads the settings signal.

- [ ] **Step 5: Commit**

```bash
git add dashboard/docs/user-manual.md dashboard/docs/architecture.md
git commit -m "docs(dashboard): document unit settings and the display pipeline"
```

---

## Self-Review

**Spec coverage:** Every spec requirement maps to a task. Settings state/signal/presets → Task 2. Settings UI (details, decimals select, units select, four custom selects) → Task 5. Display pipeline (`displayValue`, `splitUnit`/`fmtValue` internals, conversion formulas, pass-through, `fmtValue` trimming, cards.jsx Value, devices-table reading column, re-fit on render) → Tasks 1, 3, 4. Tests (units.test.js conversion/decimals/pass-through, new Playwright spec covering collapsed-on-load, decimals update, Imperial units, Custom selects) → Tasks 1, 5. Stored data untouched → asserted in `settings.spec.js` ("changing decimals...") via `devices.get(k).merged.temperature_F`.

**Placeholder scan:** No TBD/TODO/placeholder steps; every step carries full code or exact commands.

**Type consistency:** `displayValue` returns `{ name, num, unit }` in all tasks and tests. `settings` shape `{ units, decimals, custom }` matches across `settings.js`, `settings.jsx`, `units.js`, and the tests. `fmtValue(v, decimals)` signature consistent from Task 1 through the window-exposed test.
