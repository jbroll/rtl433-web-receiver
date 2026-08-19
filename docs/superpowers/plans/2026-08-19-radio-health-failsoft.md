# Radio Health Fail-Soft Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove every source of radio unreliability the radio-health feature introduced while keeping its detection and telemetry: no `esp_restart()` in the recovery path, a non-blocking fail-soft temperature read, and no debug logging.

**Architecture:** The `radio_health` module (Arduino-free, host-tested) drops the `reboot` action and the `frozen` detection it fed. `WebReceiver.ino`'s temperature read becomes a single `setMode` attempt with the measurement skipped on failure, and `monitorRadioHealth()` stops calling `esp_restart()`. Docs and the `FROZEN_MS` build flag are updated to match.

**Tech Stack:** C++17 (Arduino/PlatformIO firmware for ESP32-S3), host `g++` tests for the Arduino-free module, `bash test/host/run.sh` for host tests, `pio run` for firmware compile.

## Global Constraints

- Do not touch the RFM69CW pinout or BMP280 work from commit `655f8ca` (out of scope).
- `SILENT_MS=180000`, `NOISE_FLOOR_DBM=-120`, `RECOVERY_BACKOFF_MS=120000` stay as build flags; only `FROZEN_MS` is removed.
- `radioBackInRx` keeps its corrected compare from `abe3b14` (compare `SPIgetRegValue(REG_OP_MODE, 4, 2)` against `RADIOLIB_RF69_RX` itself).
- `health_store` telemetry (`boot_count`, `recovery_count`, `last_recovery_s`, `radio_ok`, `coredump_pending`) is unchanged.
- Every commit must leave the tree green: `bash test/host/run.sh` passes and `pio run` compiles.
- No code comments beyond what already exists in the touched functions.

---

### Task 1: radio_health drops the reboot action and frozen detection

The `frozen` state had one consumer: the `silent && frozen && !pinned -> reboot`
branch. With `esp_restart()` removed (Task 2 removes the firmware's only call
site), `frozen` is dead. Remove the `reboot` action, the `frozen` parameter of
`decide()`, the `lastFloor`/`floorSince` state, and the `FROZEN_MS` flag.
`WebReceiver.ino` still references `HealthAction::reboot`, so this task also
removes that branch to keep the tree compiling.

**Files:**
- Modify: `receiver/radio_health.h`
- Modify: `receiver/radio_health.cpp`
- Modify: `receiver/test/host/radio_health_test.cpp`
- Modify: `receiver/WebReceiver.ino:435-459` (`monitorRadioHealth`)
- Modify: `receiver/platformio.ini:54` (remove `-DFROZEN_MS`)

**Interfaces:**
- Consumes: nothing (self-contained).
- Produces: `radio_health::HealthAction` becomes `{ none, softReinit }`;
  `HealthState` becomes `{ lastDecodeAt, lastRecoveryAt }`;
  `HealthAction decide(bool silent, bool pinned, unsigned long elapsedMs)`;
  `HealthAction evaluate(HealthState&, unsigned long now, int floor,
  unsigned long lastDecodeAt)` unchanged in signature.

- [ ] **Step 1: Rewrite the host test to the new behavior**

Replace the whole file `receiver/test/host/radio_health_test.cpp` with:

