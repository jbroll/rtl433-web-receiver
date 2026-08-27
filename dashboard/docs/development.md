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

## Running the tests

```
npm test
```

This runs `node --test test/*.test.js`, then `playwright test`: 295 node
tests against the pure modules, then 228 browser tests in
`test/*.spec.js` that drive a built page with Playwright. Either suite can
be run alone with `node --test test/*.test.js` or `npx playwright test`.

`test/astro-sweep.js` is not part of either suite. It sweeps two years of
local days at 44 sites against an independent bisection of solar altitude and
prints wrong-day, spurious, missed and timing-error counts, which takes about
five minutes:

```
node test/astro-sweep.js [--module ../src/astro.js] [--years 2026,2027]
```

`playwright.config.js` pins an explicit `SPECS` list rather than
discovering `test/*.spec.js` on its own. A new spec file needs a line added
to that list, or `npm test` silently skips it.
