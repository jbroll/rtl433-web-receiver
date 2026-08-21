# Quickstart

```
cd dashboard
npm install
npm run build      # writes dist/index.html
npm start           # builds, then serves it on http://127.0.0.1:8000
```

With no sources configured, the dashboard reads the origin it was served
from. Open the settings panel to add a receiver or bridge URL.

`dist/index.html` is self-contained and is the same file the receiver
embeds and serves, and the file the [app](../../app/README.md) loads into
its WebView.

See [`docs/user-manual.md`](user-manual.md) for the tabs and source list,
and [`docs/architecture.md`](architecture.md) for the build.