```cpp
#include <stdio.h>

#include "radio_health.h"

static int failures = 0;

static void check(const char* what, bool ok) {
  printf("%-64s %s\n", what, ok ? "PASS" : "FAIL");
  if (!ok) failures++;
}

static const unsigned long NEVER = ~0UL;

int main() {
  // quiet-band no-op
  check("a quiet band with a healthy floor takes no action",
        radio_health::decide(true, false, NEVER) == radio_health::HealthAction::none);
  // parked -> soft
  check("a parked radio (silent + pinned) soft re-inits",
        radio_health::decide(true, true, NEVER) == radio_health::HealthAction::softReinit);
  // active radio
  check("an active radio takes no action",
        radio_health::decide(false, true, NEVER) == radio_health::HealthAction::none);
  // backoff
  check("backoff suppresses a re-trigger",
        radio_health::decide(true, true, RECOVERY_BACKOFF_MS - 1) == radio_health::HealthAction::none);
  check("a re-trigger fires again after the backoff",
        radio_health::decide(true, true, RECOVERY_BACKOFF_MS + 1) == radio_health::HealthAction::softReinit);

  // evaluate(): the window computation, the decode reset, and the backoff
  radio_health::HealthState st;
  check("a fresh, active radio is healthy",
        radio_health::evaluate(st, 0, -85, 0) == radio_health::HealthAction::none);
  check("a short quiet period is not yet silent",
        radio_health::evaluate(st, 10000, -85, 0) == radio_health::HealthAction::none);
  check("a pinned floor across the silent window soft re-inits",
        radio_health::evaluate(st, SILENT_MS + 1, NOISE_FLOOR_DBM, 0) == radio_health::HealthAction::softReinit);
  check("a nonzero floor above the noise floor never pins",
        radio_health::evaluate(st, SILENT_MS + 1, -85, 0) == radio_health::HealthAction::none);
  check("a floor of 0 (not yet sampled) never pins",
        radio_health::evaluate(st, SILENT_MS + 1, 0, 0) == radio_health::HealthAction::none);

  radio_health::noteRecovery(st, 200000);
  check("a recovery stamps its time",
        st.lastRecoveryAt == 200000);
  check("the backoff holds the ladder still",
        radio_health::evaluate(st, 300000, NOISE_FLOOR_DBM, 0) == radio_health::HealthAction::none);
  check("the ladder climbs again after the backoff",
        radio_health::evaluate(st, 400000, NOISE_FLOOR_DBM, 0) == radio_health::HealthAction::softReinit);
  radio_health::HealthAction a = radio_health::evaluate(st, 500000, NOISE_FLOOR_DBM, 500000);
  check("a decode clears the recovery state",
        a == radio_health::HealthAction::none && st.lastRecoveryAt == 0);

  printf("%s\n", failures == 0 ? "radio_health: PASS" : "radio_health: FAIL");
  return failures == 0 ? 0 : 1;
}
```

- [ ] **Step 2: Run the host test to verify it fails to compile**

Run: `cd receiver && bash test/host/run.sh`
Expected: FAIL — `radio_health_test.cpp` errors because `decide()` still takes
the `frozen` parameter and `HealthAction::reboot` still exists in the enum.

- [ ] **Step 3: Update `receiver/radio_health.h`**

Replace the whole file with:

```cpp
#pragma once

#include <stdint.h>
#include <limits.h>

// The window constants are build flags on the device (platformio.ini), with
// host defaults here so the host tests exercise the same code paths.
#ifndef SILENT_MS
#define SILENT_MS 180000UL // no decode this long: the silent window
#endif
#ifndef NOISE_FLOOR_DBM
#define NOISE_FLOOR_DBM -120 // averageRssi at/below this: the parked signature
#endif
#ifndef RECOVERY_BACKOFF_MS
#define RECOVERY_BACKOFF_MS 120000UL // suppress re-trigger this long after a soft re-init
#endif

namespace radio_health {

enum class HealthAction : uint8_t { none, softReinit };

// The monitor's state, carried across telemetry cycles. Everything here takes
// time as a parameter, so the module never reads the millis() clock itself.
struct HealthState {
  unsigned long lastDecodeAt = 0;    // uptime ms of the most recent decode, 0 until first
  unsigned long lastRecoveryAt = 0;  // uptime ms of the last soft re-init, 0 until first
};

// Pure decision, host-tested directly. silent/pinned are the window states;
// elapsedMs is uptime since the last recovery (ULONG_MAX if none yet).
HealthAction decide(bool silent, bool pinned, unsigned long elapsedMs);

// One telemetry cycle. now is uptime ms, floor the current averageRssi, and
// lastDecodeAt the uptime ms of the most recent decode. Resets counters when a
// decode arrived since the last cycle, then returns the recovery action.
HealthAction evaluate(HealthState& state, unsigned long now, int floor,
                      unsigned long lastDecodeAt);

// Stamps a completed soft re-init into the state.
void noteRecovery(HealthState& state, unsigned long now);

} // namespace radio_health
```

- [ ] **Step 4: Update `receiver/radio_health.cpp`**

Replace the whole file with:

