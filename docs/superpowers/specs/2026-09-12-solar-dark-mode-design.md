# Solar dark mode

The dashboard follows the OS colour scheme and nothing else: `style.css:1` sets
`color-scheme: light dark`, and the rest of the stylesheet draws in `Canvas`,
`Highlight`, `currentColor` and `color:inherit`. A dashboard left on a wall
stays light all night.

Add a theme setting with four values, one of which switches on the sun's
position for the dashboard's resolved location.

## The setting

`theme`, one of `system`, `auto`, `light`, `dark`.

- `system` — no override. The OS preference applies, which is today's
  behaviour.
- `auto` — dark while the sun is below −6°, light otherwise. Falls back to
  `system` behaviour when no location resolves.
- `light`, `dark` — fixed.

A fresh install defaults to `auto`. A `rtl433.settings.v1` blob already in
localStorage that carries no `theme` key defaults to `system`, so the change
never moves a dashboard someone has already set up. This is the same one-way
latch `unitsChosen` uses for units: the absence of a key in an existing blob
counts as a choice, not as an unset field.

## The boundary

Dark when the sun's altitude is below −6°.

Civil dawn and civil dusk are defined as the −6° crossings, so this is the
same boundary the sun feed already publishes as `civil_dawn` and `civil_dusk`,
expressed pointwise instead of as a pair of timestamps. Testing the altitude
directly rather than comparing against the day's event times removes every
edge case the event form carries: a polar day where the crossing does not
exist, the `alwaysUp` and `alwaysDown` flags, which side of local midnight the
current time falls on, and invalidating a cached day window at the right
instant. The pointwise form has one code path and is correct at every
latitude.

`astro.js` computes this in `solarAltitude()`. The function becomes exported;
its body does not change.

## Modules

**`src/theme.js`** (new) exports `darkNow`, a computed signal resolving to
`true`, `false`, or `null` for "no override":

- `light` → `false`; `dark` → `true`
- `system` → `null`
- `auto` → reads `resolvedLocation()`; `null` when it has no coordinates,
  otherwise `solarAltitude(Date.now(), lat, lon) < -6`, subscribed to `tick`
  so it re-evaluates once a second

**`src/settings.js`** gains `theme` in the `settings` signal, a `cleanTheme()`
validator beside `cleanUnits()` and `cleanLocation()`, a `setTheme()` action,
and the load-time latch described above.

**`src/main.jsx`** gains one effect writing `darkNow` to
`document.documentElement.dataset.theme` as `light`, `dark`, or removing the
attribute for `null`.

**`src/settings.jsx`** gains a four-way radio group.

**`src/style.css`** keeps `color-scheme: light dark` and the existing
`@media (prefers-color-scheme: dark)` rule, both of which serve the
no-attribute case, and adds:

```css
:root[data-theme=light] { color-scheme: light; --err:#c9252c; }
:root[data-theme=dark]  { color-scheme: dark;  --err:#ff6369; }
```

`--err` is the only colour in the dashboard with distinct light and dark
values, so these two rules cover the whole stylesheet. Every other hardcoded
colour is either a grey with alpha (`#8882`–`#8889`, `#9888`, `#9998`,
`#0003`, `#0004`) that composites against whatever is behind it, or a
saturated status colour (`#3a3`, `#c82`, `#c44`) already using one value under
both themes, or the moon's lit limb `#e8e3d6`, fixed on purpose
(`renderers.jsx:151`). A colour added later that needs a light and a dark
value belongs in both rules above and in the `prefers-color-scheme` rule.

## Tests

- `solarAltitude` sign either side of the −6° boundary at a known latitude,
  longitude and date: a minute before and after civil dusk, a minute before
  and after civil dawn, local noon, local midnight.
- A polar summer latitude reads light across a full day; a polar winter one
  reads dark.
- `auto` with no resolved location leaves the attribute off.
- `light` and `dark` set the attribute regardless of location or time.
- A stored blob with no `theme` key loads as `system`; a blob with
  `theme: 'auto'` loads as `auto`; a garbage value loads as the fresh default.

## Docs

`dashboard/docs/user-manual.md` documents the setting and the −6° boundary.
`dashboard/docs/architecture.md` records why the boundary is a pointwise
altitude test rather than the event times the sun feed already publishes.
