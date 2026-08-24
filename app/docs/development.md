# App development

## Local Android

The dashboard must be built first:

```sh
cd dashboard && npm run build
cd ../app && npm run sync:android
```

`npm run sync:android` copies the built `dashboard/dist` into `android/app/src/main/assets/public/` and updates plugin Gradle files.

Compilation requires the Android SDK and JDK 21. This repository's CI host `gpu` has both; locally you may not. To compile:

```sh
ssh gpu
cd ~/ci-workspace/rtl433-web-receiver/app
JAVA_HOME=/usr/lib/jvm/openjdk21 ANDROID_HOME=$HOME/android-sdk npm run build:android
```

The debug APK lands at `android/app/build/outputs/apk/debug/app-debug.apk`.

## Local iOS

iOS needs macOS, Xcode, and CocoaPods:

```sh
cd dashboard && npm run build
cd ../app && npm run sync:ios
npm run build:ios
```

On a Linux development machine `npm run sync:ios` fails at `pod install`. Two GitHub
Actions workflows build on `macos-latest` instead: `.github/workflows/ios.yml` builds
unsigned for the simulator on every push, and `.github/workflows/ios-release.yml` builds
signed for a device.

## Signed iOS builds

`.github/workflows/ios-release.yml` runs on `workflow_dispatch` and on `v*` tags. It
archives Release against the `iphoneos` SDK with manual signing, exports an `.ipa`, uploads
it to TestFlight, and keeps the `.ipa` as a run artifact.

Signing uses a fixed certificate rather than `-allowProvisioningUpdates`, which would mint a
new distribution certificate on every run because each runner starts with an empty keychain,
and Apple caps a team at three. The certificate is imported into a keychain in `RUNNER_TEMP`
that dies with the job.

A `distribution` input picks where the build goes. `testflight`, the default, exports with
`app-store-connect` and uploads. `adhoc` exports with `release-testing` against the
`rtl433 Ad Hoc` profile and only attaches the `.ipa` to the run; install it over USB with
`ideviceinstaller -i App.ipa`, which works from Linux. Ad hoc is the route for a device too
old for the current TestFlight app, which needs iOS 16. Only devices listed in the ad-hoc
profile can run that build, so a new device means regenerating the profile and updating
`IOS_ADHOC_PROFILE`.

The archive itself always signs with the App Store profile; `xcodebuild -exportArchive`
re-signs with whichever profile the export options name.

The App target carries manual signing and the profile name; the team ID is passed on the
`xcodebuild` line from `APPLE_TEAM_ID` so it stays out of this public repository. The build
number comes from `github.run_number`, since App Store Connect refuses an upload whose build
number it has already seen.

Seven repository secrets feed it:

| Secret | Source |
| --- | --- |
| `APPLE_TEAM_ID` | Membership details on developer.apple.com |
| `ASC_ISSUER_ID`, `ASC_KEY_ID`, `ASC_KEY_P8` | App Store Connect → Users and Access → Integrations → Team Keys, App Manager role with full access |
| `IOS_DIST_P12`, `IOS_DIST_P12_PASSWORD` | An Apple Distribution certificate and its key, as base64 PKCS#12 |
| `IOS_PROVISION_PROFILE` | An App Store Connect profile for `com.rkroll.rtl433` named `rtl433 App Store`, as base64 |
| `IOS_ADHOC_PROFILE` | An Ad Hoc profile named `rtl433 Ad Hoc` listing the test devices, as base64 |

The certificate can be made without a Mac. Generate a key and request with `openssl genrsa`
and `openssl req -new`, upload the `.csr` at Certificates, IDs & Profiles → Certificates →
Apple Distribution, then pack the downloaded `.cer` with the key and Apple's WWDR
intermediate using `openssl pkcs12 -export -legacy`. The profile references the certificate
by name, so replacing one means regenerating the other.

## Settings the app cannot publish

The app loads the dashboard from the Capacitor WebView, so its origin is never
one of the dashboard's sources. Units, decimals, and location changed in the app
stay on the device; the POSTs that publish them to a receiver only fire from a
page that receiver served. The app still adopts a receiver's published `$units`,
but only when the receiver has some stored. See
[`dashboard/docs/user-manual.md`](../../dashboard/docs/user-manual.md).

## Platform Sync

`capacitor.config.ts` sets `webDir: "../dashboard/dist"`. After every dashboard change, rebuild the dashboard and run the relevant `npm run sync:*` before testing the platform build. Generated platform files that should not be committed are listed in `app/.gitignore`.

## Android Installation

Install a debug APK:

```sh
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

`-r` replaces an existing install. The app appears as `rtl_433`.

## CDP Smoke Check

When a tablet is connected over adb:

```sh
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.rkroll.rtl433/.MainActivity
adb forward tcp:9222 localabstract:webview_devtools_remote
node dashboard/test/android-smoke.js
```

`dashboard/test/android-smoke.js` connects to the WebView through Chrome DevTools, asserts the empty Sources landing state, adds a receiver, and asserts receiver data renders. The CI job `ci/android` runs the same steps automatically when a device is present; it reports the smoke test skipped otherwise.

## mDNS Scan

The Sources tab's "Scan for receivers" button (visible only inside the
native shell) calls `@devioarts/capacitor-mdns`'s `discover()` and lists
services whose name starts with `rtl433-`. There is no automated on-device
test for the scan/add flow — the plugin's `discover()` isn't reachable from
Playwright against a plain browser page. Check it manually: with a receiver
on the same LAN as the device, open the Sources tab, tap Scan, and confirm
the receiver appears and adds correctly.

## Unsigned Versus Signed

The Android CI job and local commands above produce an **unsigned debug APK**. It can be installed directly through adb but cannot be published; a release build needs a keystore. iOS is signed, through `ios-release.yml` above.
