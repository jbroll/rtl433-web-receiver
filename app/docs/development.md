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

On a Linux development machine `npm run sync:ios` fails at `pod install`. The repository provides a GitHub Actions workflow (`.github/workflows/ios.yml`) that builds unsigned on `macos-latest` instead.

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

## Unsigned Versus Signed

The CI job and local commands above produce an **unsigned debug APK**. It can be installed directly through adb but cannot be published. A release build needs a keystore (Android) or an Apple developer certificate and provisioning profile (iOS). Producing an installable `.ipa` is outside this repository's scope.
