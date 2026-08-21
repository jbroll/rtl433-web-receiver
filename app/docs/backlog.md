# Backlog

- No automated on-device test for the scan/add flow. `@devioarts/capacitor-mdns`'s
  `discover()` isn't reachable from Playwright against a plain browser page, so it's
  checked manually. See [`docs/development.md`](development.md#mdns-scan).
- The CI job and local build produce an unsigned debug APK only; it can't be published.
  A release build needs a keystore (Android) or an Apple developer certificate and
  provisioning profile (iOS). See
  [`docs/development.md`](development.md#unsigned-versus-signed) and
  [`ROADMAP.md`](../../ROADMAP.md) Goal 4.
