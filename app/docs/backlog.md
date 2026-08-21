# Backlog

- Android permits cleartext to every host, where iOS permits it only on the local network.
  `android/app/src/main/res/xml/network_security_config.xml` sets
  `cleartextTrafficPermitted="true"` in `base-config`, so a source typed as
  `http://someremotehost/` is allowed and its traffic goes out in the clear, while the same
  configuration is refused by ATS on iOS, whose `Info.plist` uses only
  `NSAllowsLocalNetworking` with a scoped `NSBonjourServices`. A `<domain-config>` covering
  the local subnet and `.local` would match the iOS posture.
- No automated on-device test for the scan/add flow. `@devioarts/capacitor-mdns`'s
  `discover()` isn't reachable from Playwright against a plain browser page, so it's
  checked manually. See [`docs/development.md`](development.md#mdns-scan).
- The CI job and local build produce an unsigned debug APK only; it can't be published.
  A release build needs a keystore (Android) or an Apple developer certificate and
  provisioning profile (iOS). See
  [`docs/development.md`](development.md#unsigned-versus-signed) and
  [`ROADMAP.md`](../../ROADMAP.md) Goal 4.