```cpp
#include "radio_health.h"

namespace radio_health {

HealthAction decide(bool silent, bool pinned, unsigned long elapsedMs) {
  // A chip pinned at or below the noise floor is stuck refusing OP_MODE writes;
  // it survives esp_restart() because the reboot does not power-cycle the radio,
  // so a reboot here only takes the web server down. Soft re-init is the recovery
  // attempt, gated by the backoff, until a power cycle clears the chip.
  if (silent && pinned) {
    if (elapsedMs < RECOVERY_BACKOFF_MS) {
      return HealthAction::none;
    }
    return HealthAction::softReinit;
  }
  return HealthAction::none;
}

HealthAction evaluate(HealthState& state, unsigned long now, int floor,
                      unsigned long lastDecodeAt) {
  if (lastDecodeAt != state.lastDecodeAt) {
    // A decode arrived since the last cycle: it resets the recovery ladder.
    state.lastDecodeAt   = lastDecodeAt;
    state.lastRecoveryAt = 0;
  }
  bool silent = (now - lastDecodeAt) > SILENT_MS;
  // The receiver task reports 0 before its first averaged batch; that is "not
  // sampled", not a floor, so it is not (yet) pinned.
  bool pinned = silent && floor != 0 && floor <= NOISE_FLOOR_DBM;
  unsigned long elapsed = state.lastRecoveryAt == 0 ? ULONG_MAX
                                                    : now - state.lastRecoveryAt;
  return decide(silent, pinned, elapsed);
}

void noteRecovery(HealthState& state, unsigned long now) {
  state.lastRecoveryAt = now;
}

} // namespace radio_health
```

- [ ] **Step 5: Remove the `reboot` branch from `receiver/WebReceiver.ino`**

In `monitorRadioHealth()`, replace lines 452-458:

```cpp
  if (action == radio_health::HealthAction::softReinit) {
    reinitRadio();
    recordRecoveryEvent();
  } else if (action == radio_health::HealthAction::reboot) {
    Log.error(F("radio health: reboot" CR));
    esp_restart();
  }
```

with:

```cpp
  if (action == radio_health::HealthAction::softReinit) {
    reinitRadio();
    recordRecoveryEvent();
  }
```

- [ ] **Step 6: Remove `-DFROZEN_MS` from `receiver/platformio.ini`**

Delete line 54:

```ini
  '-DFROZEN_MS=300000'              ; averageRssi byte-identical this long: the wedged signature
```

- [ ] **Step 7: Run the host test to verify it passes**

Run: `cd receiver && bash test/host/run.sh`
Expected: `radio_health: PASS`, `topic: PASS`, `device_hooks: PASS`, exit 0.

- [ ] **Step 8: Verify the firmware compiles**

Run: `cd receiver && pio run`
Expected: exit 0, `[SUCCESS] Took ...` (incremental build).

- [ ] **Step 9: Commit**

```bash
git add receiver/radio_health.h receiver/radio_health.cpp receiver/test/host/radio_health_test.cpp receiver/WebReceiver.ino receiver/platformio.ini
git commit -m "refactor(receiver): radio health drops the reboot path and frozen state"
```

---

### Task 2: radioTemperature is non-blocking and fails soft

`abe3b14` left the temperature read with a 12-iteration `delay(10)` standby
retry (up to 120ms blocking `loop()`), ~10 `dbg` `Log.warning` lines, and
debug-only register reads firing on every telemetry cycle. Restore a single
`setMode(STANDBY)` attempt: on failure, log one warning and skip the
measurement. The radio is still put back in RX below, so reception resumes
either way.

**Files:**
- Modify: `receiver/WebReceiver.ino:231-271` (`radioTemperature`)

**Interfaces:**
- Consumes: `radio.setMode(RADIOLIB_RF69_STANDBY)`, `Module* radio.getMod()`,
  `RADIOLIB_RF69_REG_TEMP_1/2`, `RADIO_TEMP_TRIES`, `RADIO_TEMP_OFFSET`,
  `radio.receiveDirect()`, `radioBackInRx(mod)`, `reinitRadio()`,
  `recordRecoveryEvent()` (all unchanged).
- Produces: unchanged signature `static int radioTemperature()` returning
  `INT16_MIN` on skip/failure or the temperature in Celsius.

- [ ] **Step 1: Replace the retry loop and debug reads**

In `receiver/WebReceiver.ino`, replace lines 235-271:

