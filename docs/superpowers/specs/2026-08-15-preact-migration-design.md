# Dashboard Preact + Signals Migration

**Status:** Approved design, 2026-08-15.  
**Scope:** `dashboard/` browser UI only. Bridge, receiver firmware, and Capacitor shell are unchanged.

## Problem

The dashboard rebuilds large DOM sections from scratch on every SSE message and on a 1-second timer.

Hot spots in the current code:

- `main.js:34` — `grid.replaceChildren(...)` rebuilds every card on every `render()`.
- `table.js:30` — `tbody.replaceChildren(...)` rebuilds every device table row on every `renderDevices()`.
- `table.js:124` — `logrows.replaceChildren(...)` rebuilds the whole log on every `addLog()`.
- `sources.js:82` — `ul.replaceChildren(...)` rebuilds the source list on every `renderSourcePanel()`.
- `main.js:224` — `setInterval(render, 1000)` forces a full rebuild every second even when idle.

The code already works around the symptom: `gestureInFlight()` suppresses `renderCards()` during drag/resize/rename so an open input isn't torn out from under the user. The fix is to stop rebuilding DOM that has not changed.

## Decision

Replace the vanilla JS UI layer with **Preact** and **`@preact/signals`**, using **Approach A**: a signal for the devices Map and per-device record signals for volatile fields.

- Full migration of the DOM-building code into Preact components.
- JSX for markup.
- Plain JavaScript, no TypeScript.
- `esbuild` already bundles the dashboard; it will be reconfigured for JSX and the automatic Preact runtime.
- Visual output, DOM selectors, user-facing behavior, and the SSE protocol stay identical.

## Non-goals

- No routing, server-side rendering, or external state manager.
- No visual redesign.
- No changes to `bridge/`, `receiver/`, or `app/`.
- No rewrite of the pure logic helpers (`units.js`, comparators, key helpers).
- No new test philosophy; preserve existing tests and add one unit test for the gesture memo behavior.

## State model

### Outer membership signal

`devices` in `devices.js` becomes a `signal(new Map())`.

- Inserting or removing a device creates a new Map and reassigns `devices.value`.
- Updating an existing device mutates the record's field signals in place; the Map ref stays the same, so the grid list does not re-diff.
- `clearSource(base)` and `trim()` replace the Map ref.

### Per-device record signals

Each record is an object whose volatile fields are signals:

```js
{
  key,                 // string
  rssi: signal(...),
  count: signal(...),
  seenAt: signal(...),
  flashUntil: signal(...),
  obj: signal(...),    // raw parsed payload object
  raw: signal(...),    // JSON string for the log
  merged: signal(...)  // merged readings object
}
```

`merged` is one signal per device, not per field. rtl_433 sends all fields together in each message, so per-field signals add bookkeeping without benefit. Preact's diff updates only the changed text nodes in the DOM.

### Other signals

- `aliases` — signal wrapping the aliases Map. Bumped by `postAlias` and `applyAliasFrame`.
- `cardState` — signal wrapping the card layout state. Bumped by every store mutator (`moveCard`, `moveValue`, `setCardHidden`, `setValueMode`, `setCardSize`, `setGrid`, `forgetLayouts`, `ensureCard`).
- `sort` — signal wrapping `{ by, dir }`. Bumped by `sortBy`.
- `sources` — signal wrapping the source list. Bumped by `addSource`/`removeSource`.
- `sourceState` — signal wrapping the Map of connection states.
- `editing`, `renaming`, `dragging`, `resizing` — signals in the gesture module. `gestureInFlight()` reads them.
- `tick` — bumped every second in `main.jsx`, replacing `setInterval(render, 1000)`. Drives age text and flash-class cleanup.

### Write path

`onMessage` calls `upsert(...)`. `upsert` either inserts (Map signal fires) or updates field signals (Map untouched). No `requestRender()` calls anywhere.

## Module map

### Logic files (.js)

