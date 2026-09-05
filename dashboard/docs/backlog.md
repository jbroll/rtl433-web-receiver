# Backlog

- In edit mode between 400px and about 640px wide, the fixed edit controls'
  `right:` offsets (`#load-layout` at 36.2rem) run the leftmost buttons toward
  or past the left edge; the wrapping flex row only takes over below 400px.
  Widen the media-query cutoff or switch the controls to a flex row at all
  widths.

Work blocked on hardware being attached.

- `test/android-smoke.js` was updated for the gear-panel split (dropped the dead
  `#settings summary` click, switched to `#subtab-devices`) without a run against
  the tablet. Its assertions also assume the Capacitor shell's origin probe aborts;
  nothing has confirmed that. If the probe succeeds instead, the script lands on the
  cards tab and fails at its first wait.
- The minimum WebView the Capacitor shell ships with is unconfirmed, so the
  container-query type sizing inside a rich value cell is unverified on the real
  engine. Older engines fall back to inherited body type rather than breaking.
