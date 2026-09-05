# Headerless Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the dashboard header; the gear becomes a fixed lower-right toggle for settings mode and the status text becomes a badge shown only when a source is not live.

**Architecture:** `dashboard/src/app.jsx` renders the whole shell. The `tab` signal (`cards`/`devices`) stays, along with its programmatic writers in `main.jsx`. Only the header markup and its CSS change. The `#status` span stays in the DOM at all times with its existing text so Playwright `toHaveText` assertions keep working; CSS hides it when everything is live. Tests switch from tab clicks to two guarded harness helpers so the gear's toggle semantics can't double-toggle.

**Tech Stack:** Preact + @preact/signals, esbuild single-file bundle, Playwright tests (`cd dashboard && npx playwright test`), node --test for unit tests.

## Global Constraints

- The gear keeps id `tab-devices` (spec: "Its id stays `tab-devices`").
- The `tab` signal keeps values `cards` and `devices`; `main.jsx` writes to it and must keep working unmodified.
- `#status` text values are unchanged: `no sources`, `live`, `reconnecting`, `n/m live`.
- The gear is not rendered while layout editing is active.
- Run Playwright from `dashboard/`: `npx playwright test` (the build runs from the harness).
- `test/fontfit.spec.js` flakes about 1 in 11 runs; re-run it once before treating a failure there as real.

---

### Task 1: Test updates for the gear toggle and status badge

**Files:**
- Modify: `dashboard/test/harness.js` (add two exported helpers at the end)
- Modify: `dashboard/test/multi.spec.js`, `location.spec.js`, `layout.spec.js`, `weather.spec.js`, `sources.spec.js`, `fontfit.spec.js`, `devices-table.spec.js`, `bridges.spec.js`, `wind-fit.spec.js`, `network-guard.spec.js`, `devicesort.spec.js`, `units.spec.js`, `auth.spec.js`, `location-propagation.spec.js`, `gestures.spec.js`, `feed-cards.spec.js`, `settings.spec.js`, `cards.spec.js`, `mobile-grid.spec.js`, `android-smoke.js`

**Model:** `sonnet` — mechanical pattern replacement, but across 20 files with per-site await/import judgment.

**Interfaces:**
- Produces: `openSettings(page)` and `closeSettings(page)` exported from `test/harness.js`; every spec navigates through them, never by clicking `#tab-cards` (which Task 2 deletes).

- [ ] **Step 1: Add the guarded helpers to `test/harness.js`**

Append at the end of the file:

```js
// The gear (#tab-devices) toggles settings mode, so a bare click in the wrong
// state would navigate away instead of toward. These check first.
export async function openSettings(page) {
  if (await page.locator("#view-devices").isHidden()) await page.click("#tab-devices");
}

export async function closeSettings(page) {
  if (await page.locator("#view-devices").isVisible()) await page.click("#tab-devices");
}
```

- [ ] **Step 2: Replace tab navigation in every spec listed above**

Apply these exact substitutions (both `page.click("#tab-…")` and `page.locator("#tab-…").click()` forms; the page variable may be `page`, `pageA`, or `pageB`):

- `await page.click("#tab-devices")` and `await page.locator("#tab-devices").click()` → `await openSettings(page)`
- `await page.click("#tab-cards")` and `await page.locator("#tab-cards").click()` → `await closeSettings(page)`
- `await expect(page.locator("#tab-devices")).toHaveAttribute("aria-selected", "true")` → `await expect(page.locator("#view-devices")).toBeVisible()`
- `await expect(page.locator("#tab-cards")).toHaveAttribute("aria-selected", "true")` → `await expect(page.locator("#view-cards")).toBeVisible()`

In `test/android-smoke.js` line 33, replace:

```js
await page.waitForSelector("#tab-devices[aria-selected='true']", { timeout: 15000 });
```

with:

```js
await page.waitForSelector("#view-devices:not([hidden])", { timeout: 15000 });
```

Leave `test/feed-cards.spec.js`'s `await expect(page.locator("#tab-devices")).toBeVisible()` (line 73) as is; the gear keeps that id.

Add `openSettings` / `closeSettings` to each spec's existing `./harness.js` import (add an import line only where none exists, as in `wind-fit.spec.js` if needed), importing only the helper(s) the file uses.

- [ ] **Step 3: Add the new behavior assertions**

In `dashboard/test/sources.spec.js`, directly after the existing line

```js
await expect(page.locator("#status")).toHaveText("no sources");
```

add:

```js
await expect(page.locator("#status")).toBeVisible();
```

In the same file, find the first test that asserts `toHaveText(/^live/)` or reaches a fully-live state (the test around line 104 asserting the cards view). After its live-state point, add:

```js
await expect(page.locator("#status")).toBeHidden();
```

If no existing test in `sources.spec.js` reaches a fully live state, add this assertion instead to `dashboard/test/cards.spec.js` right after its first `await expect(page.locator("#status")).toHaveText(/^live/);` (line 35).

In `dashboard/test/layout.spec.js`, in the first test that clicks `#edit-cards` to enter edit mode, add immediately after entering edit mode:

```js
await expect(page.locator("#tab-devices")).toHaveCount(0);
```

and after leaving edit mode (the matching second `#edit-cards` click, if the test has one):

```js
await expect(page.locator("#tab-devices")).toBeVisible();
```

- [ ] **Step 4: Run the suite to verify the new assertions fail against the old UI**

