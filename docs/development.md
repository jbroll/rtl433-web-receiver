# Development

This repo contains four sub-projects. Each is built, tested, and released on its own:

- [`receiver/`](../receiver/README.md) — ESP32-S3 firmware
- [`bridge/`](../bridge/README.md) — Node service bridging MQTT to HTTP
- [`dashboard/`](../dashboard/README.md) — browser dashboard
- [`app/`](../app/README.md) — Capacitor shell for mobile builds

## Build and test

Each sub-project has its own build and test commands. See the README in each directory.

For the dashboard:

```bash
cd bridge && npm install     # dashboard/test/harness.js runs the real bridge
cd ../dashboard
npm install
npm test
npm run build
```

`bin/test.sh` runs every sub-project's suite in one command: the receiver's host tests and
its Playwright binding suite, then bridge and dashboard `npm test`. It expects
`node_modules` to already exist in each sub-project, and needs `pio` (PlatformIO) on
`PATH` with `receiver/.pio/libdeps/` already populated, since the receiver's host suite
compiles against the ArduinoJson headers PlatformIO fetches and also runs a full `pio run`
of the firmware. On a fresh clone, install and prime all of that first:

```bash
npm ci --prefix receiver
npm ci --prefix bridge
npm ci --prefix dashboard
(cd receiver && pio run)   # one-time: fetches ArduinoJson into .pio/libdeps/
bin/test.sh
```

## CI

`ci/android` (run by simple-ci on the `gpu` host from a worktree of this repo) runs
`receiver/test/host/run.sh` alongside the rest of the suite. It needs PlatformIO on
`PATH` from a dedicated virtualenv at `~/.venv/platformio` on that host — not the
system Python. Set it up once:

```bash
python3 -m venv ~/.venv/platformio
~/.venv/platformio/bin/pip install platformio
```

The job fails loudly if `~/.venv/platformio/bin/pio` is missing. The first `pio run`
on a host downloads the ESP32 toolchain and every `lib_deps` entry (ArduinoJson,
ArduinoLog, PubSubClient, rtl_433_ESP, Adafruit BMP280 Library); warm that cache by
hand after setting up the venv so the first CI run doesn't time out:

```bash
export PATH="$HOME/.venv/platformio/bin:$PATH"
npm ci --prefix dashboard   # build_dashboard.py embeds a built dashboard into the firmware
(cd receiver && pio run -e esp32s3-generic && pio run -e esp32s3-generic-fakesignals)
```

## Worktrees and merges

Feature work happens in isolated worktrees. Each worktree is a named branch that splits from `main`.

Merges into `main` must be fast-forwards. Before merging, rebase the worktree onto the current `main`:

```bash
git checkout feature/my-branch
git rebase main
git checkout main
git merge --ff-only feature/my-branch
```

A `prepare-commit-msg` hook in `.githooks/` rejects merge commits that are not fast-forwards. Point git at it:

```bash
git config core.hooksPath .githooks
```

Non-fast-forward merges are rejected with an error telling you to rebase first. The local config also guards against accidental non-FF merges:

```bash
git config merge.ff only
```