| File | Change |
|------|--------|
| `stream.js` | None. |
| `units.js` | Keep `META`, `STATUS_FIELDS`, `readings`, `mergeReadings`, `splitUnit`, `fmtValue`, `ageText`. Delete `el()`. |
| `devicesort.js` | `sort` becomes a signal. Comparators stay pure. `sortBy` bumps the signal. |
| `alias.js` | `aliases` becomes a signal. Key helpers and persistence stay. `postAlias`/`applyAliasFrame` bump the signal. |
| `store.js` | `cardState` becomes a signal. Persistence and pure queries stay. Mutators bump the signal. |
| `devices.js` | `devices` becomes a signal. `upsert` branches on insert vs update. `clearSource`/`trim` replace the Map ref. |
| `grid.js` | Keep measurement, font sizing, text-width probe, `fitValues`, and gesture logic. Convert `editing`/`renaming`/`dragging`/`resizing` to signals. `gestureInFlight()` reads them. |

### Component files (.jsx)

| File | Replaces | Contents |
|------|----------|----------|
| `main.jsx` | `main.js` | Bootstrap: load state, open streams, mount `<App/>`, bump `tick` every second, `exposeForTests`. SSE handlers call `upsert`/`addLog` directly. |
| `app.jsx` | new | `<App/>`: tab state, renders the four views, toolbar inputs and buttons, status line. |
| `cards.jsx` | `card.js` + cards portion of `main.js` | `<CardsView/>`, `<Card/>`, `<Value/>`, `<BottomStrip/>`, `<Age/>`, `<RenameInput/>`. `fitValues` runs in a `useLayoutEffect`. |
| `devices-table.jsx` | `table.js` devices portion | `<DevicesView/>`, `<DeviceRow/>`, `<ValueRow/>`. Sort header clicks bump the `sort` signal. |
| `log.jsx` | `table.js` log portion | `<LogView/>` reads a `log` signal. `addLog` trims at 200 entries and bumps the signal. |
| `sources.jsx` | `sources.js` UI portion | `<SourcesView/>`, `<SourceRow/>`, `<SourceForm/>`. |

### Deleted

- `render.js` — `setRender`/`requestRender` indirection is gone.
- `card.js`, `table.js` — replaced by `.jsx` equivalents.
- `main.js` — replaced by `main.jsx` (and `app.jsx`).

### `src/index.html`

Shrinks to a mount point. The tab nav and four `<section>` shells move into `<App/>`. The `/*CSS*/` and `/*JS*/` placeholders stay for the inline build.

### Build

`build.js` changes:

- Entry point: `main.jsx`.
- Add loader: `{ '.jsx': 'jsx' }`.
- Add JSX config: `jsx: 'automatic'`, `jsxImportSource: 'preact'`.
- `define: { DEVICE_MAX: ... }` stays.

`package.json` adds `preact` and `@preact/signals` as dependencies.

## Data flow

1. SSE message arrives in `stream.js`.
2. `onMessage` in `main.jsx` computes `key`, `at`, build-reload check, then calls `upsert(...)`.
3. `upsert` either:
   - Inserts a new record with field signals and replaces the Map, or
   - Updates the existing record's field signals in place.
4. Preact signal subscriptions fire automatically:
   - On insert: `<CardsView>` and `<DevicesView>` re-diff their lists and mount one new row/card.
   - On update: only the affected `<Card>` re-renders; Preact patches the changed text nodes.
5. `tick` bumps once per second. `<Age/>` and age cells in the device table re-render; flash classes clear when `flashUntil < tick`.
6. Gestures mutate `dragging`/`resizing` signals and manipulate DOM refs imperatively. On drop, `moveCard`/`moveValue`/`setCardSize` bump `cardState`, and the reconciler updates only the affected card's grid span.
7. Aliases round-trip through the `aliases` signal; the rename input is a controlled component that unmounts on commit.

## Gestures and layout reflow

### Problem

Today's drag, resize, and rename all rely on `gestureInFlight()` suppressing `renderCards()`, because a synchronous rebuild would destroy the DOM node the gesture is holding or the rename input the user is typing in.

### Approach A solution

