# Split receiver docs to match the bridge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the receiver its own `docs/install.md` and `docs/development.md`, shrink `receiver/README.md` to an intro plus a links list, fold the remaining about-sections into `receiver/docs/user-manual.md`, and remove the now-done backlog and roadmap entries.

**Architecture:** Pure documentation refactor. Content moves verbatim between existing files; the only new prose is a short `## Layout` section in the receiver's new `development.md`, written in the bridge's code-block style. Link paths adjust when content crosses directories.

**Tech Stack:** Markdown, relative links. No code, no tests beyond verification greps and diffs.

## Global Constraints

- Moved sections are byte-identical to their `receiver/README.md` source except heading level and the `# Install` / `# Development` titles, and except the one link that must change (`../dashboard/README.md` → `../../dashboard/README.md` in the `Testing without a radio` section).
- Every relative link must resolve from its new location.
- Each moved heading appears in exactly one file when the plan completes.
- Delete `docs/superpowers/specs/2026-08-19-receiver-docs-split-design.md` and `docs/superpowers/plans/2026-08-19-receiver-docs-split.md` in the final commit.
- No content rewrite of moved sections. No `quickstart.md` work.

---

### Task 1: Create `receiver/docs/install.md`

**Files:**
- Create: `receiver/docs/install.md`

**Interfaces:**
- Produces: `receiver/docs/install.md`, a standalone install guide containing the four sections `## Requirements`, `## Wiring`, `## Configure`, `## Build and flash`. Task 3's README links list points at it.

- [ ] **Step 1: Write the file**

```markdown
# Install

## Requirements

An ESP32-S3 and an SX1231/RFM69 radio module, wired as below.

The library dependency is a fork,
[jbroll/rtl_433_ESP](https://github.com/jbroll/rtl_433_ESP) branch
`sx1231-support`, which adds SX1231/RF69 receive support upstream does not have.
`platformio.ini` points at it and PlatformIO fetches it on the first build.

Node 22 or newer. `pio run` runs `dashboard/build.js` to generate the page it serves,
so run `npm install` in `../dashboard` before the first `pio run` — its `build.js`
imports `esbuild` from `dashboard/node_modules`.

## Wiring

| Signal | GPIO |
|---|---|
| MISO | 1 |
| MOSI | 42 |
| SCK | 41 |
| CS (NSS) | 40 |
| RST | 39 |
| DIO0 (IRQ) | 38 |
| DIO1 | 47 |
| DIO2 (data) | 21 |

DIO2 carries the demodulated data and is the pin the decoder reads. Change the
`RF_MODULE_*` values in `platformio.ini` to match your board.

## Configure

    cp .env.example .env

Fill in `WIFI_SSID`, `WIFI_PASSWORD`, and `MDNS_PREFIX`. `.env` is bash
syntax, gitignored, and read by `load_env.py`, which turns each entry into a
`-D` build flag. The build stops with an `#error` if it is absent.

The radio pin map and OOK settings are in `platformio.ini`.

## Build and flash

    pio run -e esp32s3-generic
    pio run -e esp32s3-generic -t upload
```

- [ ] **Step 2: Verify the moved sections are verbatim**

Run: `diff <(sed -n '7,49p' receiver/README.md) <(tail -n +3 receiver/docs/install.md)`
Expected: no output (README lines 7–49 equal install.md from line 3 on).

- [ ] **Step 3: Commit**

```bash
git add receiver/docs/install.md
git commit -m "docs(receiver): split install material out of the README"
```

---

### Task 2: Create `receiver/docs/development.md`

**Files:**
- Create: `receiver/docs/development.md`

**Interfaces:**
- Produces: `receiver/docs/development.md` with `## Layout`, `## Serial monitor`, `## Testing without a radio`. Task 3's README links list points at it.

- [ ] **Step 1: Write the file**

