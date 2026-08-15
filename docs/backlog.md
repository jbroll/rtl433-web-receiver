# Backlog

Work that spans sub-projects. Each sub-project's own backlog holds the rest.

## No native app for Android or iOS

The dashboard is a browser page. A Capacitor shell around it would make it an installable
app on both platforms without a second implementation: `dashboard/dist/index.html` is
already one self-contained file with no external requests, which is exactly what
Capacitor's `webDir` wants. The shell is a new sub-project, `app/`, with its own
`README.md` and `docs/`, depending on the dashboard's build output rather than copying
its source.

`../KinoQ/packages/tablet-app` is the template. It is a Capacitor 7 Android shell over
another package's build output, and the three things it settled apply here unchanged:

- `androidScheme: "http"` in `capacitor.config.ts`, not Capacitor's `https` default. An
  `https://localhost` page may not open an `http://` connection, and every source here is
  cleartext on the LAN.
- `android:networkSecurityConfig` pointing at an `xml/network_security_config.xml` whose
  `base-config` sets `cleartextTrafficPermitted="true"`. Both stay until the bridge grows
  TLS.
- The generated `android/` tree is committed, with only `android/app/build/`,
  `android/build/`, `android/.gradle/`, `local.properties`, and the synced
  `app/src/main/assets/public/` gitignored. A build host then needs no `cap add`.

iOS has no equivalent there and starts from `cap add ios`. Its webview origin is
`capacitor://localhost` and cleartext needs an ATS exception; reaching a LAN address also
raises the iOS 14 local-network prompt, so `NSLocalNetworkUsageDescription` has to say why.

Both the receiver (`web_ui.cpp:282`) and the bridge send `Access-Control-Allow-Origin: *`,
so the webview origin is allowed as-is. Layout and sources live in `localStorage`, which
the webview keeps until the app's data is cleared; nothing syncs between the app and the
browser page.

### A Sources tab, and a stored list that is never implicitly empty

`sources()` in `dashboard/src/sources.js` falls back to `[location.origin]` when the
stored list is empty, which is what makes the firmware-served page work with no setup. In
the shell that origin is the shell itself, so the app opens on an empty Cards grid and
stays there: the gear panel is reachable but nothing points at it.

Three changes, all in `dashboard/`, none of them shell-specific:

1. **Sources becomes a fourth tab** alongside Devices, Log, and Cards, replacing the gear
   button. `#view-sources` is already a section; it needs a `#tab-sources` button and an
   entry in `TABS` in `main.js`, and `installSourcePanel()`'s toggle handling goes away.
2. **With nothing stored, the page probes its own origin and adopts it if a binding
   answers.** The origin is written into the list only when the probe succeeds, so a page
   served from a device or from a bridge adopts it and a page served from a plain static
   host does not. The firmware cannot prefill at serve time: the page is gzipped at build
   time (`build.js:48`) and served with `Content-Encoding: gzip` straight from flash
   (`web_ui.cpp:290`), so nothing patches the HTML per device.
3. **`sources()`'s fallback is deleted.** Once the origin is in the list, the list is the
   only answer, and an empty list means genuinely no source.

The default tab is then Cards when the list has entries and Sources when it does not. On a
device-served page the list always has at least the device, so the Sources tab is never
the landing tab there. In the shell there is no source to prefill, so it always is on
first open. The shell needs no flag and no build of its own to get this.

Two things fall out of the prefill:

- The device's own address becomes a normal listed entry with a connection dot, and it
  becomes removable, which today it is not. It also fixes the eviction bug filed in
  [`dashboard/docs/backlog.md`](../dashboard/docs/backlog.md): today the first added
  source makes the implicit origin stop applying and silently drops the serving device.
- `loadSources()` currently treats "no key stored" and "stored empty list" the same. They
  have to diverge, or removing the last source on a device page re-adds it on the next
  load. Prefilling only when `getItem()` returns `null` keeps a deliberate removal
  removed, at the cost of the Sources tab being the landing tab on a device page in that
  one case, which is correct.

