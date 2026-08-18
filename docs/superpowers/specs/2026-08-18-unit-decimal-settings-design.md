# Unit and Decimal Settings

Global, display-only unit conversion and decimal formatting for the dashboard.

## Goal

A Settings section in the devices tab lets the user choose the unit system
(Metric, Imperial, or a custom mix) and how many decimal places readings show.
The choices are global, convert values at display time, and leave stored data
untouched.

## Scope

- Global unit conversion for temperature, rain, wind speed, and pressure.
- Configurable decimals, 0-5, fixed with trailing zeros trimmed.
- Applied everywhere readings render: cards tab and devices table.
- NOT in scope: per-device overrides, showing both original and converted
  units, unit conversion in the firmware, the pre-existing failures at
  cards.spec.js:1019 and :1045.

## Settings state

New signal plus a localStorage key `rtl433.settings.v1`:

```js
{ units: "metric" | "imperial" | "custom", decimals: 1,
  custom: { temp: "F"|"C", rain: "mm"|"in", wind: "mi/h"|"km/h"|"m/s", pressure: "hPa"|"kPa" } }
```

First-load defaults: `{ units: "metric", decimals: 1, custom: {
temp: "C", rain: "mm", wind: "km/h", pressure: "hPa" } }`.

Presets set all four groups at once; `custom` reads the four fields.

- Metric: C, mm, km/h, hPa
- Imperial: F, in, mi/h, hPa

## Settings UI

A collapsed "Settings" section at the top of the devices tab, above the table.
Use a `<details>` element so it opens and closes without state. Inside:

- decimals `<select>` with options 0-5
- units `<select>` with Metric, Imperial, Custom
- when Custom is chosen, four selects appear: temperature (F/C), rain
  (mm/in), wind (mi/h, km/h, m/s), pressure (hPa/kPa)

Every change writes to localStorage and bumps the settings signal.

## Display pipeline

A pure function in `units.js`:

```js
displayValue(field, raw, settings) -> { name, num, unit }
```

`splitUnit` and `fmtValue` stay as internal helpers; `displayValue` routes
through them. For fields whose unit group converts:

- temperature: C = (F-32) * 5/9
- rain: in = mm / 25.4
- wind: mi/h = km/h / 1.60934, m/s = km/h / 3.6
- pressure: kPa = hPa / 10

Fields outside a converting group (humidity, battery_ok, ...) pass through
with their unit unchanged. `name` is the field name without the unit suffix,
matching current `splitUnit` output.

`fmtValue(v, decimals)` rounds to the requested decimals and trims trailing
zeros. Stored `merged` data is never modified.

`Value` in cards.jsx and the devices-table reading column both call
`displayValue` instead of `fmtValue`/`splitUnit` directly. The cards fit
re-runs on every render, so changed value widths are re-fitted automatically.

## Tests

- units.test.js: conversion math for each group, fmtValue with decimals 0-5
  and trailing-zero trimming, pass-through of non-converting fields.
- A new Playwright spec for the settings UI: the section is collapsed on
  load; opening it and changing decimals updates the card and the devices
  table; switching to Imperial shows °F/in/mi/h; Custom shows the four
  selects.