```cpp
  // The RF69 defers OP_MODE writes for a while after entering RX (the mode
  // change lands once the receiver settles), so the STANDBY write right after
  // init can time RadioLib's checkback out. Retrying with a delay waits it out.
  int mode = RADIOLIB_ERR_UNKNOWN;
  for (int i = 0; i < 12 && mode != RADIOLIB_ERR_NONE; i++) {
    if (i) {
      delay(10);
    }
    mode = radio.setMode(RADIOLIB_RF69_STANDBY);
    Log.warning(F("dbg setMode standby attempt %d -> %d" CR), i, mode);
  }
  int diow = mod->SPIsetRegValue(RADIOLIB_RF69_REG_DIO_MAPPING_2, 0x07, 5, 0);
  int dior = mod->SPIgetRegValue(RADIOLIB_RF69_REG_DIO_MAPPING_2, 5, 0);
  Log.warning(F("dbg dio2 write=%d read=%d" CR), diow, dior);
  mod->SPIsetRegValue(RADIOLIB_RF69_REG_RSSI_CONFIG, RADIOLIB_RF69_RSSI_START, 1, 0);
  delay(3);
  int8_t rssi = (int8_t)mod->SPIgetRegValue(RADIOLIB_RF69_REG_RSSI_VALUE);
  int opmode = mod->SPIgetRegValue(RADIOLIB_RF69_REG_OP_MODE, 4, 2);
  int opfull = mod->SPIreadRegister(RADIOLIB_RF69_REG_OP_MODE);
  int irq1 = mod->SPIreadRegister(RADIOLIB_RF69_REG_IRQ_FLAGS_1);
  int irq2 = mod->SPIreadRegister(RADIOLIB_RF69_REG_IRQ_FLAGS_2);
  int thresh = mod->SPIreadRegister(RADIOLIB_RF69_REG_RSSI_THRESH);
  Log.warning(F("dbg rssi=%d opmode=%d opfull=%d irq1=%d irq2=%d thresh=%d" CR),
              rssi, opmode, opfull, irq1, irq2, thresh);
  if (mode == RADIOLIB_ERR_NONE) {
    mod->SPIsetRegValue(RADIOLIB_RF69_REG_TEMP_1, RADIOLIB_RF69_TEMP_MEAS_START, 3, 3);
    for (int i = 0; i < RADIO_TEMP_TRIES; i++) {
      if (mod->SPIgetRegValue(RADIOLIB_RF69_REG_TEMP_1, 2, 2) !=
          RADIOLIB_RF69_TEMP_MEAS_RUNNING) {
        int8_t raw = (int8_t)mod->SPIgetRegValue(RADIOLIB_RF69_REG_TEMP_2);
        t = -(int)raw - RADIO_TEMP_OFFSET;
        break;
      }
      delay(1);
    }
  }
  Log.warning(F("dbg temp: mode=%d tempC=%d" CR), mode, t);
```

with:

```cpp
  // The RF69 defers OP_MODE writes for a while after entering RX (the mode
  // change lands once the receiver settles), so the STANDBY write right after
  // init can time RadioLib's checkback out. A failed write skips the read; the
  // radio is put back in RX below, so reception resumes either way.
  if (radio.setMode(RADIOLIB_RF69_STANDBY) == RADIOLIB_ERR_NONE) {
    mod->SPIsetRegValue(RADIOLIB_RF69_REG_TEMP_1, RADIOLIB_RF69_TEMP_MEAS_START, 3, 3);
    for (int i = 0; i < RADIO_TEMP_TRIES; i++) {
      if (mod->SPIgetRegValue(RADIOLIB_RF69_REG_TEMP_1, 2, 2) !=
          RADIOLIB_RF69_TEMP_MEAS_RUNNING) {
        int8_t raw = (int8_t)mod->SPIgetRegValue(RADIOLIB_RF69_REG_TEMP_2);
        t = -(int)raw - RADIO_TEMP_OFFSET;
        break;
      }
      delay(1);
    }
  } else {
    Log.warning(F("setMode standby failed, skipping radio temperature read" CR));
  }
```

- [ ] **Step 2: Remove the last `dbg` log line**

Delete line 279 in `receiver/WebReceiver.ino`:

```cpp
  Log.warning(F("dbg receiveDirect state=%d" CR), state);
```

- [ ] **Step 3: Verify no `dbg` or `esp_restart` remains in the file**

Run: `cd receiver && grep -n "dbg \|esp_restart\|FROZEN_MS" WebReceiver.ino platformio.ini radio_health.h radio_health.cpp`
Expected: no matches.

- [ ] **Step 4: Verify the firmware compiles**

Run: `cd receiver && pio run`
Expected: exit 0, `[SUCCESS] Took ...`.

- [ ] **Step 5: Commit**

