# Backlog

Work that spans sub-projects. Each sub-project's own backlog holds the rest.

## No quickstart anywhere

None of the three has a `docs/quickstart.md`.

## Nothing runs all three suites

`pio test`, `bash receiver/test/host/run.sh`, `npm test` in `bridge/`, and `npm test` in
`dashboard/` are four commands with no one thing that runs them.

## The fake bridge swallows client-side socket errors

`receiver/test/binding-server.js`'s `request()` has no `error` handler on
`http.request`, so a client-side socket error surfaces as an uncaught exception rather
than a rejected promise. Test-only, and it shows up as a timeout.
