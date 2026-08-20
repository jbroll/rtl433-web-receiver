# Roadmap

Goals and ordered actions for overall system completion. Each goal is a
spec, a plan, and an implementation cycle of its own; this file orders them.

## Baseline

Four sub-projects, each built and tested on its own, sharing one HTTP binding
for MQTT ([`bridge/docs/binding.md`](bridge/docs/binding.md)).

- **`receiver/`** — ESP32-S3 + SX1231 firmware. Decodes 433 MHz, serves the
  binding's source-only subset, SSE, and an embedded build of the dashboard.
  Open gaps: false decodes from weak decoders, WiFi credentials baked into
  the image, `rtl_433_ESP` pinned to a branch not a commit, and `signal_store`
  and `alias_store` self-tests never read on a device.
- **`bridge/`** — full MQTT to HTTP binding. No auth, no status endpoint, not
  published to a registry, slow-SSE and unbounded-body gaps.
- **`dashboard/`** — one self-contained `index.html` built from Preact sources
  by esbuild. Mobile and first-run
  holes: 360 px viewport overflow, scrollbar jitter, sources not a tab, empty
  state broken for the Capacitor shell.
- **`app/`** — Capacitor 7 shell. Android debug APK builds on the `gpu` CI
  host. iOS builds unsigned on macOS via GitHub Actions. Nothing signed,
  nothing in a store.

`preact-ui-migration` and `capacitor-app` landed on main; the receiver's
last-hour message-type replay exists only as a design, not an implementation.

Cross-cutting debt: no `quickstart.md` anywhere; no single command runs
all four test suites; the dashboard suite runs against a fake bridge.

## Goals

1. **Consolidate in-flight work and cross-cutting debt.** Done when the
   last-hour replay feature is implemented, the topic rules share one case
   table read by both suites, one command runs all four test suites, and every
   sub-project has a `quickstart.md` plus the install and development split.
2. **Firmware 1.0 — trustworthy and portable.** Done when false-decode
   filtering ships (range checks and a seen-twice rule, not `MY_DEVICES`),
   WiFi is provisioned at runtime, `rtl_433_ESP` is pinned to a commit, the
   stores are host-tested, the self-test is observable over USB, OTA updates
   work, and last-hour replay is implemented.
3. **Bridge auth and release.** Done when the bridge has an HTTP auth path and
   is published to npm. Moved ahead of mobile because the mobile app reads
   bridges over the internet.
4. **Mobile app shippable on Android, beta on iOS.** Done when the dashboard
   mobile and first-run holes are closed, the suite runs against the real
   bridge, Android produces a signed release APK, and iOS produces a signed
   TestFlight build via the macOS CI.
5. **Desktop app (Electron).** Done when an `electron/` sub-project wraps the
   built dashboard and ships installers for Linux, macOS, and Windows.
   Deferred last; the browser page already covers desktop.

## Sequencing

Consolidation, then Firmware 1.0, then Bridge auth and release, then Mobile,
then Electron. Stop the drift before adding surface. Make the data the apps
read trustworthy before shipping the apps. Ship Android first because it is
buildable today. iOS release after. Electron last because it adds the least.

Bridge auth (Goal 3) and the dashboard mobile fixes in Goal 4 are independent
and can run in parallel. Linearly, auth then mobile is simpler.

## Ordered actions

### Goal 1 — Consolidation

- Implement the last-hour message-type replay from its archived design
  (commit 7260849).
- Extract a shared topic and filter case table read by both
  `receiver/test/host/topic_test.cpp` and `bridge/test/topic.test.js`; add the
  `a//c` divergent case; fix whichever side is wrong.
- Add a root `Makefile` or `bin/test.sh` running `pio test`,
  `bash receiver/test/host/run.sh`, `npm test` in `bridge/`, and `npm test` in
  `dashboard/`, in order, non-zero exit on the first failure.
- Write `docs/quickstart.md` at the root and one per sub-project.

### Goal 2 — Firmware 1.0

- Pin `rtl_433_ESP` to a commit sha in `platformio.ini`; document the update
  procedure.
- Implement SoftAP provisioning: first boot or a long press clears NVS
  credentials, a captive portal stores them, and `.env` becomes optional.
  `receiver/partitions.csv` notes that growing `nvs` is blocked on a platform
  hardcoded-offset issue; the current 0x5000 slot must be checked for fit
  before this lands.
- Add an OTA update module. The partition table already has `app0`, `app1`,
  and `otadata` slots. The module fetches a version manifest, compares
  versions, pulls the binary, writes it to the next app slot, updates
  `otadata`, and reboots. Trigger (periodic, `POST /$update`, or both) and
  manifest host (a GitHub release URL or self-hosted) are spec-time
  decisions.
- Move `signal_store` and `alias_store` self-tests to a PlatformIO `native`
  environment or extend `test/host/run.sh`.
- Point `Log.begin()` at USB CDC `Serial`; capture a boot with
  `python3 receiver/monitor.py -d 12 -q`; verify an alias survives a power
  cycle on hardware.

### Goal 3 — Bridge auth and release

- Add an HTTP auth path (token or basic) to the bridge; store a per-source
  credential in dashboard `localStorage`, extending the existing `sources`
  schema.
- Cap `readBody` and add an SSE reader drop (existing backlog items,
  security-adjacent).
- Publish the bridge to npm so the `bin` entry has an install path.

### Goal 4 — Mobile

- Dashboard: sources as a fourth tab with origin auto-probe, closing the
  Capacitor empty state; fix `measureGrid()` 360 px overflow and scrollbar
  jitter; drive the suite against the real `bridge/` over an in-process
  `aedes`.
- App: signed Android release APK (keystore, `--release`); signed iOS
  TestFlight build via the macOS CI; write `app/docs/quickstart.md`.

### Goal 5 — Electron (deferred)

- New `electron/` sub-project pointing `webDir` at `../dashboard/dist`; main
  process loads it with no app chrome; `electron-builder` for AppImage, dmg,
  and exe; one smoke test that the shell boots and renders a device.
