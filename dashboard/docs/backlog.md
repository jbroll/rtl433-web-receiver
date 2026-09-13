# Backlog

- The `data-theme` attribute is only applied after the inline bundle parses
  and boots, so the initial empty body paints in the operating system's
  colour scheme. On a light-OS device loading a Dark dashboard this shows as
  a white flash before the page appears. Fix with an inline `<head>` script
  that reads the theme from localStorage and sets `data-theme` before the
  bundle runs.

- In edit mode between 400px and about 640px wide, the fixed edit controls'
  `right:` offsets (`#load-layout` at 36.2rem) run the leftmost buttons toward
  or past the left edge; the wrapping flex row only takes over below 400px.
  Widen the media-query cutoff or switch the controls to a flex row at all
  widths.

- `color-mix()` is unsupported on the test iPad (`CSS.supports` returns false on
  Safari 15.6), so `.card-layer .drop-zone.active`'s
  `background:color-mix(in srgb, Highlight 25%, transparent)` is dropped there
  and a card drop zone shows only its outline, no fill. Give the rule a plain
  translucent fallback ahead of the `color-mix()` declaration.

Work blocked on hardware being attached.

- `test/android-smoke.js` was updated for the gear-panel split (dropped the dead
  `#settings summary` click, switched to `#subtab-devices`) without a run against
  the tablet. Its assertions also assume the Capacitor shell's origin probe aborts;
  nothing has confirmed that. If the probe succeeds instead, the script lands on the
  cards tab and fails at its first wait.
- The minimum WebView the Capacitor shell ships with is unconfirmed, so the
  container-query type sizing inside a rich value cell is unverified on the real
  engine. Older engines fall back to inherited body type rather than breaking.
