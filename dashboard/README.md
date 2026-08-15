# rtl433-dashboard

The browser page for the [receiver](../receiver/README.md) and the
[bridge](../bridge/README.md). One card per device, a device table, and a raw log, behind
tabs. It reads any number of sources at once over SSE.

    npm install
    npm run build      # writes dist/index.html
    npm start           # builds, then serves it on http://127.0.0.1:8000

`dist/index.html` is self-contained: markup, styles and script in one file, no external
requests. The receiver serves a gzipped copy of that same file, so the page a browser
loads from a static server and the page the firmware serves are the same artifact.

With no sources configured the dashboard reads the origin it was served from, so the
firmware-served build works with no setup. The settings panel adds and removes base URLs.

- [`docs/user-manual.md`](docs/user-manual.md) — the tabs, the card grid, edit mode, and
  the source list
- [`docs/architecture.md`](docs/architecture.md) — the modules and the build
- [`docs/backlog.md`](docs/backlog.md) — what is deliberately left undone
