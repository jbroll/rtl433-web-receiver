# Roadmap

Goals and ordered actions for overall system completion. Each goal is a
spec, a plan, and an implementation cycle of its own; this file orders them.

## Baseline

Four sub-projects, each built and tested on its own, sharing one HTTP binding
for MQTT ([`bridge/docs/binding.md`](bridge/docs/binding.md)).

- **`receiver/`** — ESP32-S3 radio firmware. Decodes the ISM band, serves the
  binding's source-only subset, SSE, and an embedded build of the dashboard.
  Two boards build from it, one PlatformIO environment each: `rfm69-433`
  (SX1231 at 433.92 MHz) is the deployed receiver, and `sx1276-915` (SX1276 at
  915 MHz) runs but has decoded nothing and is parked — see
  [`receiver/docs/backlog.md`](receiver/docs/backlog.md).
  The host suite (`receiver/test/host/run.sh`, fourteen firmware modules
  including `signal_store` and `alias_store` into fifteen test binaries)
  runs in `ci/android` on the `gpu` host, and on a developer's machine. The
  deployed board runs the current build and reports
  it as `build` in its `Receiver/0` telemetry, which is what makes live
  checks against it meaningful. The self-test's own PASS/FAIL lines are
  still unread on hardware: they print only under `FAKE_SIGNALS`, and the
  deployed board runs a production build.
- **`bridge/`** — full MQTT to HTTP binding. Has a bearer-token auth path, a
  `GET /-/status` endpoint, a capped and idle-timed `readBody`, and an SSE
  reader drop; not published to a registry. The dashboard stores a per-origin
  token in `localStorage` and sends it.
- **`dashboard/`** — one self-contained `index.html` built from Preact sources
  by esbuild. The Capacitor empty state and the 360 px viewport
  overflow/scrollbar jitter are fixed; the suite drives a real bridge
  (`dashboard/test/harness.js` starts one via
  `bridge/test/helpers/dashboard-fixture.js`), not a fake one.
- **`app/`** — Capacitor 8 shell. Android debug APK builds on the `gpu` CI
  host, unsigned. iOS builds unsigned on macOS via GitHub Actions on every
  push (`ios.yml`), and a signed TestFlight build via `ios-release.yml` on a
  tag push or manual dispatch. Android still needs a keystore for a signed
  release APK; nothing Android is in a store.

`preact-ui-migration` and `capacitor-app` landed on main. The receiver's
last-hour message-type replay is implemented (commit `dece06e` and
follow-ons), and the topic rules already share one case table
(`test/topic_cases.txt`) read by both `receiver/test/host/topic_test.cpp` and
`bridge/test/topic.test.js`, including the `a//c` divergent case. Goal 1 is
done.

## Goals

1. ~~**Consolidate in-flight work and cross-cutting debt.**~~ Done: the
   last-hour replay feature is implemented and the topic rules share one case
   table read by both suites.
2. ~~**Firmware 1.0 — trustworthy and portable.**~~ Done: `signal_store` and
   `alias_store` are host-tested (false-decode filtering, runtime WiFi
   provisioning, the pinned `rtl_433_ESP` commit, and OTA updates were
   already shipped; last-hour replay is done, see Goal 1). USB CDC logging
   is a `FAKE_SIGNALS`-only path: `WebReceiver.ino` points `Log.begin()` at
   `Serial` on that build so the self-test can be read over USB, and keeps
   `Serial0` on a production build, where `Serial0` carries the boot-mode
   strap and OTA has removed the recurring reason to tether a cable.
3. ~~**Bridge auth and release.**~~ Done: the dashboard stores a per-source
   token in `localStorage` and sends it against the bridge's bearer-token
   auth path. Moved ahead of mobile because the mobile app reads bridges over
   the internet. Publishing to npm stays deferred (see Ordered actions) —
   this repo's own deploys don't need it.
4. **Mobile app shippable on Android, beta on iOS.** Done when the dashboard
   mobile and first-run holes are closed, the suite runs against the real
   bridge, Android produces a signed release APK, and iOS produces a signed
   TestFlight build via the macOS CI.
5. **Desktop app (Electron).** Done when an `electron/` sub-project wraps the
   built dashboard and ships installers for Linux, macOS, and Windows.
   Deferred last; the browser page already covers desktop.
