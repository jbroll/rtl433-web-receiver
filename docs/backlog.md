# Backlog

Work that spans sub-projects. Each sub-project's own backlog holds the rest.

## CI runs no tests

`ci/android` and `.github/workflows/ios.yml` only build. Neither invokes `bin/test.sh`, the
bridge's `node --test`, the dashboard's suite, or the receiver host tests, so a change that
breaks any of them lands on main green.

## The Android CDP smoke test passes when it does not run

The check in `ci/android` is guarded by `if adb devices | grep -q '...device$'`, and the
else branch prints a message and exits 0. Unplug the tablet, or lose `adb` from `PATH` so
the pipeline returns 127 and the condition is false, and the job reports success having
verified nothing beyond the APK linking. Nothing in the job status distinguishes "smoke
passed" from "smoke never ran".

## `bin/test.sh` omits the receiver's Playwright suite

It claims to run every sub-project's tests. `receiver/package.json` defines
`test: playwright test` and `receiver/test/binding.spec.js` covers the HTTP binding against
`binding-server.js`, and no script invokes it, so a regression in the receiver's `/$alias`
or `/events` handling is caught only if someone remembers to run it by hand. The `set -e`
and `(cd … && …)` structure itself is correct: a failing subshell does abort the script.

## `ci/simple-ci.conf` sources a config that may not exist

Line 7 dots `$HOME/.config/simple-ci.conf` with no existence guard, so on a runner or a
fresh clone where it was never created, `sci` aborts reading its own config with "No such
file" rather than a message naming the missing host settings.

## The fake bridge swallows client-side socket errors

`receiver/test/binding-server.js`'s `request()` has no `error` handler on
`http.request`, so a client-side socket error surfaces as an uncaught exception rather
than a rejected promise. Test-only, and it shows up as a timeout.