The probe should be the stream itself rather than an extra request. `openSource()` in
`stream.js` already reports `live` on open and `reconnecting` on error, so opening the
origin and committing it on `live` costs nothing a successful adoption would not have paid
anyway. A separate `GET /events` probe would cost a second SSE slot on a receiver that has
only `WEB_UI_SSE_CLIENTS` of them, and `handleEvents()` evicts the longest-attached viewer
rather than refusing when they are full (`web_ui.cpp:412-421`), so probing a busy device
would kick a real viewer off. A `GET` of a topic avoids the slot but does not identify a
binding: a 404 for a topic with no retained message and a static host's 404 for a missing
file are the same response, separable only by the `Access-Control-Allow-Origin` header
`sendStatus()` puts on every receiver reply, which is weak evidence.

The landing tab then waits on the probe, since switching tabs under a user who has started
typing a URL is worse than a short pause. The wait needs a bound; a device on the LAN
resolves in well under it, and hitting the bound means Sources, which is the right answer
for an origin that did not answer.

A bridge serving the app is not possible today: `src/server.js` routes `/events` and
`/<topic>` and nothing else, so `/` is parsed as a topic and there is no HTML to serve.
The probe covers a bridge automatically if it ever gains a static route; nothing in the
dashboard would need to change.

### Build Android on the CI host

The build host is `gpu`, the simple-ci host in `~/.config/simple-ci.conf`, reachable by
plain `ssh gpu` as well as through `sci`. It has the Android SDK at `~/android-sdk`
(platforms 33–35, build-tools 34.0.0, licenses accepted), Gradle 8.11.1, Node 24, and both
JDK 17 and 21 under `/usr/lib/jvm` with 17 as the default. Capacitor 7 needs 21, so the
script sets `JAVA_HOME=/usr/lib/jvm/openjdk21` and `ANDROID_HOME=$HOME/android-sdk`, which
is unset there.

The build is `npm run build` in `dashboard/`, `npx cap sync android`, then
`./gradlew assembleDebug`. A debug APK needs no signing; a release APK needs a keystore,
which does not go in the repo.

As a simple-ci job it is `ci/android`, and the repo needs the three things
`../src/simple-ci/docs/quickstart.md` lists first: a clone at
`gpu:~/ci-workspace/rtl433-web-receiver`, which does not exist yet, an executable script
under `ci/`, and a config naming the host. KinoQ's `ci/simple-ci.conf` shows the shape,
including sourcing `~/.config/simple-ci.conf` so no host name lands in the repo. The APK
is left in the job's worktree under `~/ci-worktrees/`, which survives until `sci clean`.
The repo has no CI of any kind today, so this is also the first `ci/` script.

### Build iOS in a GitHub workflow

iOS cannot build on `gpu`, so it goes to a `macos-latest` runner: Xcode, CocoaPods,
`npx cap sync ios`, then `xcodebuild`. Building unsigned with `CODE_SIGNING_ALLOWED=NO`
verifies compilation and needs no Apple account. Producing an installable `.ipa` needs a
certificate and provisioning profile in repository secrets and a paid developer account.
This would be the first file in `.github/workflows/`.

## The topic rules have drifted

`receiver/topic.cpp` and `bridge/src/topic.js` implement the same three functions in two
languages, verified by two suites that do not share cases, and they have already drifted:
the receiver's `validTopic` rejects a topic with an empty segment (`a//c`), the bridge's
does not, so `GET /a//c` is 400 on one and not the other. `validFilter` diverges the same
way. A shared table of topic and filter cases, read by both suites, would catch this.
Neither side can share the implementation itself: one is allocation-free C++ on an ESP32.

## The receiver has no `install.md` or `development.md`

`receiver/README.md` carries the wiring, the `.env` setup, the build commands, and the
test commands. The bridge splits the same material into `docs/install.md` and
`docs/development.md`. The receiver should match.

## No quickstart anywhere

None of the three has a `docs/quickstart.md`.

## Nothing runs all three suites

`pio test`, `bash receiver/test/host/run.sh`, `npm test` in `bridge/`, and `npm test` in
`dashboard/` are four commands with no one thing that runs them.

## The dashboard's test harness is a fake bridge, not the real one

`dashboard/test/harness.js` serves the built bundle in front of
`receiver/test/binding-server.js`, a JS model of the binding. It keeps the suite fast and
independent of a broker, but it is a second implementation that can drift from both real
ones. Running the suite against the real `bridge/` over an in-process `aedes` would test
what ships.

## The fake bridge swallows client-side socket errors

`receiver/test/binding-server.js`'s `request()` has no `error` handler on
`http.request`, so a client-side socket error surfaces as an uncaught exception rather
than a rejected promise. Test-only, and it shows up as a timeout.
