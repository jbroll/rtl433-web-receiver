# Plan: clear the root backlog's CI and test-wiring items

Five items in [`docs/backlog.md`](backlog.md), in the order they have to land. Each section
names the files, the change, the check that proves it, and what can go wrong.

One backlog claim did not survive checking; section 1 says what is actually there.

## 1. Stop `**/*.spec.js` from picking up scratch specs

**The backlog's claim did not hold.** `docs/backlog.md` says ten tracked
`debug-*.spec.js` files navigate to a hardcoded LAN address and block adding the dashboard
suite to CI. There are none. `git ls-files 'dashboard/test/debug-*'` returns nothing, and
`git log --diff-filter=D` shows fifteen such files removed in `b13e710`
("test(dashboard): delete the scratch specs, keep the fill-ratio assertion", 2026-08-25).
The root backlog entry was last written in `af75186` on 2026-08-21, before that commit.
I did not read the deleted files, so I cannot confirm the hardcoded-address description of
them; what I can confirm is that nothing matching that name is tracked now.

Grepping `dashboard/test/` for literal IP addresses finds only `127.0.0.1` in
`harness.js`, `multi.spec.js` and `android-smoke.js`. `dashboard/package.json` already
runs `node --test test/*.test.js && playwright test`, and `bin/test.sh` already runs it.
So the dashboard suite is no longer blocked from CI.

What remains is the narrower entry in `dashboard/docs/backlog.md`: `testMatch:
"**/*.spec.js"` means any untracked scratch spec dropped into `test/` runs under
`npm test`, so a local run and a clean checkout run different sets. That is what to fix
here, because the CI wiring in section 4 makes the difference matter.

**Files**: `dashboard/playwright.config.js`.

**Change**: replace `testMatch: "**/*.spec.js"` with an explicit list of the tracked spec
files, or with `testIgnore` covering a reserved scratch prefix (`**/debug-*.spec.js`,
`**/scratch-*.spec.js`). The explicit list costs a line per new spec and catches a spec
that was added but never registered; the ignore prefix costs nothing per spec but only
excludes files someone remembered to name correctly. Pick one and say which in the config.

**Proof**: `cd dashboard && npx playwright test --list` before and after prints the same
test count. Then create `dashboard/test/debug-scratch.spec.js` containing a failing test,
re-run `--list`, and confirm it is absent; delete it.

