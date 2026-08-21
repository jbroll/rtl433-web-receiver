# mDNS device discovery in the app

ROADMAP.md Goal 4: let the app find rtl433 receivers on the LAN via mDNS and
add one to the source list with a tap, instead of typing a URL.

## Problem

The Sources tab (`dashboard/src/sources.jsx`) only takes a typed base URL.
On a phone, finding a receiver's address means looking it up some other way
first. The receiver already advertises itself over mDNS
(`WebReceiver.ino:134-138`, `MDNS.addService("http", "tcp", 80)`), but as a
bare `_http._tcp` service indistinguishable from any other web server
answering mDNS on the same LAN — a printer, a router's admin page. The
bridge advertises nothing.

Two prerequisites, then the feature itself.

## Phase A: Capacitor 7 to 8

`app/package.json` pins `^7.0.0` for `@capacitor/core`, `@capacitor/android`,
`@capacitor/ios`, `@capacitor/cli`. Nothing in the repo's docs pins it there
deliberately — it is what was current when `app/` was scaffolded
(`2026-08-15-capacitor-app-design.md`). Current is 8.5.x, and the mDNS
plugin in Phase C declares `@capacitor/core >=8.0.0` as a peer dependency.

- Bump all four packages to `^8.0.0`.
- Run `npx cap migrate` if it reports anything to do, otherwise `cap sync
  android` directly.
- Rebuild: `cd dashboard && npm run build && cd ../app && npm run
  build:android` (on `gpu`, per `app/docs/development.md`). Confirm the
  existing debug APK still installs and the dashboard still loads, before
  touching anything else.
- iOS is unsigned-CI-only already (ROADMAP Goal 4); the `ios.yml` workflow
  should still build after the bump, but isn't otherwise exercised here.

## Phase B: receiver TXT record

`WebReceiver.ino`'s `startMDNS()`:

```c
MDNS.addService("http", "tcp", 80);
MDNS.addServiceTxt("http", "tcp", "rtl433", "1");
```

One key, one value, no version or hostname repeated in it — the service's
own name already carries `mdnsHostname()`. This is the only signal the app
filters on; it does not depend on `MDNS_PREFIX` or the instance name, so a
receiver built with a custom prefix is still found.

Out of scope: the bridge advertising anything, and TXT-advertising a
device's alias (raised alongside the module-rename backlog item, but that's
a separate change).

## Phase C: app-side discovery

Add `@devioarts/capacitor-mdns` (`^0.1.0`, MIT license) to `app/`. Its API,
relevant here:

```ts
discover(options: {
  type: string        // "_http._tcp."
  name?: string        // instance-name prefix filter, unused here
  timeout: number       // ms
  useNW?: boolean        // iOS hint, unused (Android only for now)
}): Promise<{
  error: boolean
  errorMessage: string | null
  servicesFound: number
  services: Array<{
    name: string
    type: string
    domain: string
    port: number
    hosts: string[]      // resolved IPs
    txt: Record<string, string>
  }>
}>
```

Promise-based with a caller-supplied timeout window, no event stream — this
is why the UI decision below is a button, not a live-updating list: the API
shape already forces one discovery pass per tap.

`cap sync android` picks up whatever `AndroidManifest.xml` permissions the
plugin declares; nothing added by hand.

### UI: `dashboard/src/sources.jsx`

A `<ScanButton />`, rendered only when `Capacitor.isNativePlatform()` is
true (imported from `@capacitor/core`, already a dependency) — never shown
in a plain browser, since mDNS isn't reachable from one and the same
`dist/index.html` is what a browser loads directly.

```jsx
function ScanButton() {
  if (!Capacitor.isNativePlatform()) return null
  const [state, setState] = useState({ status: 'idle', found: [] })

  async function scan() {
    setState({ status: 'scanning', found: [] })
    const result = await Mdns.discover({ type: '_http._tcp.', timeout: 4000 })
    const found = (result.services || []).filter(s => s.txt?.rtl433 === '1')
    setState({ status: 'done', found })
  }

  return (
    <div id="mdns-scan">
      <button onClick={scan} disabled={state.status === 'scanning'}>
        {state.status === 'scanning' ? 'Scanning…' : 'Scan for receivers'}
      </button>
      {state.status === 'done' && state.found.length === 0 && (
        <p class="hint">No receivers found.</p>
      )}
      {state.status === 'done' && state.found.length > 0 && (
        <ul id="mdns-results">
          {state.found.map(svc => <ScanResult key={svc.name} svc={svc} />)}
        </ul>
      )}
    </div>
  )
}
```

`ScanResult` builds the base URL from the first resolved host and the
service's port (`http://${host}` when `port === 80`, else
`http://${host}:${port}` — `normalizeBase()` in `sources.js` already
collapses the default-port case via `URL.origin`, so this is just
constructing something `addSource()` already knows how to take). Clicking
it calls the existing `addSource(base)` unchanged; no changes to
`sources.js`. An entry whose normalized base is already in `sources.value`
renders disabled with "Added" instead of a click target, rather than
letting `addSource()` silently no-op.

Placed above `<SourceForm />` in `SourcesView`, manual entry stays as a
fallback (a receiver's mDNS name resolves fine on a LAN but Bonjour/NSD
browsing can still miss a device depending on router multicast settings).

## Test changes

- `dashboard/test/`: `Mdns.discover` isn't reachable from Playwright against
  a browser page (no native plugin there), so `ScanButton`'s only
  browser-testable behavior is that it renders nothing when
  `Capacitor.isNativePlatform()` is false or absent — cover that directly.
  The scan/filter/add flow itself needs an on-device or emulator check, not
  automated here.
- `receiver/test/host/`: no host test covers `startMDNS()` — it is
  Arduino-`WiFi`-dependent, same as the rest of `WebReceiver.ino`, and
  stays unverified by that suite. Manual check: `dns-sd -B _http._tcp` (or
  `avahi-browse -r _http._tcp`) against a flashed board shows the `rtl433=1`
  TXT record.

## Out of scope

- The bridge becoming mDNS-discoverable.
- iOS (`useNW` exists in the plugin's options but is unused; Goal 4's iOS
  work is unrelated to this feature).
- Renaming a receiver's mDNS hostname or advertised label (separate backlog
  item on `dashboard/docs/backlog.md`).