6. **Ingest path for non-433 sensors.** The receiver's own card already proves
   the shape: anything recorded through `signal_store::record()` becomes a
   device the dashboard already knows how to draw, alias, and lay out (see
   the BMP280 in `receiver/docs/architecture.md`). Needs a design pass first —
   whether an ingested record authenticates with the OTA token or a second
   credential, what rate limit it carries, and whether it counts toward
   `totalRecorded()` — before it's an implementation goal.
7. **Source naming.** A source — the receiver or bridge a device's cards
   point at — can be renamed, not just the individual cards it reports. On
   the receiver, `MDNS_PREFIX` only takes effect at build time; a portal
   field needs a small NVS-backed store and `mdnsHostname()` preferring the
   stored value, but the prefix also feeds `signal_store::source()`, so
   renaming it orphans the stored `$layout` and every alias, which key on
   the full topic. On the dashboard, Settings has no field for a source's
   own label. One goal covers both halves.
8. **Deferred: clearing a location clears only the local receiver's copy.**
   No `DELETE`/empty-body path exists on the receiver's `$location` route,
   so a dashboard "Clear" only clears what it holds locally, not what the
   receiver has stored. Deferred by decision, not by a blocker.
9. **Device identity across sources.** A device seen through two bridges is
   two cards today; nothing merges them, because a device is keyed on its
   source's base URL plus topic (see `dashboard/docs/architecture.md`'s
   Keys section). Needs a design pass on identity across sources before
   it's an implementation goal.
10. **Weather beyond the United States.** `feeds/nws.js` sits behind the
    dashboard's generic feed interface, so a worldwide provider such as
    Open-Meteo is a new file, not a refactor. NWS returns 404 outside the
    US today, which the feed treats as terminal (see
    `dashboard/docs/architecture.md`'s Third-party requests section).

## Sequencing

Consolidation, then Firmware 1.0, then Bridge auth and release, then Mobile,
then Electron. Stop the drift before adding surface. Make the data the apps
read trustworthy before shipping the apps. Ship Android first because it is
buildable today. iOS release after. Electron last because it adds the least.

Bridge auth (Goal 3) and the dashboard mobile fixes in Goal 4 are independent
and can run in parallel. Linearly, auth then mobile is simpler.

Goals 6-10 are not sequenced against 1-5: each is either deferred by
decision (8) or needs a design pass before it becomes an implementation
goal (6, 7, 9, 10). None is scheduled until that design work happens.

## Ordered actions

### Goal 3 — Bridge auth and release

- ~~Store a per-source credential in dashboard `localStorage`, extending the
  existing `sources` schema, and send it against the bridge's bearer-token
  auth path.~~ Done: `dashboard/src/auth.js` stores it and every write
  (`alias.js`, `settings.js`, `layout_template.js`) attaches it via
  `authHeader(origin)`.
- ~~Runtime token rotation.~~ Done: `POST /-/auth/rotate`, gated by the
  current token, updates the shared token used by both the HTTP bearer
  check and the embedded broker's MQTT `CONNECT` check, and persists it to
  `AUTH_TOKEN_PATH` when configured (see `bridge/docs/user-manual.md`).
  Rotation only gates new connections; clients already past `CONNECT` are
  left alone.
- ~~Cap `readBody` and add an SSE reader drop (existing backlog items,
  security-adjacent).~~ Done.
- Publish the bridge to npm so the `bin` entry has an install path —
  deferred: `deploy.sh`'s `node_app` module deploys from source, not via
  npm, so this only matters for someone running the bridge standalone
  outside this repo's own deploys. `bridge/README.md` documents installing
  from a clone instead; the `bin` entry stays so `npm link` still works.

### Goal 4 — Mobile

- ~~Dashboard: drive the suite against the real `bridge/` over an in-process
  `aedes`~~ Done: `dashboard/test/harness.js` starts one via
  `bridge/test/helpers/dashboard-fixture.js` (origin auto-probe/empty-state
  and the `measureGrid()` overflow and scrollbar jitter are done too).
- App: signed Android release APK (keystore, `--release`) — still open.
  ~~Signed iOS TestFlight build via the macOS CI; write
  `app/docs/quickstart.md`.~~ Done: `.github/workflows/ios-release.yml`
  builds and uploads to TestFlight on a tag push or manual dispatch;
  `app/docs/quickstart.md` exists.

### Goal 5 — Electron (deferred)

- New `electron/` sub-project pointing `webDir` at `../dashboard/dist`; main
  process loads it with no app chrome; `electron-builder` for AppImage, dmg,
  and exe; one smoke test that the shell boots and renders a device.