```bash
git add receiver/WebReceiver.ino
git commit -m "fix(receiver): temperature read is non-blocking and fails soft"
```

---

### Task 3: Docs describe the soft-reinit-only recovery

**Files:**
- Modify: `receiver/docs/architecture.md` (lines 44-59 and 248-287)
- Modify: `receiver/docs/development.md` (lines 42-46)

**Interfaces:**
- Consumes: nothing.

- [ ] **Step 1: Rewrite the `radio_health` module blurb in `receiver/docs/architecture.md`**

Replace lines 44-59:

```markdown
**`radio_health.h` / `radio_health.cpp`** — an Arduino-free decision module,
host-tested by `test/host/run.sh` like `topic`. It watches the radio through
`lastDecodeAt` (time since last decode) and `averageRssi` (mean RSSI of the
receiver task). Three states: `silent` (no decode for `SILENT_MS`), `pinned`
(`silent` AND `averageRssi` nonzero AND at or below `NOISE_FLOOR_DBM`), and
`frozen` (`averageRssi` byte-identical for `FROZEN_MS`). Recovery ladder:
`silent && frozen && !pinned` → `esp_restart()` (the receiver task is wedged
and cannot be restarted by a soft init); `silent && pinned` → soft re-init
(`initReceiver()`); any other condition → no action. A pinned chip is stuck
refusing OP_MODE writes and survives `esp_restart()`, so the pinned signature
never escalates to a reboot; it soft re-inits on the backoff until a power
cycle clears the chip. Soft re-init increments `recovery_count` in NVS and
records the current uptime as `last_recovery_s`; a confirmed decode resets the
module's state. A constant `RECOVERY_BACKOFF_MS` (2 min default) suppresses a
re-trigger right after a recovery; the condition must re-confirm before the
next attempt. The window lengths and thresholds are build flags.
```

with:

```markdown
**`radio_health.h` / `radio_health.cpp`** — an Arduino-free decision module,
host-tested by `test/host/run.sh` like `topic`. It watches the radio through
`lastDecodeAt` (time since last decode) and `averageRssi` (mean RSSI of the
receiver task). Two states: `silent` (no decode for `SILENT_MS`) and `pinned`
(`silent` AND `averageRssi` nonzero AND at or below `NOISE_FLOOR_DBM`).
`silent && pinned` soft re-inits (`initReceiver()`); anything else takes no
action. A pinned chip is stuck refusing OP_MODE writes and survives
`esp_restart()`, so the firmware never reboots for it: it soft re-inits on the
backoff until a power cycle clears the chip. Soft re-init increments
`recovery_count` in NVS and records the current uptime as `last_recovery_s`; a
confirmed decode resets the module's state. A constant `RECOVERY_BACKOFF_MS`
(2 min default) suppresses a re-trigger right after a recovery; the condition
must re-confirm before the next attempt. The window lengths and thresholds are
build flags.
```

- [ ] **Step 2: Rewrite the "Radio health and recovery" section in `receiver/docs/architecture.md`**

