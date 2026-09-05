# rtl433-dashboard

The browser page for the [receiver](../receiver/README.md) and the
[bridge](../bridge/README.md). A card grid with a settings mode: one card per device,
a device table, and a raw log. It reads any number of sources at once over SSE.

Not published to a registry; install from a clone.

    cd dashboard && npm install
    npm start           # builds, then serves it on http://127.0.0.1:8000

With no sources configured the dashboard reads the origin it was served from, so the
firmware-served build works with no setup. The settings panel adds and removes base URLs.

- [`docs/quickstart.md`](docs/quickstart.md) — install, build, and serve it
- [`docs/install.md`](docs/install.md) — requirements and the from-clone steps
- [`docs/user-manual.md`](docs/user-manual.md) — the card grid, settings mode, edit mode, and
  the source list
- [`docs/architecture.md`](docs/architecture.md) — the modules and the build
- [`docs/development.md`](docs/development.md) — building for the receiver and the bridge,
  and running the tests
- [`docs/backlog.md`](docs/backlog.md) — what is deliberately left undone