Run: `cd dashboard && npx playwright test`
Expected: FAIL. `closeSettings` cannot leave settings mode in the old UI (clicking `#tab-devices` there is a no-op), so specs that navigate back to cards fail, and the three Step 3 assertions fail (`#status` visible while live, gear still present while editing). Anything unrelated that fails, investigate before proceeding.

- [ ] **Step 5: Commit**

```bash
git add dashboard/test
git commit -m "test: navigate settings through the gear toggle"
```

---

### Task 2: Headerless shell

**Files:**
- Modify: `dashboard/src/app.jsx`
- Modify: `dashboard/src/style.css`

**Model:** `sonnet` — implementing from prose plus verbatim snippets, two coordinated files.

**Interfaces:**
- Consumes: Task 1's expectations — gear `#tab-devices` toggles `#view-devices` visibility, absent while editing; `#status` hidden when all sources live, visible badge otherwise, text unchanged.
- Produces: no `<header>`, no `#tab-cards`, no `h1` in the DOM.

- [ ] **Step 1: Rewrite the shell in `app.jsx`**

Delete the `TABS` constant (line 16). Change `Status` to mark the all-live state:

```jsx
function Status() {
  const states = [...sourceState.value.values()]
  const live = states.filter((s) => s === 'live').length
  const text = states.length === 0 ? 'no sources'
             : live === states.length ? 'live'
             : live === 0 ? 'reconnecting'
             : `${live}/${states.length} live`
  const ok = states.length > 0 && live === states.length
  return <span id="status" class={ok ? 'ok' : ''}>{text}</span>
}
```

Replace the whole `<header>…</header>` block in `App` with:

```jsx
      <Status />
      {!editing.value && (
        <button
          id="tab-devices"
          class="gear"
          title="Devices &amp; settings"
          aria-selected={tab.value === 'devices'}
          onClick={() => { tab.value = tab.value === 'devices' ? 'cards' : 'devices' }}
        >
          &#9881;
        </button>
      )}
```

Everything else in `App` (the `<Toast />`, both sections, the edit controls) is unchanged.

- [ ] **Step 2: Update `style.css`**

Delete the `header`, `h1`, `header .gear`, and `header .gear[aria-selected=true]` rules (lines 4-6, 10-12) and the old `#status` rule (line 7). Keep the `nav button` rules; the settings subnav uses them.

Add, where the deleted rules were:

```css
#status { position:fixed; left:1rem; bottom:1rem; z-index:2; font-size:.8rem;
          background:Canvas; border:1px solid var(--line); border-radius:1.2rem;
          padding:.3rem .7rem; opacity:.8; }
#status.ok { display:none; }
.gear { position:fixed; right:1rem; bottom:1rem; z-index:2; width:2.4rem; height:2.4rem;
        font-size:1.05rem; line-height:1; border:1px solid var(--line); border-radius:50%;
        background:Canvas; color:inherit; cursor:pointer; }
.gear[aria-selected=true] { background:#8882; }
```

Shift the edit controls left to clear the gear's corner spot:

- `#edit-cards` `right:1rem` → `right:4.2rem`
- `#forget-cards` `right:4.2rem` → `right:7.4rem`
- `#grid-size` `right:12rem` → `right:15.2rem`
- `#save-layout` `right:22rem` → `right:25.2rem`
- `#load-layout` `right:33rem` → `right:36.2rem`

The under-400px media query needs no change; the gear is not part of `#edit-controls` and is not rendered while editing.

- [ ] **Step 3: Run the Playwright suite**

Run: `cd dashboard && npx playwright test`
Expected: PASS (re-run `fontfit.spec.js` once if it is the only failure).

- [ ] **Step 4: Run the unit tests**

Run: `cd dashboard && node --test test/*.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/app.jsx dashboard/src/style.css
git commit -m "feat(dashboard): drop the header; gear toggles settings from the corner"
```

---

### Task 3: Documentation

**Files:**
- Modify: `dashboard/docs/user-manual.md`
- Modify: `dashboard/README.md`
- Modify: `dashboard/docs/architecture.md`

**Model:** `haiku` — doc edits with the intent fully stated.

**Interfaces:**
- Consumes: the shipped behavior from Task 2.

- [ ] **Step 1: Update the user manual's shell description**

`dashboard/docs/user-manual.md` opens (lines 3-6) by describing three tabs and a header status indicator. Rewrite that opening to match the new shell: the page is the card grid; the gear button in the lower-right corner opens settings mode (Settings, Devices, and Log sections) and clicking it again returns to the cards; the gear is hidden while the layout is being edited; a status badge appears in the lower-left corner only when something is wrong — `no sources`, `reconnecting`, or `n/m live` — and disappears when every source is live. Then sweep the rest of the file: phrases like "the Devices tab" / "the Settings tab" / "the Cards tab" become "the Devices section" / "the Settings section" / "the cards view" (settings-mode sections are what the old subnav tabs are now called; leave table-header "header" mentions alone).

- [ ] **Step 2: Update the README**

`dashboard/README.md` line 5 says the dashboard has tabs; reword to say it is a card grid with a settings mode. Line 17's doc link description "the tabs, the card grid, edit mode" → "the card grid, settings mode, edit mode".

- [ ] **Step 3: Update architecture.md's one-liner**

Line 10: `| app.jsx | the tab shell and the cards toolbar |` → `| app.jsx | the shell — cards view, settings mode, gear and status badge — and the cards toolbar |`.

- [ ] **Step 4: Commit**

```bash
git add dashboard/docs/user-manual.md dashboard/README.md dashboard/docs/architecture.md
git commit -m "docs(dashboard): describe the headerless shell"
```