Replace lines 248-287 (the whole section body from "`radio_health` runs once
per telemetry cycle..." through "...until the chip clears.") with:

```markdown
`radio_health` runs once per telemetry cycle in `loop()`, fed with the current
`lastDecodeAt` and `averageRssi`. It classifies the radio state as `silent` or
`pinned` and returns an action. `pinned` triggers a soft re-init:
`initReceiver()` re-creates the receiver task and restarts the radio. There is
no reboot path: the firmware never calls `esp_restart()` for the radio, because
a reboot does not power-cycle the radio and a stuck chip survives it. A decode
arriving after a soft re-init marks the recovery confirmed and resets the
health state.

The two SPI users — the receiver task reading RSSI and `loop()` reading the
temperature register — are serialised by the ESP32 SPI driver's per-bus mutex:
RadioLib's `ArduinoHal` wraps every register transaction in
`beginTransaction()/endTransaction()`, which the driver guards. There is no
race between them.

The temperature read parks the radio in standby for the measurement and then
puts it back in RX. A single `setMode(STANDBY)` attempt is made; if it fails the
measurement is skipped. After the read the OpMode register is verified, and on
failure the path runs `reinitRadio()` and `recordRecoveryEvent()` and returns
`INT16_MIN` (the previous reading is kept). It does not reboot — the failure
signature is the stuck chip below, which survives a reboot, so a reboot would
only take the web server down. The board stays up serving HTTP with `radio_ok`
0.

A noise floor at or below the SX1231's measurement floor is an error value, not
a quiet band. A working receiver with its antenna connected reads roughly -105
to -115 dBm on a quiet 433 MHz band; a reading past the chip's own floor (about
-120 dBm) means the front-end is not measuring RF. Observed stuck: the chip
reported `RegOpMode` as RX yet refused every OP_MODE write (`setMode` returned
-16, `RADIOLIB_ERR_SPI_WRITE_FAILED`) while SPI reads and other register writes
succeeded, so RSSI sampling kept reporting -125 dBm and no decode ever arrived.
`NOISE_FLOOR_DBM` (-120) already gates the `pinned` state on that signature, but
nothing names a below-floor reading as an error.

A stuck chip survives `esp_restart()`: the reboot does not power-cycle the
radio, so the bad state persists across the resulting reboot loop. Recovery
comes from a full power cycle, which drops the radio's supply. The firmware
never reboots into that loop: the pinned signature keeps the board alive,
soft re-initing on the backoff in case a transient latch clears, and the
receiver card reports `radio_ok` 0 and the pinned `noise_dBm` until the chip
clears.
```

- [ ] **Step 3: Update the recovery-exercise text in `receiver/docs/development.md`**

Replace lines 42-46:

```markdown
Set `'-DFAKE_RADIO_FAIL_MS=900000'` (15 minutes) to exercise the recovery
path: the synthetic decode stops and the health state moves to `silent` +
`pinned` (floor pinned below threshold), triggering a soft re-init after the
window closes and again on the backoff, without a reboot — a pinned chip is
stuck and survives a reboot.
```

with:

```markdown
Set `'-DFAKE_RADIO_FAIL_MS=900000'` (15 minutes) to exercise the recovery
path: the synthetic decode stops and the health state moves to `silent` +
`pinned` (floor pinned below threshold), triggering a soft re-init after the
window closes and again on the backoff.
```

- [ ] **Step 4: Verify no stale reboot/frozen references remain in receiver docs**

Run: `cd receiver && grep -rn "FROZEN_MS\|frozen\|wedged" docs/`
Expected: no matches.

- [ ] **Step 5: Commit**

```bash
git add receiver/docs/architecture.md receiver/docs/development.md
git commit -m "docs(receiver): radio health recovery is soft re-init only"
```

---

### Task 4: Final verification and cleanup

- [ ] **Step 1: Run the full host test suite**

Run: `cd receiver && bash test/host/run.sh`
Expected: `topic: PASS`, `radio_health: PASS`, `device_hooks: PASS`, exit 0.

- [ ] **Step 2: Run the firmware build**

Run: `cd receiver && pio run`
Expected: exit 0, `[SUCCESS] Took ...`.

- [ ] **Step 3: Confirm no reboot path or debug logging remains**

Run: `cd receiver && grep -rn "esp_restart\|dbg \|FROZEN_MS" WebReceiver.ino platformio.ini radio_health.h radio_health.cpp`
Expected: no matches.

- [ ] **Step 4: Confirm the branch is green and squashed**

```bash
git log --oneline -6
git status
```

Expected: the three feature commits plus the spec/plan docs on top of
`655f8ca`, working tree clean.

- [ ] **Step 5: Delete the working spec and plan documents in the final commit**

Per project convention, fold what matters into the permanent docs (done in Task
3) and delete the working documents before merge:

```bash
git rm docs/superpowers/specs/2026-08-19-radio-health-failsoft-design.md docs/superpowers/plans/2026-08-19-radio-health-failsoft.md
git commit -m "chore: remove working spec and plan documents before merge"
```

## Self-Review

**Spec coverage:**
- No `esp_restart()` in recovery → Task 1 (module + monitor branch), Task 2 (verified by grep), Task 4.
- Non-blocking fail-soft temperature read → Task 2.
- No `dbg` logging / debug register reads → Task 2.
- Drop `frozen` and `FROZEN_MS` → Task 1.
- Keep telemetry and soft re-init → untouched, verified by Task 4 grep scope.
- Docs updated → Task 3.

**Placeholder scan:** all code blocks are complete; no TBD/TODO.

**Type consistency:** `decide(bool, bool, unsigned long)`, `HealthAction { none, softReinit }`, `HealthState { lastDecodeAt, lastRecoveryAt }` used identically in Tasks 1, 2, and the tests.