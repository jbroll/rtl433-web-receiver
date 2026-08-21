# Roadmap

Goals and ordered actions for overall system completion. Each goal is a
spec, a plan, and an implementation cycle of its own; this file orders them.

## Baseline

Four sub-projects, each built and tested on its own, sharing one HTTP binding
for MQTT ([`bridge/docs/binding.md`](bridge/docs/binding.md)).

- **`receiver/`** — ESP32-S3 + SX1231 firmware. Decodes 433 MHz, serves the
  binding's source-only subset, SSE, and an embedded build of the dashboard.
  `signal_store` and `alias_store` self-tests now run in host CI on every
  commit (`receiver/test/host/run.sh`); the on-device path is still unread —
  the self-test's own PASS/FAIL lines have never been read from a live
  device's serial log.
- **`bridge/`** — full MQTT to HTTP binding. Has a bearer-token auth path; no
  status endpoint, not published to a registry, slow-SSE and unbounded-body
  gaps, and the dashboard has no field to store a per-source token yet.
- **`dashboard/`** — one self-contained `index.html` built from Preact sources
  by esbuild. Mobile and first-run holes: 360 px viewport overflow, scrollbar
  jitter, empty state broken for the Capacitor shell.
- **`app/`** — Capacitor 7 shell. Android debug APK builds on the `gpu` CI
  host. iOS builds unsigned on macOS via GitHub Actions. Nothing signed,
  nothing in a store.

`preact-ui-migration` and `capacitor-app` landed on main. The receiver's
last-hour message-type replay is implemented (commit `dece06e` and
follow-ons), and the topic rules already share one case table
(`test/topic_cases.txt`) read by both `receiver/test/host/topic_test.cpp` and
`bridge/test/topic.test.js`, including the `a//c` divergent case. Goal 1 is
done.

Cross-cutting debt: the dashboard suite runs against a fake bridge, not the
real `bridge/`.

## Goals

1. ~~**Consolidate in-flight work and cross-cutting debt.**~~ Done: the
   last-hour replay feature is implemented and the topic rules share one case
   table read by both suites.
2. ~~**Firmware 1.0 — trustworthy and portable.**~~ Done: `signal_store` and
   `alias_store` are host-tested (false-decode filtering, runtime WiFi
   provisioning, the pinned `rtl_433_ESP` commit, and OTA updates were
   already shipped; last-hour replay is done, see Goal 1). USB CDC logging
   stays dropped: OTA removed the recurring reason to tether a debug cable,
   and `Serial0` carries the boot-mode strap, so retargeting `Log` to
   `Serial` buys little for the risk.
3. **Bridge auth and release.** Done when the dashboard can store and send a
   per-source token against the bridge's existing auth path, and the bridge
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

### Goal 3 — Bridge auth and release

- Store a per-source credential in dashboard `localStorage`, extending the
  existing `sources` schema, and send it against the bridge's bearer-token
  auth path.
- Cap `readBody` and add an SSE reader drop (existing backlog items,
  security-adjacent).
- Publish the bridge to npm so the `bin` entry has an install path.

### Goal 4 — Mobile

- Dashboard: origin auto-probe on the (already-added) sources tab, closing
  the Capacitor empty state; fix `measureGrid()` 360 px overflow and
  scrollbar jitter; drive the suite against the real `bridge/` over an
  in-process `aedes`.
- App: signed Android release APK (keystore, `--release`); signed iOS
  TestFlight build via the macOS CI; write `app/docs/quickstart.md`.

### Goal 5 — Electron (deferred)

- New `electron/` sub-project pointing `webDir` at `../dashboard/dist`; main
  process loads it with no app chrome; `electron-builder` for AppImage, dmg,
  and exe; one smoke test that the shell boots and renders a device.
