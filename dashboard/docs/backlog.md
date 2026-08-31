# Backlog

Work blocked on hardware being attached.

- `test/android-smoke.js` was updated for the gear-panel split (dropped the dead
  `#settings summary` click, switched to `#subtab-devices`) without a run against
  the tablet. Its assertions also assume the Capacitor shell's origin probe aborts;
  nothing has confirmed that. If the probe succeeds instead, the script lands on the
  cards tab and fails at its first wait.
- The minimum WebView the Capacitor shell ships with is unconfirmed, so the
  container-query type sizing inside a rich value cell is unverified on the real
  engine. Older engines fall back to inherited body type rather than breaking.
