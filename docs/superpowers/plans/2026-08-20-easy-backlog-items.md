# Easy Backlog Items Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clear the backlog items in `receiver/docs/backlog.md` that are small, self-contained, and verifiable without hardware: the `src_filter` glob, the unpinned library dependency, the inert `LOG_LEVEL` guard, and the silent NVS-failure path in `alias_store::remove()`.

**Architecture:** Each task is an isolated edit to one or two files in `receiver/`, verified with a local `pio run` build (no flashing, no hardware). No new modules, no behavior change to the decode path.

**Tech Stack:** PlatformIO (`esp32s3-generic` env), Arduino/C++, ArduinoJson 7.

## Global Constraints

- Build with `platformio run -e esp32s3-generic` from `receiver/`. All four tasks must leave this build green.
- Do not touch `.env` / WiFi credentials, the decode path's `JsonDocument` handling, or anything requiring hardware to verify — those are separate, harder backlog items and out of scope here.
- Delete the corresponding paragraph from `receiver/docs/backlog.md` in the same commit that lands each fix (per this repo's doc convention: a backlog item is deleted in the commit that lands the work).
- Commit messages: `fix(receiver): ...`, one commit per task.

---

### Task 1: `src_filter` excludes by shape, not by exact name

**Files:**
- Modify: `receiver/platformio.ini:24`
- Modify: `receiver/docs/backlog.md` (delete the "`src_filter` excludes `probe` by name, not by shape" section)

**Model:** `haiku` — single-line config edit plus a doc deletion.

**Interfaces:**
- Consumes: nothing
- Produces: nothing (leaf change)

- [ ] **Step 1: Read the current filter line**

`receiver/platformio.ini:24` currently reads:

```ini
src_filter = +<*> -<test> -<probe>
```

- [ ] **Step 2: Change the exclusions to match by prefix, and add `.pio`**

```ini
src_filter = +<*> -<test> -<probe*> -<.pio>
```

`-<probe*>` excludes `probe/`, `probe2/`, or any other `probe`-prefixed scratch directory. `-<.pio>` excludes PlatformIO's own build-output directory, which a sibling PlatformIO project (or a stray local build) can otherwise leave under `receiver/`.

- [ ] **Step 3: Build to verify**

Run from `receiver/`:

```bash
platformio run -e esp32s3-generic
```

Expected: build succeeds (`SUCCESS` in the summary), same as before the change. `receiver/probe/` (present today per `git status`) must NOT appear in the compiled object list — confirm with:

```bash
platformio run -e esp32s3-generic -v 2>&1 | grep -i "probe/"
```

Expected: no output.

- [ ] **Step 4: Update the backlog**

Delete the "`src_filter` excludes `probe` by name, not by shape" section (currently `receiver/docs/backlog.md:66-73`) — the fix lands in this commit.

- [ ] **Step 5: Commit**

```bash
cd receiver
git add platformio.ini docs/backlog.md
git commit -m "fix(receiver): src_filter excludes probe*/ and .pio by shape"
```

---

### Task 2: Pin the `rtl_433_ESP` dependency to a commit, not a branch

**Files:**
- Modify: `receiver/platformio.ini:13`
- Modify: `receiver/docs/backlog.md` (delete the "The library dependency is pinned to a branch, not a commit" section)

**Model:** `haiku` — single-line config edit, sha already resolved below.

**Interfaces:**
- Consumes: nothing
- Produces: nothing (leaf change)

- [ ] **Step 1: Confirm the current head of the branch**

Run:

```bash
git ls-remote https://github.com/jbroll/rtl_433_ESP.git sx1231-support
```

Expected output (re-run before committing in case the branch moved since this plan was written):

```
61170ad6081ed394ac1c5aaef6919fb8788e8448	refs/heads/sx1231-support
```

Use whatever sha this command actually returns at execution time, not a stale value from this plan.

- [ ] **Step 2: Pin `platformio.ini` to that commit**

`receiver/platformio.ini:13` currently reads:

```ini
rtl_433_ESP = https://github.com/jbroll/rtl_433_ESP.git#sx1231-support  ; Builds library from source directory
```

Change the `#` ref to the sha from Step 1:

```ini
rtl_433_ESP = https://github.com/jbroll/rtl_433_ESP.git#61170ad6081ed394ac1c5aaef6919fb8788e8448  ; Builds library from source directory
```

- [ ] **Step 3: Force PlatformIO to re-resolve the pinned dependency and build**

PlatformIO caches the previous resolution under `.pio/libdeps/`; clear it so the pin actually takes effect:

```bash
cd receiver
rm -rf .pio/libdeps/esp32s3-generic/rtl_433_ESP
platformio run -e esp32s3-generic
```

Expected: build succeeds. Confirm the checked-out commit matches:

```bash
git -C .pio/libdeps/esp32s3-generic/rtl_433_ESP rev-parse HEAD
```

Expected: matches the sha from Step 1.

- [ ] **Step 4: Update the backlog**

Delete the "The library dependency is pinned to a branch, not a commit" section (currently `receiver/docs/backlog.md:75-81`).

- [ ] **Step 5: Commit**

```bash
git add platformio.ini docs/backlog.md
git commit -m "fix(receiver): pin rtl_433_ESP dependency to a commit sha"
```

---

### Task 3: `LOG_LEVEL` fallback is a no-op expression, not a `#define`

**Files:**
- Modify: `receiver/WebReceiver.ino:441-443`
- Modify: `receiver/docs/backlog.md` (delete the `LOG_LEVEL` bullet from "Smaller items")

**Model:** `haiku` — single-line code fix, self-contained.

**Interfaces:**
- Consumes: nothing
- Produces: nothing (leaf change)

- [ ] **Step 1: Read the current guard**

`receiver/WebReceiver.ino:441-444` currently reads:

```cpp
#ifndef LOG_LEVEL
  LOG_LEVEL_SILENT
#endif
  Log.begin(LOG_LEVEL, &Serial0);
```

`LOG_LEVEL_SILENT` alone is a bare expression statement (it evaluates and discards a constant); it does not define `LOG_LEVEL`, so `Log.begin(LOG_LEVEL, ...)` on the next line would fail to compile if `LOG_LEVEL` were ever genuinely undefined.

- [ ] **Step 2: Make it an actual `#define`**

```cpp
#ifndef LOG_LEVEL
  #define LOG_LEVEL LOG_LEVEL_SILENT
#endif
  Log.begin(LOG_LEVEL, &Serial0);
```

- [ ] **Step 3: Verify the normal (defined) build still compiles**

```bash
cd receiver
platformio run -e esp32s3-generic
```

Expected: build succeeds — the build always defines `LOG_LEVEL` via a `-D` flag, so this path doesn't exercise the fallback, but it must not regress.

- [ ] **Step 4: Verify the fallback branch actually compiles**

Temporarily build with `LOG_LEVEL` undefined to exercise the `#ifndef` branch itself:

```bash
platformio run -e esp32s3-generic -O "build_flags = -DLOG_LEVEL_SILENT_TEST_ONLY"
```

If the project's `-D LOG_LEVEL=...` flag is injected unconditionally elsewhere (e.g. via `load_env.py` or a `[env]` `build_flags` line), this override won't actually undefine it — in that case, just temporarily comment out whatever `-D LOG_LEVEL=...` flag is present, rerun `platformio run -e esp32s3-generic`, confirm it still compiles, then restore the flag. Either way, the goal is: build once with `LOG_LEVEL` truly undefined and confirm no compile error.

- [ ] **Step 5: Update the backlog**

Delete the `WebReceiver.ino:244-246` bullet from the "Smaller items" list (currently the first bullet under `receiver/docs/backlog.md:160-165`; the line numbers cited there are stale — the guard is now at `WebReceiver.ino:441-444`).

- [ ] **Step 6: Commit**

```bash
git add WebReceiver.ino docs/backlog.md
git commit -m "fix(receiver): LOG_LEVEL fallback is a real #define"
```

---

### Task 4: `alias_store::remove()` silently ignores a failed NVS write

**Files:**
- Modify: `receiver/alias_store.cpp:141-149`
- Modify: `receiver/web_ui.cpp:329-334`
- Modify: `receiver/docs/backlog.md` (delete the `alias_store::remove()` bullet from "Smaller items")

**Model:** `sonnet` — touches two files and changes an HTTP handler's error path; needs the caller/callee contract kept consistent.

**Interfaces:**
- Consumes: `alias_store::persist()` (existing, `static bool persist()` at `alias_store.cpp:76`, unchanged)
- Produces: `alias_store::remove(const char* topic)` now returns `false` (in addition to the existing "not found" case) when the NVS write fails, matching the shape `alias_store::set()` already uses. `web_ui.cpp`'s `handleAliasPost()` must check this return value.

- [ ] **Step 1: Read the current `remove()` and its caller**

`receiver/alias_store.cpp:141-149`:

```cpp
bool remove(const char* topic) {
  int i = find(topic);
  if (i < 0) {
    return false;
  }
  _used[i] = false;
  persist();
  return true;
}
```

`receiver/web_ui.cpp:328-334` (inside `handleAliasPost()`):

```cpp
const char* name = doc.as<const char*>();
if (*name == '\0') {
  alias_store::remove(path);
} else if (!alias_store::set(path, name)) {
  sendStatus(503, "alias store full");
  return;
}
```

`persist()`'s return value is dropped, so a failed NVS write after a removal is silent — the alias reads as gone until the next boot, when it reappears.

- [ ] **Step 2: Make `remove()` roll back on a failed persist, mirroring `set()`**

Replace `receiver/alias_store.cpp:141-149` with:

```cpp
bool remove(const char* topic) {
  int i = find(topic);
  if (i < 0) {
    return false;
  }
  _used[i] = false;
  if (persist()) {
    return true;
  }
  _used[i] = true;
  return false;
}
```

This matches the rollback shape `set()` already uses at `alias_store.cpp:130-138`: mutate in RAM, attempt to persist, undo the RAM mutation and report failure if persistence failed. The alias stays active (in RAM and on the next boot) exactly when the removal did not durably take effect.

- [ ] **Step 3: Report the failure from `handleAliasPost()`**

Replace `receiver/web_ui.cpp:328-334` with:

```cpp
const char* name = doc.as<const char*>();
if (*name == '\0') {
  if (!alias_store::remove(path)) {
    sendStatus(503, "alias remove failed");
    return;
  }
} else if (!alias_store::set(path, name)) {
  sendStatus(503, "alias store full");
  return;
}
```

Use `"alias remove failed"`, not `"alias store full"` — a remove failure means the NVS write failed, not that the store ran out of slots, and the message a client sees should say which happened.

- [ ] **Step 4: Extend `alias_store::selfTest()` to check the return value**

`receiver/alias_store.cpp:198` already has:

```cpp
ok &= check("removing an unset topic reports false", !remove("s/M/1/$alias"));
```

Add a case covering a successful removal's return value, right after the existing removal test around `alias_store.cpp:207-211`:

```cpp
ok &= check("removing a set topic reports true", remove("s/M/2/$alias"));
```

Read the surrounding test (`alias_store.cpp:197-214`) first to place this in a spot that doesn't disturb the index assertions that follow it — the removal at `:207` already happens; this step is about capturing the return value of that same call in the `ok &=` chain rather than discarding it, so change:

```cpp
remove("s/M/2/$alias");
```

to:

```cpp
ok &= check("removing a set topic reports true", remove("s/M/2/$alias"));
```

- [ ] **Step 5: Build to verify**

```bash
cd receiver
platformio run -e esp32s3-generic
```

Expected: build succeeds. `selfTest()` only runs on-device under `FAKE_SIGNALS` (per the backlog's "self-test has never been read on a device" item), so this step confirms compilation only, not runtime behavior — do not claim the self-test passed.

- [ ] **Step 6: Update the backlog**

Delete the `alias_store::remove()` bullet from the "Smaller items" list (currently `receiver/docs/backlog.md:170-172`).

- [ ] **Step 7: Commit**

```bash
git add alias_store.cpp web_ui.cpp docs/backlog.md
git commit -m "fix(receiver): alias_store::remove() reports persist failure"
```

---

## Self-Review

**Spec coverage:** Four backlog items map one-to-one to Tasks 1–4: `src_filter` shape (Task 1), branch-pinned dependency (Task 2), inert `LOG_LEVEL` guard (Task 3), silent `alias_store::remove()` failure (Task 4). Remaining backlog items (false-decode filtering, non-433 sensor I/O, noise-floor UI marking, `RegIrqFlags1`, decode-path allocation, slow-client stall, SSE churn, flash size, WiFi provisioning, unread self-test, unverified alias-reboot survival, and the two smaller items about `REPLAY_PER_LOOP` and the keepalive write-failure path) all need either a design decision, hardware access, or a larger diff, and are intentionally out of scope.

**Placeholder scan:** No TBD/TODO; every step has literal code or exact commands.

**Type consistency:** `alias_store::remove()`'s signature (`bool remove(const char* topic)`) is unchanged; only its return semantics on the persist-failure path change, and `web_ui.cpp`'s caller is updated to match in the same task.