```markdown
# Development

## Layout

```
WebReceiver.ino            entry point: setup loop, decode dispatch
platformio.ini             build config, radio pin map, OOK settings
load_env.py                .env -> -D build flags
signal_store.cpp/.h        last message and alias storage
web_ui.cpp/.h              HTTP and SSE surface
topic.cpp/.h               topic and filter matching, no Arduino dependency
radio_health.cpp/.h        radio health monitoring and recovery
device_hooks.cpp/.h        per-decode field checks
health_store.cpp/.h        receiver health state
tz_store.cpp/.h            GMT offset storage
monitor.py                 headless serial monitor
test/                      host topic tests, binding spec, fixtures
docs/                      these pages
```

## Serial monitor

`pio device monitor` needs an interactive terminal, so it fails when run through
a pipe or from a non-interactive session. Use `monitor.py` instead:

    python3 monitor.py

Run for a fixed duration, timestamp lines, and suppress startup noise:

    python3 monitor.py --duration 30 --timestamp --quiet

`monitor.py` auto-detects the first USB serial port and reads the baud rate from
`platformio.ini`. Pass `--port` and `--baud` to override. It resets the board on
connect by default; use `--no-reset` to leave it running.

## Testing without a radio

Uncomment `'-DFAKE_SIGNALS=true'` in `platformio.ini`. The sketch injects a
synthetic decode every 3 seconds and runs `signal_store::selfTest()` at startup,
printing a PASS/FAIL line per check over serial.

Set `'-DFAKE_RADIO_FAIL_MS=900000'` (15 minutes) to exercise the recovery
path: the synthetic decode stops and the health state moves to `silent` +
`pinned` (floor pinned below threshold), triggering a soft re-init after the
window closes; after enough unconfirmed soft re-inits the ladder escalates to
a reboot.

`topic.cpp` has no Arduino dependency and is host-tested: `bash test/host/run.sh`
compiles and runs it on the host.

`test/binding.spec.js` covers the HTTP binding against `test/binding-server.js`, a JS
model of the same surface, so it runs without a board: `npm install` once, then `npx
playwright test`. The dashboard has [its own suite](../../dashboard/README.md).
```

- [ ] **Step 2: Verify the moved sections are verbatim**

Run: `diff <(sed -n '51,64p' receiver/README.md) <(awk '/^## Serial monitor/{f=1;next}/^## Testing without/{f=0}f' receiver/docs/development.md)`
Expected: no output.

Run: `diff <(sed -n '129,146p' receiver/README.md) <(awk '/^## Testing without/{f=1;next}f' receiver/docs/development.md)`
Expected: exactly one difference — the final link is `../../dashboard/README.md` in the new file, `../dashboard/README.md` in the source. That is the required directory-level link fix.

- [ ] **Step 3: Verify the Layout block renders as a code block**

Run: `sed -n '/^## Layout/,/^## Serial monitor/p' receiver/docs/development.md`
Expected: the layout file list sits inside one fenced code block; there is no stray fence (the block opens with three backticks on its own line and closes the same way).

- [ ] **Step 4: Commit**

```bash
git add receiver/docs/development.md
git commit -m "docs(receiver): split development material out of the README"
```

---

### Task 3: Rewrite `receiver/README.md`

**Files:**
- Modify: `receiver/README.md` (full rewrite of everything below the intro)

**Interfaces:**
- Consumes: `receiver/docs/install.md`, `receiver/docs/development.md` (Tasks 1–2), plus the pre-existing `receiver/docs/user-manual.md` and `receiver/docs/architecture.md`.

- [ ] **Step 1: Replace the file contents**

```markdown
# rtl433-web-receiver

An ESP32-S3 with an SX1231/RFM69 radio at 433.92 MHz. It decodes 433 MHz sensors
with [rtl_433_ESP](https://github.com/NorthernMan54/rtl_433_ESP), joins WiFi, and
serves a page listing every signal it hears, updating as they arrive.

- [`docs/install.md`](docs/install.md) — wiring, `.env`, build and flash
- [`docs/user-manual.md`](docs/user-manual.md) — every route, status, topic, and limit
- [`docs/architecture.md`](docs/architecture.md) — module boundaries and the tradeoffs
- [`docs/development.md`](docs/development.md) — repo layout, the serial monitor, and testing without a radio
```

- [ ] **Step 2: Verify every moved heading is gone from the README**

