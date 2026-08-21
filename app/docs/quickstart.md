# Quickstart

```
cd dashboard && npm install && npm run build
cd ../app && npm install
npm run sync:android
npm run build:android
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

Android compilation needs the Android SDK and JDK 21; this repo's `gpu` CI
host has both, see [`docs/development.md`](development.md) if building
locally. iOS needs macOS, Xcode, and CocoaPods, or the unsigned CI build via
`.github/workflows/ios.yml`.

After any dashboard change, rebuild it and re-run `npm run sync:*` before
testing a platform build.