**Risk**: an explicit list silently drops a real spec if someone forgets to add it. Guard
against that with a check that the config's list matches `git ls-files 'dashboard/test/*.spec.js'`,
or accept the ignore-prefix approach instead.

## 2. Give `binding-server.js`'s `request()` an error handler

Verified: `receiver/test/binding-server.js:286-301` builds an `http.request`, writes the
body and calls `end()`, with no `req.on("error", ...)`. An `error` event on a request with
no listener throws. The promise never settles, so the failure reaches the test author as a
15-second Playwright timeout rather than the socket error.

Land this before the receiver suite enters `bin/test.sh` and CI, so a receiver failure in
CI reads as a failure and not as a hang.

**Files**: `receiver/test/binding-server.js`.

**Change**: in `request()`, switch the returned promise to `(resolve, reject)` and add
`req.on("error", reject)` before `req.end()`. The five call sites (`get`, `post`,
`options` on the returned handle) all `await` the promise inside `test()` bodies, so a
rejection surfaces as a failed test.

**Proof**: temporarily point `request()` at a closed port (`port: 1`) and run
`cd receiver && npx playwright test`. Before the change the run stalls to the timeout;
after it, the tests fail immediately with `ECONNREFUSED`. Revert the port and confirm all
32 tests still pass.

**Risk**: low. Test-only code, and no caller currently attaches a `.catch()` that a
rejection would change the meaning of. Confirm no test asserts on a *resolved* value for a
request that is expected to fail at the socket level; a grep of `binding.spec.js` for
`.get(`/`.post(`/`.options(` before editing is enough.

## 3. Add the receiver suite to `bin/test.sh`

Verified: `bin/test.sh` runs `receiver/test/host/run.sh`, `bridge` `npm test` and
`dashboard` `npm test`, and never runs `receiver`'s `npm test`. `receiver/package.json`
defines `test: playwright test`, `receiver/playwright.config.js` points `testDir` at
`./test`, and `receiver/test/binding.spec.js` holds 32 tests over `/$alias`, `/$layout`,
`/$location`, `/$units`, `/$tz` and `/events`. The backlog's note that the `set -e` plus
`(cd … && …)` structure aborts correctly also holds.

The suite drives `binding-server.js` over raw `http` and never opens a `page`, so it needs
`@playwright/test` as a runner but no browser download. I ran it: 32 passed in 3.6s.

**Files**: `bin/test.sh`.

**Change**: add a block after the existing receiver host-test block, before the bridge
block:

    echo "== receiver: npm test =="
    (cd "$root/receiver" && npm test)

Keep it next to the host tests so both receiver suites read together. The header comment
already explains why `pio test` is excluded; nothing there needs changing.

**Proof**: `bin/test.sh` prints the new header and the Playwright summary. Break one
assertion in `binding.spec.js`, re-run, and confirm the script exits non-zero and does not
reach "all suites passed"; restore it.

**Risk**: `receiver/node_modules` must exist. `bin/test.sh` does no installing for the
other sub-projects either, so this matches what is already there, but it makes a fresh
clone fail one step earlier than before. `receiver/package-lock.json` is tracked, so
`npm ci --prefix receiver` is the documented fix; add it to `docs/development.md` beside
whatever already covers the bridge and dashboard installs. Runtime cost is a few seconds.

## 4. Make CI run the tests

Verified: `ci/android` installs, builds the dashboard, syncs Capacitor, assembles a debug
APK, and optionally runs the CDP smoke test. `.github/workflows/ios.yml` installs, builds
the dashboard, syncs iOS and runs `xcodebuild`. Neither invokes `bin/test.sh`, the
bridge's `node --test`, the dashboard suite or the receiver host tests. `bin/test.sh` is
referenced only from `docs/quickstart.md` and `docs/backlog.md`.

The two jobs have different reach, so they should not run the same set.

**Files**: `ci/android`, `.github/workflows/ios.yml`.

**`ci/android`**: it runs on a self-hosted host (`ci/simple-ci.conf` sets `CI_HOST=gpu`)
with a JDK and the Android SDK, so it is the job that can run everything. After the two
`npm ci` steps and before the dashboard build, add `npm ci --prefix receiver` and
`npm ci --prefix bridge`, then run `bin/test.sh`. Put it before the Gradle build so a
logic failure reports faster than a 5-minute assemble. The dashboard Playwright suite
needs a browser: add `npx --prefix dashboard playwright install chromium` (drop
`--with-deps`, which wants root and is Debian-specific; the host is not one I checked).

**`.github/workflows/ios.yml`**: `macos-latest` has Node and Xcode but no `g++` toolchain
set up for the receiver's host tests, and those need `.pio/libdeps/esp32s3-generic/ArduinoJson`
fetched by a PlatformIO run — `receiver/test/host/run.sh` errors with a message saying so
when the directory is missing. Do not run `bin/test.sh` here. Add three steps instead:

- `npm ci` and `node --test test/*.test.js` in `bridge`
- `npm ci` in `receiver` plus `npx playwright test` (no browser needed)
- `npx playwright install chromium` in `dashboard` plus `npm test`

Place them after the dashboard build and before `npx cap sync ios`. Note that
`ios-release.yml` runs on tags and `workflow_dispatch` only; leaving it build-only is
consistent with a release job, but decide deliberately rather than by omission.

**Proof**: push a branch with a deliberately broken assertion in `bridge/test` and confirm
the iOS workflow fails at the bridge step rather than reaching `xcodebuild`. For
`ci/android`, run it locally with `bash ci/android` on the CI host and confirm the test
step appears and that the exit status is non-zero when a suite fails.

**Risk**: the jobs get slower and gain new ways to fail that are not the app build.
Whether `macos-latest` runs the dashboard Playwright suite green is unverified — I did not
run that suite anywhere. Land the iOS change on a branch first and read the run before
merging. Second risk: `ci/android` already assumes a specific `JAVA_HOME` and
`ANDROID_HOME`; adding `playwright install` adds a download to a host whose cache state I
did not check.

## 5. The Android smoke test passes when it does not run

Verified: `ci/android:32` is `if adb devices | grep -q '[[:space:]]device$'; then`, and the
`else` branch at line 38-39 prints `device smoke skipped: no adb device` and falls off the
end of the script with status 0. The `set -euo pipefail` on line 4 does not help: a
pipeline used as an `if` condition has `set -e` suspended, so a missing `adb` (exit 127)
makes the condition false and takes the else branch exactly like an unplugged tablet. The
job status carries no distinction between "smoke passed", "smoke skipped" and "adb is
gone".

**Files**: `ci/android`.

**Change**: separate the three cases.

- Require `adb` on `PATH` unconditionally: `command -v adb >/dev/null || { echo "[ci/android] adb not found" >&2; exit 1; }` before the device check. A CI host that lost its SDK tooling is a broken host, not a skipped test.
- Keep the no-device case as a skip, but make it visible: write a marker line the job's consumer can read, and keep exit 0 only if a tabletless run is genuinely acceptable. If it is not, gate on an environment variable — `CI_REQUIRE_DEVICE=1` turns the skip into a failure — so the tablet-attached host fails loudly when the tablet drops off while a laptop run still passes.
- Make the smoke test's own outcome distinguishable: echo `[ci/android] smoke: passed` after `node dashboard/test/android-smoke.js` and `[ci/android] smoke: skipped (no adb device)` in the else branch, so a log grep can tell them apart even when the exit status cannot.

**Proof**: run `PATH=/nonexistent bash ci/android` (or temporarily shadow `adb` with a
failing stub) and confirm a non-zero exit with the "adb not found" message. Run with `adb`
present and no device and confirm the skip line. Run with `CI_REQUIRE_DEVICE=1` and no
device and confirm the failure.

**Risk**: the CI host may routinely run without a tablet, in which case a hard failure
turns main red for a condition nobody intends to fix. Decide which of the two skip
policies applies before implementing, since that is a judgment about the host and not
about the script. Separately, `dashboard/docs/backlog.md` reports that
`test/android-smoke.js` is stale after the gear-panel split — it clicks `#settings summary`
and `#tab-devices` where the current markup wants `#subtab-settings` and `#subtab-devices`.
I did not verify that against `settings.jsx`. If it holds, making this branch fail loudly
will surface that staleness the first time a device is attached, so fix the selectors in
the same change or expect the first red run.

## 6. `ci/simple-ci.conf` sources a config that may not exist

Verified. `ci/simple-ci.conf:7` is `. "$HOME/.config/simple-ci.conf"` with no guard.
`sci` (`/home/john/bin/sci`) runs under `set -euo pipefail` and its `load_conf` sources the
first file it finds from `$CI_CONF`, `./ci/simple-ci.conf`, `$HOME/.config/simple-ci.conf`,
`<script-dir>/simple-ci.conf` — so from the repo root, `ci/simple-ci.conf` wins and pulls
the home config in itself. On a runner or fresh clone with no `~/.config/simple-ci.conf`,
the dot command fails and `set -e` aborts `sci` with a bare "No such file or directory"
naming a path, and nothing naming what the missing settings are for.

The home config on this machine defines `CI_HOSTS`, `CI_HOST`, `CI_REMOTE_SCRIPT` and
`CI_SERVER_URL`; `ci/simple-ci.conf` then overrides `CI_HOST=gpu`.

**Files**: `ci/simple-ci.conf`.

**Change**: guard the source and say what is missing when it is:

    if [ -f "$HOME/.config/simple-ci.conf" ]; then
        . "$HOME/.config/simple-ci.conf"
    else
        echo "ci/simple-ci.conf: no ~/.config/simple-ci.conf; set CI_SERVER_URL and CI_REMOTE_SCRIPT there" >&2
    fi

Warn rather than exit: `sci` already fails with a usable message of its own when the
values are missing — `: "${CI_SERVER_URL:?CI_SERVER_URL must be set in simple-ci.conf}"` —
and a subcommand that needs neither should still work. Keep the existing comment block
explaining why the merge is done by hand; it is still accurate.

**Proof**: `HOME=$(mktemp -d) sci <some-subcommand>` from the repo root prints the warning
and then `sci`'s own `CI_SERVER_URL must be set` message, instead of "No such file or
directory". With the real `HOME`, behavior is unchanged.

**Risk**: low, and confined to this repo's config file. The one thing to check is that
turning a hard abort into a warning does not let a command run far enough to do something
half-configured. Every `sci` subcommand I looked at asserts its required variables with
`:?` before acting, but I did not read all of them.