Run: `rg -n '^## (Requirements|Wiring|Configure|Build and flash|Serial monitor|Use|The HTTP surface|The page|Limits|Testing without a radio)$' receiver/README.md`
Expected: no matches (exit code 1).

- [ ] **Step 3: Verify the links list resolves**

Run: `for f in receiver/docs/install.md receiver/docs/user-manual.md receiver/docs/architecture.md receiver/docs/development.md; do test -f "$f" || echo "MISSING $f"; done`
Expected: no output.

Run: `rg -n '^# ' receiver/docs/install.md receiver/docs/user-manual.md receiver/docs/architecture.md receiver/docs/development.md`
Expected: each file has a `# ` title line, so the README links point at real documents.

- [ ] **Step 4: Commit**

```bash
git add receiver/README.md
git commit -m "docs(receiver): README keeps only the intro and the docs links"
```

---

### Task 4: Fold the about-sections into `receiver/docs/user-manual.md`

**Files:**
- Modify: `receiver/docs/user-manual.md`

**Interfaces:**
- Consumes: the `Use`, `The HTTP surface`, `The page`, and `Limits` content from the old `receiver/README.md` (already removed in Task 3).
- Produces: the final user-manual with `## Use` (new), binding framing and stamping note in `## Topics`, receiver-architecture link and build paragraph in `## The page`, and `## Limits` (new).

- [ ] **Step 1: Insert `## Use` before `## Routes`**

Insert immediately before the existing `## Routes` heading:

```markdown
## Use

The mDNS name is `MDNS_PREFIX` plus the low three bytes of the MAC, so two
boards on one network do not collide. It is printed at startup along with the
IP address: `mDNS started: rtl433-a1b2c3.local`.

WiFi is not required to decode. If it is unavailable the sketch keeps decoding
and logging to serial, and retries every 30 seconds, though the first connect
attempt times out after 20 seconds before the receiver starts.

```

- [ ] **Step 2: Prepend the binding framing to `## Topics`**

Insert before the first paragraph of `## Topics` ("A topic is `<source>/<model>/<id>` …"):

```markdown
The receiver serves the source-only subset of the
[HTTP binding for MQTT](../../bridge/docs/binding.md): stable
`<source>/<model>/<id>` topics, the rtl_433 message as the payload, and an alias
at every level.

```

- [ ] **Step 3: Add the stamping note to `## Topics`**

Insert after the paragraph that ends "…a receiver reboot restarts today's
count from 0." and before the paragraph beginning "An alias is a topic with…":

```markdown
Every stored message carries `time` (ISO 8601 UTC, from SNTP), `rssi`, and
`count`, stamped in by the receiver. Until the clock is set `time` is absent and
the page ages that device from when it arrived.

```

- [ ] **Step 4: Replace the `## The page` body**

Replace the existing `## The page` body with:

```markdown
## The page

The receiver serves a build of the [dashboard](../../dashboard/README.md). See
[its user manual](../../dashboard/docs/user-manual.md) for the tabs, the card grid, and
edit mode, and [architecture.md](architecture.md) for the receiver's own card and its
telemetry fields.

`build` rides on the telemetry message. The page keeps the first id it sees and
reloads itself when a later one differs, so a reflash reboots the device, the
stream reconnects, and every open browser picks up the new page.
```

The existing body already links the dashboard and its user manual; the replacement
adds the `[architecture.md](architecture.md)` link and the `build` paragraph. The
section keeps its `## The page` heading.

- [ ] **Step 5: Add `## Limits` before `## Cross-origin`**

Insert between the end of `## The page` and the `## Cross-origin` heading:

```markdown
## Limits

- 24 devices tracked; a new decode evicts the least recently seen device once
  the table is full, and a slot unheard from for `DEVICE_STALE_HOURS` (72 by
  default, `0` to disable) is freed on its own. Weather sensors transmit every
  16–60 seconds, so the default only clears a genuinely dead one. Raise it if
  you receive TPMS, which is silent while a car is parked, or door contacts and
  remotes, which transmit only when triggered.
- payloads up to 600 bytes; a longer one is dropped rather than truncated
- 32 aliases
- 4 concurrent SSE clients, each subscribing up to 4 filters; a fifth client
  evicts the longest-attached one, whose browser reconnects on its own
- the radio monitors its own health once a minute; a stuck or parked radio is
  recovered by re-running the radio init, or by rebooting if the init fails.
  `radio_ok`, `recovery_count`, and `last_recovery_s` on the receiver's card
  carry the state

```

