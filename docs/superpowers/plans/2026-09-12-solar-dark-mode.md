# Solar Dark Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the dashboard a four-way theme setting whose `auto` value turns the page dark while the sun is below −6° at the dashboard's location.

**Architecture:** The whole stylesheet already draws in CSS system colours, so switching themes is setting `color-scheme` on `:root`. A new `src/theme.js` exposes one computed signal, `darkNow`, resolving to `true`, `false`, or `null` for "no override"; `main.jsx` writes it to `document.documentElement.dataset.theme`, and two CSS attribute rules do the rest. The `auto` boundary is a pointwise test of the sun's altitude rather than a comparison against the day's civil dawn and dusk timestamps, which gives one code path with no polar, null-crossing, or midnight-wrap special cases.

**Tech Stack:** Preact with `@preact/signals`, esbuild, `node:test` for unit tests, Playwright for browser tests.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-09-12-solar-dark-mode-design.md`.
- All work happens in `dashboard/`. Run commands from `/home/john/src/rtl433-web-receiver/dashboard`.
- Theme values are exactly `system`, `auto`, `light`, `dark`.
- The civil-twilight boundary is the constant `-6` (degrees of solar altitude).
- Fresh install defaults to `auto`. A stored `rtl433.settings.v1` blob with no `theme` key loads as `system`.
- Settings persist in the existing `rtl433.settings.v1` localStorage blob. Do not add a second key.
- Comment style in this repo: say why, not what; one or two lines; default to none. Do not narrate the change.
- Commit messages end with the two trailer lines shown in each Commit step, verbatim.
- Work on branch `solar-dark-mode`, which already exists and holds the spec commit.

---

### Task 1: Export the solar altitude function

`astro.js` already computes the sun's altitude in a module-private helper. Task 3 needs it. This task exports it unchanged and pins the −6° boundary with tests.

**Files:**
- Modify: `dashboard/src/astro.js:84`
- Test: `dashboard/test/astro.test.js`

**Model:** `haiku` — a one-word edit plus verbatim test code.

**Interfaces:**
- Consumes: nothing.
- Produces: `solarAltitude(t, lat, lon) -> number`, exported from `src/astro.js`. `t` is epoch milliseconds (a number, not a `Date`), `lat` and `lon` are degrees, and the return is the altitude of the sun's centre above the horizon in degrees.

- [ ] **Step 1: Write the failing test**

Append to `dashboard/test/astro.test.js`:

```js
test('solar altitude crosses -6 degrees at civil dusk and civil dawn', () => {
  const lat = 40.7128, lon = -74.0060, zone = 'America/New_York'
  const e = sunEvents(utc(2026, 9, 12, 16, 0), lat, lon, zone)
  const dusk = e.civilDusk.getTime()
  const dawn = e.civilDawn.getTime()
  assert.ok(Math.abs(solarAltitude(dusk, lat, lon) + 6) < 0.01, 'dusk is the -6 crossing')
  assert.ok(Math.abs(solarAltitude(dawn, lat, lon) + 6) < 0.01, 'dawn is the -6 crossing')
  assert.ok(solarAltitude(dusk - 2 * MIN, lat, lon) > -6, 'light two minutes before dusk')
  assert.ok(solarAltitude(dusk + 2 * MIN, lat, lon) < -6, 'dark two minutes after dusk')
  assert.ok(solarAltitude(dawn - 2 * MIN, lat, lon) < -6, 'dark two minutes before dawn')
  assert.ok(solarAltitude(dawn + 2 * MIN, lat, lon) > -6, 'light two minutes after dawn')
})

