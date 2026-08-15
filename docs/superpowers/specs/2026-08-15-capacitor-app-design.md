# Capacitor App Design

## Scope

This work delivers the complete Capacitor app backlog:

- Make dashboard sources an explicit tab and adopt a serving origin only when it
  successfully provides the HTTP binding.
- Add an Android and iOS Capacitor shell in a new `app/` sub-project.
- Add an Android build job for the `gpu` simple-ci host.
- Add an unsigned iOS build workflow for GitHub Actions.

The app is a shell around the existing dashboard. It does not introduce a second
UI implementation or native application logic.

## Architecture

The dashboard remains the single web artifact. `dashboard/build.js` produces
`dashboard/dist/index.html`, and `app/capacitor.config.ts` sets
`webDir: "../dashboard/dist"`. Capacitor copies that directory during `cap sync`.
The build order is therefore dashboard build, Capacitor sync, then the platform
build.

The app identity is:

- App ID and Android package: `com.rkroll.rtl433`
- App name: `rtl_433`

`app/` has its own package manifest and documentation. The generated Android and
iOS platform trees are committed. Build output, local SDK configuration, and
synced web assets remain ignored.

## Dashboard Sources

Sources becomes a fourth tab after Cards. The existing `#view-sources` section is
reused. The gear toggle and its CSS are removed, while
`installSourcePanel()` retains the form and source-list wiring.

The source list is the only source of truth. The fallback to
`[location.origin]` is removed, so an empty stored list is genuinely empty.

`loadSources()` distinguishes these states:

| Storage state | Initial tab | Probe |
| --- | --- | --- |
| Key absent or storage read throws | Wait for probe | Yes |
| Stored empty list | Sources | No |
| Stored non-empty list | Cards | No |

When storage is unavailable, a successful adoption is in memory only. Existing
save behavior remains a no-op after storage is marked broken.

For an absent key, `main.js` opens `location.origin` through the existing SSE
connection machinery. The stream is registered in the existing open-source map
before normal source synchronization.

- If the stream reports `live` within 1500 ms, the origin is added to the stored
  list, existing stream state is reused, and the app lands on Cards.
- If it reports `reconnecting` or the timeout expires, the probe stream is
  closed, its open-map and source state entries are removed, received data is
  cleared, and the app lands on Sources.

Messages received during a successful probe render normally. Aborting the probe
uses the same cleanup behavior as removing a source.

## Android

The Capacitor configuration sets `server.androidScheme` to `"http"`. This keeps
the WebView origin compatible with cleartext HTTP receiver and bridge URLs on the
LAN. Android declares internet and network-state permissions and points the
application at a network security configuration whose base config permits
cleartext traffic.

The Android shell uses Capacitor 7 and the generated `android/` project. Its
normal build is:

```text
cd dashboard && npm run build
cd ../app && npx cap sync android
cd android && ./gradlew assembleDebug
```

When the adb-connected tablet is available, verification installs the debug APK,
forwards the WebView DevTools socket, and drives the app through CDP. The checks
cover launch, the empty Sources landing state, adding a receiver, and rendered
receiver data. APK compilation remains independently valid when no device is
connected.

## iOS

The same `app/` project includes Capacitor iOS. iOS configuration permits the
cleartext LAN connections required by current receivers and bridges and declares
`NSLocalNetworkUsageDescription` explaining the local-network connection.

The committed `ios/` tree is synchronized from the dashboard build. GitHub
Actions uses `macos-latest` to run an unsigned `xcodebuild` with
`CODE_SIGNING_ALLOWED=NO`. This verifies compilation and uploads the build output.
Creating an installable IPA is outside this work because it requires Apple
signing credentials and provisioning.

## CI

The Android job is an executable `ci/android` simple-ci job targeting `gpu`. It
sets `JAVA_HOME=/usr/lib/jvm/openjdk21` and
`ANDROID_HOME=$HOME/android-sdk`, builds the dashboard, synchronizes Android,
and assembles a debug APK. The APK remains in the job worktree. Device checks
run when adb has a connected tablet and are reported as skipped otherwise. Host
details are sourced from the user's simple-ci configuration rather than stored
in the repository.

The iOS job is a GitHub workflow. It installs dashboard and app dependencies,
builds the dashboard, synchronizes iOS, runs the unsigned Xcode build, and
uploads the resulting artifact.

## Testing

Dashboard browser tests add four cases:

1. A static origin lands on Sources.
2. A binding origin is adopted, listed, and removable.
3. Removing the last source and reloading remains on Sources.
4. Adding a second source to a device-served page preserves both sources.

The existing dashboard tests continue to cover stream and source behavior. The
Android device smoke test exercises the installed Capacitor WebView through CDP.
The Android CI build and iOS workflow provide platform compilation checks.

## Documentation

Add `app/README.md` and app development documentation for local builds, platform
sync, adb installation, CDP forwarding, and the distinction between unsigned
verification and signed distribution. Update the root architecture and backlog
documentation to describe the delivered app and remove the completed backlog
items.
