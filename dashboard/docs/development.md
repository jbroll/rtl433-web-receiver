# Development

## Building for the other sub-projects

`build.js` writes `dist/index.html` by default. Two flags write the same
build somewhere else instead:

- `--progmem <path>` writes a gzipped C header for the receiver firmware
  (see [`architecture.md`](architecture.md)).
- `--bridge-public` writes `../bridge/public/index.html`, what the bridge's
  `DASHBOARD_HTML` points at. `npm run build:bridge` runs this.

The bridge does not build the dashboard itself; it only reads the file
`--bridge-public` produces. Run `npm run build:bridge` here after a change
that should reach the bridge's served page, and `npm install` in `bridge/`
before running the bridge if `bridge/public/` doesn't exist yet.
