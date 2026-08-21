# rtl_433 mobile app

A Capacitor 7 shell around the [dashboard](../dashboard/README.md). It is not a second UI: the dashboard's self-contained `dist/index.html` is loaded directly by the WebView.

- App ID: `com.rkroll.rtl433`
- App name: `rtl_433`
- Android package: `com.rkroll.rtl433`

## Build once

```sh
cd dashboard && npm install && npm run build
cd ../app && npm install
```

## Run on Android

```sh
cd app
npm run sync:android
npm run build:android
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

See [docs/quickstart.md](docs/quickstart.md) for the condensed version above. For
day-to-day development, local-network setup, iOS, and the CDP smoke check, see
[docs/development.md](docs/development.md).
