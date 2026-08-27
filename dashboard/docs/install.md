# Install

## Requirements

- Node 22 or later.
- No runtime dependencies beyond what `npm install` pulls: `preact`,
  `@preact/signals`, `esbuild`, `pigeon-maps`, and the Capacitor packages
  used by the [app](../../app/README.md) shell.

## From a clone

```
git clone <repo> rtl433-web-receiver
cd rtl433-web-receiver/dashboard
npm install
npm run build      # writes dist/index.html
npm start           # builds, then serves it on http://127.0.0.1:8000
```

`dist/index.html` is self-contained: markup, styles and script in one file,
no external requests. With no sources configured it reads the origin it was
served from, so a plain static-file server needs no configuration to show
live data once a receiver or bridge is on the same origin.

See [`docs/development.md`](development.md) for the other two places this
same build gets written, and [`docs/user-manual.md`](user-manual.md) for the
settings panel that adds sources and, per origin, a bridge access token.
