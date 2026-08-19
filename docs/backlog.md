# Backlog

Work that spans sub-projects. Each sub-project's own backlog holds the rest.

## The receiver has no `install.md` or `development.md`

`receiver/README.md` carries the wiring, the `.env` setup, the build commands, and the
test commands. The bridge splits the same material into `docs/install.md` and
`docs/development.md`. The receiver should match.

## No quickstart anywhere

None of the three has a `docs/quickstart.md`.

## Nothing runs all three suites

`pio test`, `bash receiver/test/host/run.sh`, `npm test` in `bridge/`, and `npm test` in
`dashboard/` are four commands with no one thing that runs them.

## The dashboard's test harness is a fake bridge, not the real one

`dashboard/test/harness.js` serves the built bundle in front of
`receiver/test/binding-server.js`, a JS model of the binding. It keeps the suite fast and
independent of a broker, but it is a second implementation that can drift from both real
ones. Running the suite against the real `bridge/` over an in-process `aedes` would test
what ships.

## The fake bridge swallows client-side socket errors

`receiver/test/binding-server.js`'s `request()` has no `error` handler on
`http.request`, so a client-side socket error surfaces as an uncaught exception rather
than a rejected promise. Test-only, and it shows up as a timeout.