- [ ] **Step 6: Verify the four new or extended sections**

Run: `rg -n '^## (Use|Topics|The page|Limits|Cross-origin)$' receiver/docs/user-manual.md`
Expected: `## Use` before `## Routes`; `## Topics` contains both new paragraphs (binding framing then stamping note); `## The page` contains the architecture link and the `build` paragraph; `## Limits` sits between `## The page` and `## Cross-origin`.

Run: `test -f receiver/docs/../../bridge/docs/binding.md && echo ok`
Expected: `ok` — the binding link target exists.

- [ ] **Step 7: Commit**

```bash
git add receiver/docs/user-manual.md
git commit -m "docs(receiver): fold the remaining README sections into the user manual"
```

---

### Task 5: Remove the done entries from `docs/backlog.md` and `ROADMAP.md`

**Files:**
- Modify: `docs/backlog.md`
- Modify: `ROADMAP.md`

- [ ] **Step 1: Delete the backlog section**

Remove the entire `## The receiver has no `install.md` or `development.md`` section (heading plus its paragraph) from `docs/backlog.md`. The file then starts with the `## No quickstart anywhere` section.

- [ ] **Step 2: Trim the ROADMAP cross-cutting debt bullet**

In `ROADMAP.md`, change the "Cross-cutting debt" paragraph to:

```markdown
Cross-cutting debt: no `quickstart.md` anywhere; no single command runs
all four test suites; the dashboard suite runs against a fake bridge.
```

- [ ] **Step 3: Trim the ROADMAP Goal 1 action**

In `ROADMAP.md`, change the quickstart action bullet to:

```markdown
- Write `docs/quickstart.md` at the root and one per sub-project.
```

- [ ] **Step 4: Verify**

Run: `rg -n 'The receiver has no|carries material the bridge splits|into `receiver/docs/install.md`' docs/backlog.md ROADMAP.md`
Expected: no matches — the backlog section is gone, ROADMAP line 32 no longer mentions the split, and the Goal 1 action no longer contains it.

Run: `rg -n 'quickstart' ROADMAP.md`
Expected: the cross-cutting-debt line and the Goal 1 action still mention `quickstart.md` (unchanged).

- [ ] **Step 5: Commit**

```bash
git add docs/backlog.md ROADMAP.md
git commit -m "docs: drop the receiver install/development split from backlog and roadmap"
```

---

### Task 6: Final verification and cleanup

**Files:**
- Delete: `docs/superpowers/specs/2026-08-19-receiver-docs-split-design.md`
- Delete: `docs/superpowers/plans/2026-08-19-receiver-docs-split.md`

- [ ] **Step 1: Confirm each moved heading lives in exactly one file**

Run: `rg -l '^## (Requirements|Wiring|Configure|Build and flash|Serial monitor|Testing without a radio|Limits)$' receiver/`
Expected: `receiver/docs/install.md` holds Requirements, Wiring, Configure, Build and flash; `receiver/docs/development.md` holds Serial monitor and Testing without a radio; `receiver/docs/user-manual.md` holds Limits; `receiver/README.md` matches none.

- [ ] **Step 2: Confirm no broken links were introduced**

Run: `rg -o '\]\([^)]+\)' receiver/README.md receiver/docs/ | sort -u`
Expected: every relative target exists. For any `../` link, confirm the target exists relative to the file that contains it.

- [ ] **Step 3: Delete the spec and plan documents**

```bash
git rm docs/superpowers/specs/2026-08-19-receiver-docs-split-design.md docs/superpowers/plans/2026-08-19-receiver-docs-split.md
```

- [ ] **Step 4: Final diff review**

Run: `git diff --stat origin/main..HEAD` (or `git log --oneline -10`)
Expected: five feature commits plus the cleanup; the only deletions in the final commit are the spec and plan documents.

- [ ] **Step 5: Commit**

```bash
git commit -m "docs: remove working spec and plan documents"
```