- Convert `editing`, `renaming`, `dragging`, `resizing` to signals.
- `<Card/>` is wrapped in Preact's `memo(Card, areEqual)`. The comparator reads `gestureInFlight()` and the dragged/resized key; when this card is the one mid-gesture, it returns `true` and Preact skips the render.
- During a drag, `dragMove` mutates the ghost's `style.left/top` directly on a DOM ref. No signal writes to `devices` or `cardState`, so no unrelated re-render occurs.
- During a resize, `resizeMove` mutates the card's `style.gridColumn`/`gridRow` directly. Same isolation.
- Rename is a controlled `<RenameInput/>` component. Re-renders preserve the existing input node and its focus, so the long-press/double-click edge cases in the existing tests stay covered.
- `fitValues` runs in a `useLayoutEffect` keyed on the visible cards, replacing today's `resetFit()`/`trackFit()`/`fitValues()` sequence. The fitting array becomes a ref local to `<CardsView/>`.

## Error handling

- **localStorage failures:** Same try/catch and `storageBroken` flags. Signal bumps happen regardless; in-memory state remains the truth.
- **Corrupt storage:** Same parse-and-default behavior. `loadCardState` assigns `cardState.value = loadedState` once.
- **`__proto__` guard:** Preserved via `Object.create(null)` in `blankState()`.
- **SSE reconnect:** Unchanged in `stream.js`.
- **Build mismatch reload:** Preserved in `onMessage`.
- **Bundle size:** Preact + signals adds roughly 4 KB gzipped. The PROGMEM header grows; no other constraint is triggered.

## Testing

### Unit tests (`test/*.test.js`)

These import logic `.js` files and stay mostly unchanged. Mechanical changes:

- `store.test.js`: `devices.set(...)` → `devices.value.set(...)`, `devices.clear()` → `devices.value = new Map()`, `devices.size` → `devices.value.size`.
- `devices.test.js`: assertions on `devices.value`.
- `alias.test.js`, `sources.test.js`, `devicesort.test.js`: read/write through `.value` where the underlying structure became a signal.
- `build.test.js`: may need updates if it asserts on bundle internals; mostly checks build output structure.
- New file: `test/card-memo.test.js` to pin the gesture-suppression comparator behavior.

### Playwright tests (`test/*.spec.js`)

The DOM shape and selectors stay identical, so most specs pass unchanged. Changes:

- Remove calls to `renderCards()` and `measureGrid()` inside `page.evaluate`. Signal bumps render automatically; these functions no longer exist.
- `exposeForTests` in `main.jsx` keeps the same window exports, wrapping signal values in getters so specs reading `cardState.hidden`, `devices.get(...)`, etc. keep working.

### Verification during implementation

- After each migration step, run `npm run build`.
- Run `node --test test/*.test.js` frequently.
- Run `playwright test` after the cards and gestures migrate.
- Compare gzipped PROGMEM size before and after.

## Migration order

1. **Add dependencies and esbuild JSX config.** Add `preact` and `@preact/signals`, update `build.js` for JSX. Create a temporary `main.jsx` shim that imports the old `main.js` so the bundle keeps working while the `.js` files still exist. Verify build + tests.
2. **Convert data layer to signals.** `devices.js`, `store.js`, `alias.js`, `devicesort.js`, `sources.js`. Update unit tests mechanically. Verify unit tests pass.
3. **Remove `render.js` and the 1-second render timer.** Replace with `tick` signal. `main.jsx` mounts `<App/>`. At this point the old `.js` modules still render via direct DOM manipulation, but the timer is gone.
4. **Migrate sources panel** to `sources.jsx`. Small, low-risk, verifies the component plumbing.
5. **Migrate log view** to `log.jsx`.
6. **Migrate devices table** to `devices-table.jsx`.
7. **Migrate cards grid** to `cards.jsx`, including gestures, rename, and `fitValues` layout effect. Add `test/card-memo.test.js` to pin the gesture-suppression comparator. This is the largest change.
8. **Delete `render.js`, `card.js`, `table.js`, `main.js`.** Slim `src/index.html` to a mount point. Final build and full test run.

## Risks

- **Gesture tests are the highest-risk area.** The memo comparator that suppresses re-render during drag/resize/rename must exactly preserve existing behavior. A focused unit test mitigates this.
- **Bundle size growth.** Expected ~4 KB gzipped. Verify against the ESP32 partition after first build.
- **Test churn is mechanical but broad.** The unit tests that touch `devices`/`sources`/`aliases` as Maps need `.value` updates; Playwright specs need `renderCards()`/`measureGrid()` calls removed.