test('solar altitude stays one side of -6 through a polar summer and winter day', () => {
  const lat = 78.22, lon = 15.65
  const june = Date.UTC(2026, 5, 21)
  const december = Date.UTC(2026, 11, 21)
  for (let h = 0; h < 24; h++) {
    assert.ok(solarAltitude(june + h * 3600000, lat, lon) > -6, `light at ${h}h in June`)
    assert.ok(solarAltitude(december + h * 3600000, lat, lon) < -6, `dark at ${h}h in December`)
  }
})
```

Change the import at `dashboard/test/astro.test.js:7` to add `solarAltitude`:

```js
import { julianDay, solarPosition, solarAltitude, sunEvents, moonPhase, moonTimes, localMidnight } from '../src/astro.js'
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/astro.test.js`
Expected: FAIL, `solarAltitude is not a function`.

- [ ] **Step 3: Export the function**

In `dashboard/src/astro.js`, line 84 currently reads:

```js
function solarAltitude (t, lat, lon) {
```

Change it to:

```js
export function solarAltitude (t, lat, lon) {
```

Leave the comment above it and the body unchanged.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/astro.test.js`
Expected: PASS, and every pre-existing test in the file still passes.

- [ ] **Step 5: Commit**

```bash
git add src/astro.js test/astro.test.js
git commit -m "$(cat <<'EOF'
feat(dashboard): export solarAltitude for the civil-twilight boundary

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VvoY5M78EJ2AfpVoebBWv4
EOF
)"
```

---

### Task 2: The theme setting

Add `theme` to the settings signal, its validator, its action, and the load-time latch that leaves existing installs on `system`.

**Files:**
- Modify: `dashboard/src/settings.js` (lines 25-28 `fresh()`, near 56 `cleanUnits()`, 205-226 `loadSettings()`, and the action block after 256)
- Test: `dashboard/test/settings.test.js`

**Model:** `sonnet` — touches four places in an existing module and must fix a pre-existing assertion that this change breaks.

**Interfaces:**
- Consumes: nothing.
- Produces: `settings.value.theme`, a string that is always one of `'system'`, `'auto'`, `'light'`, `'dark'`, and `setTheme(t)` exported from `src/settings.js`, which ignores any value outside that set.

- [ ] **Step 1: Write the failing tests**

Append to `dashboard/test/settings.test.js`:

```js
test('a fresh install defaults to the sun-following theme', () => {
  assert.equal(settings.value.theme, 'auto')
})

test('a stored blob with no theme key stays on the system theme', () => {
  const map = fakeStorage()
  map.set(SETTINGS_KEY, JSON.stringify({ units: 'metric', decimals: 1 }))
  loadSettings()
  assert.equal(settings.value.theme, 'system')
})

test('a stored theme is loaded and a garbage one falls back to auto', () => {
  const map = fakeStorage()
  map.set(SETTINGS_KEY, JSON.stringify({ theme: 'dark' }))
  loadSettings()
  assert.equal(settings.value.theme, 'dark')
  map.set(SETTINGS_KEY, JSON.stringify({ theme: 'chartreuse' }))
  loadSettings()
  assert.equal(settings.value.theme, 'auto')
})

test('setTheme stores the choice and ignores an unknown one', () => {
  setTheme('light')
  assert.equal(settings.value.theme, 'light')
  loadSettings()
  assert.equal(settings.value.theme, 'light')
  setTheme('chartreuse')
  assert.equal(settings.value.theme, 'light')
})
```

Add `setTheme` to the import at `dashboard/test/settings.test.js:4-8`, in the first import group:

```js
import { settings, SETTINGS_KEY, loadSettings, saveSettings, setUnits, setDecimals, setCustomField,
         setTheme,
         setLocation, clearLocation, hasLocation, activeZone, localZone, refreshTz,
         locations, tzOffsets, onLocationFrame, onTzFrame, locationForSources,
         unitsBySource, onUnitsFrame, unitsForSources, publishUnits,
         TZ_RETRY_THROTTLE_MS } from '../src/settings.js'
```

The existing test at `dashboard/test/settings.test.js:39` does a `deepEqual` over the whole settings object and will now fail. Update it to include the new field:

```js
test('first-load defaults are metric with one decimal', () => {
  assert.deepEqual(settings.value,
    { units: 'metric', decimals: 1, custom: { temp: 'C', rain: 'mm', wind: 'km/h', pressure: 'hPa' },
      location: NO_PLACE, theme: 'auto' })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/settings.test.js`
Expected: FAIL. `setTheme is not a function`, and the `deepEqual` test reports a missing `theme` key.

- [ ] **Step 3: Implement the setting**

In `dashboard/src/settings.js`, add the value set next to the other validator tables, after `CUSTOM_VALUES` (which ends at line 19):

```js
const THEMES = new Set(['system', 'auto', 'light', 'dark'])
```

Change `fresh()` (lines 25-28) to:

```js
function fresh() {
  return { units: 'metric', decimals: 1, custom: { ...PRESETS.metric },
           location: blankLocation(), theme: 'auto' }
}
```

Add the validator beside `cleanUnits()`:

```js
function cleanTheme(t) {
  return THEMES.has(t) ? t : 'auto'
}
```

In `loadSettings()`, change the final line (line 225) from:

```js
  settings.value = { ...cleanUnits(s), location: cleanLocation(s.location) }
```

to:

```js
  // A blob written before the theme setting existed carries no key, so it
  // counts as a choice: an upgrade must not darken a dashboard already in use.
  settings.value = { ...cleanUnits(s), location: cleanLocation(s.location),
                     theme: 'theme' in s ? cleanTheme(s.theme) : 'system' }
```

Add the action after `setCustomField()` (which ends at line 276):

```js
export function setTheme(t) {
  if (!THEMES.has(t)) return
  settings.value = { ...settings.value, theme: t }
  saveSettings()
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/settings.test.js`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Commit**

```bash
git add src/settings.js test/settings.test.js
git commit -m "$(cat <<'EOF'
feat(dashboard): add the theme setting with a system latch for existing installs

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VvoY5M78EJ2AfpVoebBWv4
EOF
)"
```

---

### Task 3: The darkNow signal

**Files:**
- Create: `dashboard/src/theme.js`
- Test: `dashboard/test/theme.test.js` (create)

**Model:** `sonnet` — a new module whose signal dependencies have to be right.

**Interfaces:**
- Consumes: `solarAltitude(t, lat, lon)` from Task 1; `settings`, `setTheme`, `resolvedLocation()` from Task 2 and existing `src/settings.js`; `tick` from `src/tick.js`.
- Produces: `darkNow`, a `computed` signal from `@preact/signals` whose `.value` is `true` (render dark), `false` (render light), or `null` (no override, let the OS decide). Also exports `CIVIL`, the number `-6`.

- [ ] **Step 1: Write the failing test**

Create `dashboard/test/theme.test.js`:

```js
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { darkNow, CIVIL } from '../src/theme.js'
import { loadSettings, setTheme, setLocation } from '../src/settings.js'
import { sources } from '../src/sources.js'
import { tick } from '../src/tick.js'

function fakeStorage() {
  const map = new Map()
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  }
  return map
}

globalThis.location = { origin: 'http://receiver.test' }
globalThis.fetch = async () => ({})

// New York, so a UTC hour maps to a predictable local one year round.
const NYC = { lat: 40.7128, lon: -74.0060, label: 'New York', zone: 'America/New_York' }

beforeEach(() => {
  fakeStorage()
  loadSettings()
  sources.value = []
})

test('the civil twilight boundary is six degrees below the horizon', () => {
  assert.equal(CIVIL, -6)
})

test('a fixed theme answers without a location', () => {
  setTheme('light')
  assert.equal(darkNow.value, false)
  setTheme('dark')
  assert.equal(darkNow.value, true)
})

test('the system theme never overrides', () => {
  setTheme('system')
  assert.equal(darkNow.value, null)
  setLocation(NYC)
  assert.equal(darkNow.value, null)
})

test('auto without a location does not override', () => {
  setTheme('auto')
  assert.equal(darkNow.value, null)
})

test('auto follows the sun at the location', (t) => {
  setTheme('auto')
  setLocation(NYC)
  // 17:00 UTC is midday in New York; 05:00 UTC is the middle of the night.
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 8, 12, 17, 0) })
  assert.equal(darkNow.value, false)
  t.mock.timers.setTime(Date.UTC(2026, 8, 12, 5, 0))
  // darkNow is a computed: nothing it reads has changed, so it would return
  // the cached answer. In the app the one-second tick is what invalidates it.
  tick.value++
  assert.equal(darkNow.value, true)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/theme.test.js`
Expected: FAIL, cannot find module `../src/theme.js`.

- [ ] **Step 3: Write the module**

Create `dashboard/src/theme.js`:

```js
import { computed } from '@preact/signals'
import { solarAltitude } from './astro.js'
import { settings, resolvedLocation } from './settings.js'
import { tick } from './tick.js'

// Civil twilight. Testing the altitude pointwise rather than comparing against
// the day's civilDawn and civilDusk avoids every case where those are absent:
// a polar day has no crossing to compare against.
export const CIVIL = -6

// null is no override, leaving `color-scheme: light dark` to follow the OS.
export const darkNow = computed(() => {
  const theme = settings.value.theme
  if (theme === 'light') return false
  if (theme === 'dark') return true
  if (theme !== 'auto') return null
  const { lat, lon } = resolvedLocation()
  if (lat === null || lon === null) return null
  tick.value
  return solarAltitude(Date.now(), lat, lon) < CIVIL
})
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/theme.test.js`
Expected: PASS, all five tests.

Then run the whole unit suite to confirm nothing else moved:

Run: `node --test test/*.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/theme.js test/theme.test.js
git commit -m "$(cat <<'EOF'
feat(dashboard): darkNow signal, dark while the sun is below civil twilight

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VvoY5M78EJ2AfpVoebBWv4
EOF
)"
```

---

### Task 4: Apply the theme to the page

**Files:**
- Modify: `dashboard/src/style.css:1-2`
- Modify: `dashboard/src/main.jsx` (import block near line 14, and the effects block near line 230)

**Model:** `sonnet` — two files, and the CSS has to keep serving the no-attribute case.

**Interfaces:**
- Consumes: `darkNow` from Task 3.
- Produces: `document.documentElement.dataset.theme`, set to `'light'` or `'dark'`, or absent. Browser tests read it as the `data-theme` attribute on `<html>`.

- [ ] **Step 1: Write the failing test**

Append to `dashboard/test/settings.spec.js`:

```js
test("the theme attribute follows the theme setting", async ({ page }) => {
  await open(page, [ACURITE]);
  await openSettingsPane(page);
  await page.evaluate(() => setTheme("dark"));
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.evaluate(() => setTheme("light"));
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.evaluate(() => setTheme("system"));
  await expect(page.locator("html")).not.toHaveAttribute("data-theme");
});
```

The `system` assertion is the one that pins the no-override path. Do not assert
the boot state instead: the dashboard boots on `auto`, and whether that
overrides depends on whether the fixture source publishes a `$location`.

`setTheme` has to reach the page, so add it to the `Object.assign(window, {...})`
block in `exposeForTests()` in `dashboard/src/main.jsx`. Change the last line of
that object from:

```js
    setLocation, clearLocation, expireFeeds, setValueMode: store.setValueMode,
```

to:

```js
    setLocation, clearLocation, expireFeeds, setValueMode: store.setValueMode, setTheme,
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx playwright test test/settings.spec.js -g "theme attribute"`
Expected: FAIL, `setTheme is not defined`.

- [ ] **Step 3: Wire the effect and the CSS**

In `dashboard/src/main.jsx`, add `setTheme` to the existing `settings.js` import (line 14-15):

```js
import { loadSettings, settings, setLocation, clearLocation, onLocationFrame, onTzFrame,
         onUnitsFrame, refreshTz, setTheme } from './settings.js'
```

Add a new import after the `tick.js` import (line 4):

```js
import { darkNow } from './theme.js'
```

Add the effect immediately after the existing `effect(() => { if (settingsTab.value === 'settings') loadBridges() })` line:

```js
effect(() => {
  const dark = darkNow.value
  if (dark === null) delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = dark ? 'dark' : 'light'
})
```

In `dashboard/src/style.css`, lines 1-2 currently read:

```css
:root { color-scheme: light dark; --line:#8883; --err:#c9252c; scrollbar-gutter: stable; }
@media (prefers-color-scheme: dark) { :root { --err:#ff6369; } }
```

Replace them with:

```css
:root { color-scheme: light dark; --line:#8883; --err:#c9252c; scrollbar-gutter: stable; }
@media (prefers-color-scheme: dark) { :root { --err:#ff6369; } }
/* Everything else in this file draws in system colours, which color-scheme
   already flips. A colour with distinct light and dark values needs a line in
   both rules below as well as in the media query above. */
:root[data-theme=light] { color-scheme: light; --err:#c9252c; }
:root[data-theme=dark] { color-scheme: dark; --err:#ff6369; }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx playwright test test/settings.spec.js`
Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 5: Commit**

```bash
git add src/main.jsx src/style.css test/settings.spec.js
git commit -m "$(cat <<'EOF'
feat(dashboard): drive color-scheme from the theme setting

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VvoY5M78EJ2AfpVoebBWv4
EOF
)"
```

---

### Task 5: The theme control in Settings

The spec called this a radio group. Use a `<select>` instead: `settings.jsx` renders Decimals, Units, and all four custom-unit groups as labelled selects, and a lone radio group would not match.

**Files:**
- Modify: `dashboard/src/settings.jsx:1` (import) and `:30-38` (the control row)
- Test: `dashboard/test/settings.spec.js`

**Model:** `sonnet` — small, but it has to follow an existing markup pattern rather than copy verbatim code.

**Interfaces:**
- Consumes: `setTheme` and `settings` from Task 2.
- Produces: a `<select id="settings-theme">` whose value is the current theme.

- [ ] **Step 1: Write the failing test**

Append to `dashboard/test/settings.spec.js`:

```js
test("the theme select shows and changes the theme", async ({ page }) => {
  await open(page, [ACURITE]);
  await openSettingsPane(page);
  await expect(page.locator("#settings-theme")).toHaveValue("auto");
  await page.selectOption("#settings-theme", "dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("#status")).toHaveText(/^live/);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx playwright test test/settings.spec.js -g "theme select"`
Expected: FAIL, `#settings-theme` resolves to no element.

- [ ] **Step 3: Add the control**

In `dashboard/src/settings.jsx`, change the import on line 1 to:

```js
import { settings, setUnits, setDecimals, setCustomField, setTheme } from './settings.js'
```

Add a label after the Units label, so the block that currently runs from line 30 to line 38 becomes:

```jsx
        <label>
          Units
          <select id="settings-units" value={s.units}
                  onChange={(e) => setUnits(e.target.value)}>
            <option value="metric">Metric</option>
            <option value="imperial">Imperial</option>
            <option value="custom">Custom</option>
          </select>
        </label>
        <label>
          Theme
          <select id="settings-theme" value={s.theme}
                  onChange={(e) => setTheme(e.target.value)}>
            <option value="system">System</option>
            <option value="auto">Auto</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx playwright test test/settings.spec.js`
Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 5: Commit**

```bash
git add src/settings.jsx test/settings.spec.js
git commit -m "$(cat <<'EOF'
feat(dashboard): theme select in the settings pane

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VvoY5M78EJ2AfpVoebBWv4
EOF
)"
```

---

### Task 6: Documentation

**Files:**
- Modify: `dashboard/docs/user-manual.md` (the Settings section, after the Units paragraphs ending at line 188)
- Modify: `dashboard/docs/architecture.md` (the Modules table, lines 7-36)

**Model:** `haiku` — prose insertions at named locations, with the text given.

**Interfaces:**
- Consumes: everything above. Produces nothing code reads.

- [ ] **Step 1: Add the manual entry**

In `dashboard/docs/user-manual.md`, insert after the paragraph that ends "Setting a location is not a unit choice and leaves the receiver's units in force." (line 188's paragraph) and before the `## Location` heading:

```markdown
**Theme** chooses between System, Auto, Light, and Dark. Auto is the default on
a browser that has never held dashboard settings; a browser upgrading from a
version without this setting stays on System, so a dashboard already in use
does not change appearance on its own.

System follows the operating system's light or dark preference, which is what
the dashboard did before this setting existed. Light and Dark are fixed. Auto
follows the sun at the dashboard's location: dark once the sun is more than 6°
below the horizon, light otherwise. That is the civil twilight boundary, the
same one the sun card reports as `civil_dawn` and `civil_dusk`, so the screen
stays light through the usable twilight after sunset rather than darkening the
moment the sun touches the horizon.

Auto needs a location. With none set and none published by a source, it behaves
as System. The theme is per browser and is never published to the receiver.
```

- [ ] **Step 2: Add the module rows**

In `dashboard/docs/architecture.md`, add a row to the Modules table immediately after the `tick.js` row:

```markdown
| `theme.js` | `darkNow`, the light/dark/no-override signal behind the theme setting |
```

Change the `settings.js` row from:

```markdown
| `settings.js` | units, decimals, and the location, in `localStorage`, with a source-published location and units as fallback |
```

to:

```markdown
| `settings.js` | units, decimals, the theme, and the location, in `localStorage`, with a source-published location and units as fallback |
```

- [ ] **Step 3: Record the design decision**

In `dashboard/docs/architecture.md`, add this section immediately before the `## Tests` heading:

```markdown
## Theme

`color-scheme` on `:root` carries the whole theme. Every colour in the
stylesheet is a system colour, a grey with alpha that composites against
whatever is behind it, or a saturated status colour that reads under both
themes, so flipping `color-scheme` flips the dashboard. `--err` is the only
value with a distinct light and dark form, and it is set in three places: the
`prefers-color-scheme` media query for the System setting, and the
`[data-theme=light]` and `[data-theme=dark]` rules for the rest.

The Auto setting tests the sun's altitude against −6° at the moment of render
rather than comparing the clock against the day's `civilDusk` and `civilDawn`.
The event form has to answer what to do on a day where a crossing does not
exist, which side of local midnight the current time is on, and when to
invalidate the cached day. The altitude test has none of those cases and is
correct at every latitude, including where the sun never crosses −6° at all.
```

- [ ] **Step 4: Verify the whole suite**

Run: `node --run test`
Expected: PASS, both the `node --test` unit suite and the Playwright suite.

Note: `test/fontfit.spec.js` flakes roughly one run in eleven and predates this
work. If it is the only failure, re-run it alone before treating it as a
regression.

- [ ] **Step 5: Commit**

```bash
git add docs/user-manual.md docs/architecture.md
git commit -m "$(cat <<'EOF'
docs(dashboard): document the theme setting and the civil-twilight boundary

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VvoY5M78EJ2AfpVoebBWv4
EOF
)"
```

---

### Task 7: Delete the working documents

The repo's convention is that specs and plans live on the feature branch and are deleted in the final commit before merge, with anything worth keeping already folded into the permanent docs. Task 6 did that folding.

**Files:**
- Delete: `docs/superpowers/specs/2026-09-12-solar-dark-mode-design.md`
- Delete: `docs/superpowers/plans/2026-09-12-solar-dark-mode.md`

**Model:** `haiku` — two deletions.

- [ ] **Step 1: Delete both files and commit**

Run from the repository root, not `dashboard/`:

```bash
cd /home/john/src/rtl433-web-receiver
git rm docs/superpowers/specs/2026-09-12-solar-dark-mode-design.md docs/superpowers/plans/2026-09-12-solar-dark-mode.md
git commit -m "$(cat <<'EOF'
docs: drop the solar dark mode spec and plan

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VvoY5M78EJ2AfpVoebBWv4
EOF
)"
```
