# Backlog

- A device seen through two bridges is two cards. Nothing merges them.
- A reading that cannot fit even at 11px still ellipsizes.
- `src/main.jsx` exposes page internals on `window` through `exposeForTests()`, because
  tests in `test/cards.spec.js` drive the page through the globals the firmware version had
  at script level. 39 of its 88 tests reach for `window.` or `page.evaluate`. Deliberate
  and endorsed, since rewriting them would destroy the evidence that the extraction lost
  nothing, but it is debt: delete the hook when the suite drives the DOM instead.
  `store.js`'s `getCardState`/`setCardState` exist only to serve it. `store.js`'s
  `isStorageBroken()` and `exposeForTests()`'s `window.storageBroken` grew the same
  hook further.
- No way to rename a module itself (the receiver or bridge a source points at), only the
  individual device cards it reports. Settings has no field for a source's own label or for
  the receiver's mDNS hostname, which today has no runtime equivalent to its build-time
  `MDNS_PREFIX` (see `receiver/docs/backlog.md`).

- `test/android-smoke.js` was updated for the gear-panel split (dropped the dead
  `#settings summary` click, switched to `#subtab-devices`) without a run against the
  tablet — no device was attached to verify it. Needs one manual run to confirm the
  selectors. Its assertions also assume the Capacitor shell's origin probe aborts, since
  they wait for the devices sub-tab to be selected with an empty source list, which is
  what `abortProbe()` leaves behind. Nothing has confirmed the probe fails there. If it
  succeeds instead, the script lands on the cards tab and fails at its first wait.

## Information feeds

- NWS documents a required identifying `User-Agent`. A browser cannot send one:
  it is a forbidden header name and `fetch` drops it. This works today and is
  outside our control tomorrow. The only fix is a proxy, which the
  browser-direct design rules out.
- Weather is United States only. `feeds/nws.js` sits behind the generic feed
  interface, so a worldwide provider such as Open-Meteo would be a new file
  rather than a refactor.
- Moonrise and moonset are found by sampling altitude every ten minutes and
  interpolating, so they are good to a couple of minutes, not seconds.
- "Use my location" cannot work on the page the receiver serves, because plain
  http on a LAN address is not a secure context. The automated suite cannot
  cover that branch, since the harness serves on 127.0.0.1, which counts as
  secure.
- The DST flag is inferred by comparing offsets across the year and is wrong for
  a zone that changed its rules mid-year.
- Container queries size the type inside a rich value cell. The minimum WebView
  the Capacitor shell ships with is unconfirmed; older engines fall back to
  inherited body type rather than breaking.
- "Clear" clears only the local location. On a page the receiver serves, the
  receiver's own published `$location` immediately supplies the fallback, so the
  feed cards stay and the location the user just cleared still resolves. There is
  no delete for the published value.
