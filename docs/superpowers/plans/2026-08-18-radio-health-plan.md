# Radio Health: Detection, Recovery, and Debug — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-08-18-radio-health-design.md`

**Goal:** The receiver detects a "deaf radio" (receiver task alive but the SX1231 parked in standby, or the task wedged), recovers on its own, and carries enough history that a post-mortem can establish presence, reset reason, and timing.

**Architecture:** A new Arduino-free decision module `receiver/radio_health.h/.cpp` holds the monitor state and the pure decision logic, host-tested like `topic.cpp`. A new `receiver/health_store.h/.cpp` persists boot/recovery history in a `Preferences` namespace `"health"`, separate from `alias_store`. `WebReceiver.ino` supplies the observables once per telemetry cycle (`millis()`, `lastDecodeAt`, `rtl_433_ESP::averageRssi`), acts on the returned action (soft re-init vs `esp_restart()`), fixes the unverified standby-to-receive dance in `radioTemperature()`, adds telemetry fields, boot logging, and a `FAKE_SIGNALS` recovery-exercise mode.

**Tech Stack:** C++ on Arduino ESP32-S3 (PlatformIO, espressif32@6.1.0), ArduinoLog, Preferences, RadioLib/`rtl_433_ESP` fork (`sx1231-support`). Host tests via `g++ -std=c++17 -Wall -Wextra -Werror`.

## Global Constraints

- All work happens in the `feature/radio-health` worktree: `rtl433-web-receiver/.worktrees/feature/radio-health`. Never touch the main checkout.
- `radio_health` has **no Arduino dependency** (no `Arduino.h`), so `test/host/run.sh` compiles and runs it on the host like `topic.cpp`. Time is passed in, never read from `millis()`, inside the module.
- The three window constants (`SILENT_MS`, `NOISE_FLOOR_DBM`, `FROZEN_MS`) plus `RECOVERY_BACKOFF_MS` and `MAX_SOFT_RECOVERY` are build flags in `platformio.ini` with `#ifndef` defaults in `radio_health.h`, matching `DEVICE_STALE_HOURS`.
- NVS keys are limited to 15 characters. The spec's `last_reset_reason` key becomes `reset_reason`; the telemetry field keeps the long name.
- NVS writes are bounded: once at boot, once on the first SNTP sync, once per recovery event.
- Every recovery step logs `Log.warning` and is carried out by the next `recordReceiver()` over SSE.
- A soft re-init re-runs the full `rf.initReceiver(...)` path. Verified safe from `loop()`: `rtlSetup()` is guarded by `if (!cfg->demod)`, `newSPI.begin()` early-returns once SPI is up, and `initReceiver()`'s task creation is guarded by `if (!rtl_433_ReceiverHandle)`, so no second receiver task spawns and the SPI bus mutex serializes the re-init against RSSI sampling. (Spec's "lean sequence if not idempotent" branch is not taken.)
- The clock is "up" when `time(nullptr) >= 1700000000`, mirroring `signal_store.cpp:157`.
- Commit after each task, on `feature/radio-health`, with a message matching the repo's `type(scope): subject` style.
- All host/binding/dashboard suites must pass at the end of every task that touches them.

## Environment setup (once, before Task 2)

The worktree has no `.env`, no `.pio`, no `node_modules`. `pio run` needs all three.

- [ ] `cp ../../.env .env` from the main checkout into `receiver/` (it is gitignored; load_env.py will turn it into `-D` flags, and without it the build stops with the `#error "…copy .env.example to .env…"`).
- [ ] `npm install` in `dashboard/` (build_dashboard.py runs `node ../dashboard/build.js`, which imports `esbuild`).
- [ ] `npm install` in `receiver/` and `npx playwright install chromium` for the binding suite.
- [ ] First `pio run -e esp32s3-generic` downloads the platform and the library fork. Allow several minutes.

---

### Task 1: `radio_health` decision module with host tests

The pure heart of the feature. No Arduino dependency, host-tested.

**Files:**
- Create: `receiver/radio_health.h`
- Create: `receiver/radio_health.cpp`
- Create: `receiver/test/host/radio_health_test.cpp`
- Modify: `receiver/test/host/run.sh`

**Interfaces:**
- Consumes: nothing but `<stdint.h>` / `<limits.h>` and the build-flag constants.
- Produces: `namespace radio_health` with `HealthAction`, `HealthState`, `decide()`, `evaluate()`, `noteRecovery()`.

- [ ] **Step 1: Create `receiver/radio_health.h`**

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
#ifndef FROZEN_MS
#define FROZEN_MS 300000UL // averageRssi byte-identical this long: the wedged signature
#endif
#ifndef RECOVERY_BACKOFF_MS
#define RECOVERY_BACKOFF_MS 120000UL // suppress re-trigger this long after a soft re-init
#endif
#ifndef MAX_SOFT_RECOVERY
#define MAX_SOFT_RECOVERY 3 // soft re-inits without a decode before rebooting
#endif

namespace radio_health {

enum class HealthAction : uint8_t { none, softReinit, reboot };

// The monitor's state, carried across telemetry cycles. Everything here takes
// time as a parameter, so the module never reads the millis() clock itself.
struct HealthState {
  unsigned long lastDecodeAt = 0;    // uptime ms of the most recent decode, 0 until first
  int           lastFloor = INT16_MIN; // previous averageRssi, for the frozen window
  unsigned long floorSince = 0;      // uptime ms when lastFloor last changed
  uint8_t       recoveryCount = 0;   // soft re-inits since the last decode
  unsigned long lastRecoveryAt = 0;  // uptime ms of the last soft re-init, 0 until first
};

// Pure decision, host-tested directly. silent/pinned/frozen are the window
// states; recoveryCount is soft re-inits since the last decode; elapsedMs is
// uptime since the last recovery (ULONG_MAX if none yet).
HealthAction decide(bool silent, bool pinned, bool frozen, uint8_t recoveryCount,
                    unsigned long elapsedMs);

// One telemetry cycle. now is uptime ms, floor the current averageRssi, and
// lastDecodeAt the uptime ms of the most recent decode. Resets counters when a
// decode arrived since the last cycle, then returns the recovery action.
HealthAction evaluate(HealthState& state, unsigned long now, int floor,
                      unsigned long lastDecodeAt);

// Stamps a completed soft re-init into the state.
void noteRecovery(HealthState& state, unsigned long now);

} // namespace radio_health
```

- [ ] **Step 2: Create `receiver/radio_health.cpp`**

```cpp
#include "radio_health.h"

namespace radio_health {

HealthAction decide(bool silent, bool pinned, bool frozen, uint8_t recoveryCount,
                    unsigned long elapsedMs) {
  // A wedged receiver task cannot be restarted by a soft re-init (initReceiver's
  // task creation guard), so the only way back is a reboot.
  if (silent && frozen) {
    return HealthAction::reboot;
  }
  if (silent && pinned) {
    // Backoff suppresses a re-trigger right after a recovery; the silent + pinned
    // condition must re-confirm before the next attempt.
    if (elapsedMs < RECOVERY_BACKOFF_MS) {
      return HealthAction::none;
    }
    if (recoveryCount >= MAX_SOFT_RECOVERY) {
      return HealthAction::reboot;
    }
    return HealthAction::softReinit;
  }
  return HealthAction::none;
}

HealthAction evaluate(HealthState& state, unsigned long now, int floor,
                      unsigned long lastDecodeAt) {
  if (lastDecodeAt != state.lastDecodeAt) {
    // A decode arrived since the last cycle: it resets the recovery ladder and
    // the frozen window.
    state.lastDecodeAt   = lastDecodeAt;
    state.recoveryCount  = 0;
    state.lastFloor      = INT16_MIN;
    state.floorSince     = 0;
    state.lastRecoveryAt = 0;
  }
  bool silent = (now - lastDecodeAt) > SILENT_MS;
  // The receiver task reports 0 before its first averaged batch; that is "not
  // sampled", not a floor, so it is neither pinned nor (yet) frozen.
  bool pinned = silent && floor != 0 && floor <= NOISE_FLOOR_DBM;
  if (floor != state.lastFloor) {
    state.lastFloor  = floor;
    state.floorSince = now;
  }
  // Byte-identical across FROZEN_MS is the wedged signature: the task stopped
  // sampling and the floor stopped moving. 0 frozen means the task never
  // sampled, which is equally wedged.
  bool frozen = state.lastFloor == floor && (now - state.floorSince) >= FROZEN_MS;
  unsigned long elapsed = state.lastRecoveryAt == 0 ? ULONG_MAX
                                                    : now - state.lastRecoveryAt;
  return decide(silent, pinned, frozen, state.recoveryCount, elapsed);
}

void noteRecovery(HealthState& state, unsigned long now) {
  state.recoveryCount++;
  state.lastRecoveryAt = now;
}

} // namespace radio_health
```

- [ ] **Step 3: Create `receiver/test/host/radio_health_test.cpp`**

Mirror the `check()`/`failures` shape of `topic_test.cpp`. Cover every case the spec lists, plus the `evaluate()` integration (decode reset, frozen window, elapsed):

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
        radio_health::decide(true, false, false, 0, NEVER) == radio_health::HealthAction::none);
  // parked -> soft
  check("a parked radio (silent + pinned) soft re-inits",
        radio_health::decide(true, true, false, 0, NEVER) == radio_health::HealthAction::softReinit);
  // pinned-but-not-frozen -> soft
  check("pinned without frozen soft re-inits",
        radio_health::decide(true, true, false, 1, NEVER) == radio_health::HealthAction::softReinit);
  // wedged -> reboot
  check("a wedged radio (silent + frozen) reboots",
        radio_health::decide(true, false, true, 0, NEVER) == radio_health::HealthAction::reboot);
  check("a wedged radio reboots even when also pinned",
        radio_health::decide(true, true, true, 0, NEVER) == radio_health::HealthAction::reboot);
  // active radio
  check("an active radio takes no action",
        radio_health::decide(false, true, false, 0, NEVER) == radio_health::HealthAction::none);
  // backoff
  check("backoff suppresses a re-trigger",
        radio_health::decide(true, true, false, 1, RECOVERY_BACKOFF_MS - 1) == radio_health::HealthAction::none);
  check("a re-trigger fires again after the backoff",
        radio_health::decide(true, true, false, 1, RECOVERY_BACKOFF_MS + 1) == radio_health::HealthAction::softReinit);
  // MAX_SOFT_RECOVERY -> reboot
  check("MAX_SOFT_RECOVERY soft re-inits are followed by a reboot",
        radio_health::decide(true, true, false, MAX_SOFT_RECOVERY, NEVER) == radio_health::HealthAction::reboot);

  // evaluate(): the window computation, the decode reset, and the backoff
  radio_health::HealthState st;
  check("a fresh, active radio is healthy",
        radio_health::evaluate(st, 0, -85, 0) == radio_health::HealthAction::none);
  check("a short quiet period is not yet silent",
        radio_health::evaluate(st, 10000, -85, 0) == radio_health::HealthAction::none);
  check("a pinned floor across the silent window soft re-inits",
        radio_health::evaluate(st, SILENT_MS + 1, NOISE_FLOOR_DBM, 0) == radio_health::HealthAction::softReinit);

  radio_health::noteRecovery(st, 200000);
  check("a recovery counts",
        st.recoveryCount == 1 && st.lastRecoveryAt == 200000);
  check("the backoff holds the ladder still",
        radio_health::evaluate(st, 300000, NOISE_FLOOR_DBM, 0) == radio_health::HealthAction::none);
  check("the ladder climbs again after the backoff",
        radio_health::evaluate(st, 400000, NOISE_FLOOR_DBM, 0) == radio_health::HealthAction::softReinit);
  radio_health::HealthAction a = radio_health::evaluate(st, 500000, NOISE_FLOOR_DBM, 500000);
  check("a decode resets the counters", st.recoveryCount == 0 && a == radio_health::HealthAction::none);

  // frozen window
  radio_health::HealthState st2;
  radio_health::evaluate(st2, 0, -85, 0);
  check("a stable floor is not frozen before FROZEN_MS",
        radio_health::evaluate(st2, FROZEN_MS - 1, -85, 0) == radio_health::HealthAction::none);
  check("a byte-identical floor across FROZEN_MS is frozen and reboots",
        radio_health::evaluate(st2, FROZEN_MS, -85, 0) == radio_health::HealthAction::reboot);

  printf("%s\n", failures == 0 ? "radio_health: PASS" : "radio_health: FAIL");
  return failures == 0 ? 0 : 1;
}
```

- [ ] **Step 4: Extend `receiver/test/host/run.sh`**

Append a compile-and-run for the new test after the existing `topic_test` block:

```sh
g++ -std=c++17 -Wall -Wextra -Werror -I"$root" \
    -o "$out/radio_health_test" "$root/radio_health.cpp" "$root/test/host/radio_health_test.cpp"
"$out/radio_health_test"
```

Update the header comment (it currently claims `topic.cpp` is the one host-tested module).

- [ ] **Step 5: Verify** — `bash test/host/run.sh` prints `topic: PASS` and `radio_health: PASS`, exits 0.
- [ ] **Step 6: Commit** — `feat(receiver): radio health monitor with host tests`

---

### Task 2: `health_store` NVS module

Boot/recovery history in `Preferences` namespace `"health"`. Not host-testable (Arduino `Preferences`); verified by compilation, like `alias_store`.

**Files:**
- Create: `receiver/health_store.h`
- Create: `receiver/health_store.cpp`

**Interfaces:**
- Consumes: `Preferences`, `ArduinoLog`.
- Produces: `namespace health_store` with `begin()`, `bootCount()`, `resetReason()`, `recoveryCount()`, `noteBoot()`, `noteRecovery()`, `noteFirstSync()`.

- [ ] **Step 1: Create `receiver/health_store.h`**

```cpp
#pragma once

#include <Arduino.h>
#include <stdint.h>
#include <time.h>

namespace health_store {
// Reads the "health" NVS namespace and loads the counters into RAM. Call once
// from setup(), before noteBoot().
bool     begin();
uint32_t bootCount();     // NVS counter, incremented once per boot by noteBoot()
uint8_t  resetReason();   // esp_reset_reason() captured by noteBoot()
uint32_t recoveryCount(); // soft re-inits, incremented once per noteRecovery()

// setup(): increments boot_count and stores the reset reason. Bounded: once per boot.
void noteBoot(uint8_t resetReason);
// Per soft re-init: increments recovery_count; if utc is a real epoch (>0),
// also stores last_recovery. Bounded: once per recovery event.
void noteRecovery(time_t utc);
// Once, on the first SNTP sync of a boot: stores last_boot_utc.
void noteFirstSync(time_t utc);
} // namespace health_store
```

- [ ] **Step 2: Create `receiver/health_store.cpp`**

```cpp
#include "health_store.h"

#include <ArduinoLog.h>
#include <Preferences.h>

namespace health_store {

// NVS keys are limited to 15 characters.
static const char* kBootCount     = "boot_count";
static const char* kResetReason   = "reset_reason";
static const char* kRecoveryCount = "recovery_count";
static const char* kLastRecovery  = "last_recovery";
static const char* kLastBootUtc   = "last_boot_utc";

static Preferences _prefs;
static bool        _open = false;
static uint32_t    _bootCount = 0;
static uint8_t     _resetReason = 0;
static uint32_t    _recoveryCount = 0;

bool begin() {
  _open = _prefs.begin("health", false);
  _bootCount = _open ? _prefs.getUInt(kBootCount, 0) : 0;
  _resetReason = _open ? (uint8_t)_prefs.getUChar(kResetReason, 0) : 0;
  _recoveryCount = _open ? _prefs.getUInt(kRecoveryCount, 0) : 0;
  if (!_open) {
    Log.warning(F("health store: NVS unavailable, recovery history will not persist" CR));
  }
  return _open;
}

uint32_t bootCount()     { return _bootCount; }
uint8_t  resetReason()   { return _resetReason; }
uint32_t recoveryCount() { return _recoveryCount; }

void noteBoot(uint8_t resetReason) {
  _bootCount++;
  _resetReason = resetReason;
  if (_open) {
    _prefs.putUInt(kBootCount, _bootCount);
    _prefs.putUChar(kResetReason, resetReason);
  }
}

void noteRecovery(time_t utc) {
  _recoveryCount++;
  if (_open) {
    _prefs.putUInt(kRecoveryCount, _recoveryCount);
    if (utc > 0) {
      _prefs.putLong(kLastRecovery, (int32_t)utc);
    }
  }
}

void noteFirstSync(time_t utc) {
  if (_open) {
    _prefs.putLong(kLastBootUtc, (int32_t)utc);
  }
}

} // namespace health_store
```

- [ ] **Step 3: Verify** — `pio run -e esp32s3-generic` compiles (environment setup above must be done first). No device needed.
- [ ] **Step 4: Commit** — `feat(receiver): health store persists boot and recovery history`

---

### Task 3: `WebReceiver.ino` integration + build flags

Wires the module into the sketch: boot logging, the per-cycle monitor, the recovery ladder, the temperature-path fix, the new telemetry fields, the SNTP boot stamp, and the `FAKE_SIGNALS` recovery-exercise mode.

**Files:**
- Modify: `receiver/WebReceiver.ino`
- Modify: `receiver/platformio.ini`

- [ ] **Step 1: Includes and file-scope statics**

Add to the include block:

```cpp
#include "health_store.h"
#include "radio_health.h"
#include "esp_core_dump.h"  // esp_core_dump_image_check()
#include "esp_system.h"     // esp_reset_reason()
```

Near the other `#ifndef` defaults, add the exercise-mode default:

```cpp
#ifndef FAKE_RADIO_FAIL_MS
#define FAKE_RADIO_FAIL_MS 0 // FAKE_SIGNALS: pretend the radio is deaf after this long
#endif
```

After the existing statics (near `lastDecodeAt`), add:

```cpp
static radio_health::HealthState healthState;
static bool                      bootCoredumpPending = false;
static int                       tempFailures = 0;
static bool                      bootUtcStamped = false;
```

- [ ] **Step 2: Boot logging in `setup()`, before `rf.initReceiver()`**

Insert after the `Log.notice(F("****** setup ******" CR));` banner, before `connectWiFi()`:

```cpp
  health_store::begin();
  bootCoredumpPending = esp_core_dump_image_check() == ESP_OK;
  health_store::noteBoot((uint8_t)esp_reset_reason());
  Log.notice(F("boot: build=%s reset=%d boot_count=%lu heap=%lu coredump=%d" CR),
             BUILD_ID, (int)health_store::resetReason(),
             (unsigned long)health_store::bootCount(),
             (unsigned long)ESP.getFreeHeap(), bootCoredumpPending ? 1 : 0);
```

- [ ] **Step 3: Recovery helpers** (place after `radioTemperature()`, before `recordReceiver()`)

```cpp
// Re-runs the radio config path. Safe from loop(): initReceiver()'s task
// creation is guarded, so no second receiver task spawns, and the SPI bus
// mutex serializes the re-init against RSSI sampling.
static void reinitRadio() {
  rf.initReceiver(RF_MODULE_RECEIVER_GPIO, RF_MODULE_FREQUENCY);
  rf.setCallback(rtl_433_Callback, messageBuffer, JSON_MSG_BUFFER);
  rf.enableReceiver();
}

// Confirms the SX1231 is actually in RX. receiveDirect()'s return alone is not
// the whole proof: the OpMode register is read back, bits 4:2 being the mode
// setMode() wrote.
static bool radioBackInRx(Module* mod) {
  return mod->SPIgetRegValue(RADIOLIB_RF69_REG_OP_MODE, 4, 2) ==
         (RADIOLIB_RF69_RX >> 2);
}

// One recovery event: stamps the state and NVS, then logs. Called for both the
// monitor's soft re-init and the temperature-path recovery.
static void recordRecoveryEvent() {
  radio_health::noteRecovery(healthState, millis());
  time_t utc = time(nullptr);
  health_store::noteRecovery(utc >= 1700000000 ? utc : 0);
  Log.warning(F("radio health: recovery_count=%lu" CR),
              (unsigned long)health_store::recoveryCount());
}
```

- [ ] **Step 4: Temperature-path fix in `radioTemperature()`**

Replace the tail of the `#ifdef RF_RF69` branch. Current tail (lines 231-237) re-tries `receiveDirect()` and returns on its return code alone. New tail verifies the radio is back in RX and recovers immediately on any failure:

```cpp
  int state = radio.receiveDirect();
  if (state != RADIOLIB_ERR_NONE) {
    Log.warning(F("receiveDirect after temperature read failed: %d, retrying" CR), state);
    state = radio.receiveDirect();
  }
  // receiveDirect's return alone is not the whole proof: the OpMode register
  // read confirms the part is actually in RX, not parked in standby.
  if (state != RADIOLIB_ERR_NONE || !radioBackInRx(mod)) {
    Log.error(F("radio not back in RX after temperature read" CR));
    if (++tempFailures >= 2) {
      Log.error(F("radio health: two temperature failures, rebooting" CR));
      esp_restart();
    }
    reinitRadio();
    recordRecoveryEvent();
    return INT16_MIN;
  }
  tempFailures = 0;
  rf.enableReceiver();
  return t;
```

The preceding `delay(5)` comment ("let an RSSI read already on the SPI bus finish") stays.

- [ ] **Step 5: New telemetry fields in `recordReceiver()`**

Add `radio_ok`, `uptime_s`, `boot_count`, `last_reset_reason`, `recovery_count`, `last_recovery_s`, `coredump_pending`, and `rssi_thresh`. The new fields add roughly 100 bytes to a ~130 byte message, inside `JSON_MSG_BUFFER` (512) and `SIGNAL_PAYLOAD_MAX` (600).

Compute `radio_ok` at the top of the function:

```cpp
  // 0 only while the last soft re-init has not yet been confirmed by a decode.
  bool radioOk = healthState.lastRecoveryAt == 0 ||
                 lastDecodeAt > healthState.lastRecoveryAt;
```

Replace the opening `appendf`:

```cpp
  n = appendf(buf, sizeof(buf), n,
              "{\"model\":\"Receiver\",\"build\":\"" BUILD_ID "\","
              "\"uptime_s\":%lu,\"boot_count\":%lu,\"last_reset_reason\":%d,"
              "\"recovery_count\":%lu,\"last_recovery_s\":%lu,"
              "\"radio_ok\":%d,\"coredump_pending\":%d,"
              "\"temperature_C\":%.1f,\"heap_kB\":%lu",
              (unsigned long)(millis() / 1000),
              (unsigned long)health_store::bootCount(),
              (int)health_store::resetReason(),
              (unsigned long)health_store::recoveryCount(),
              (unsigned long)(healthState.lastRecoveryAt / 1000),
              radioOk ? 1 : 0,
              bootCoredumpPending ? 1 : 0,
              temperatureRead(), (unsigned long)(ESP.getFreeHeap() / 1024));
```

Replace the `noise_dBm` appendf so `rssi_thresh` rides on the same "sampled" guard:

```cpp
  if (rtl_433_ESP::averageRssi != 0) {
    n = appendf(buf, sizeof(buf), n,
                ",\"noise_dBm\":%d,\"rssi_thresh\":%d",
                rtl_433_ESP::averageRssi, rtl_433_ESP::rssiThreshold);
  }
```

- [ ] **Step 6: The monitor and the SNTP boot stamp in `loop()`**

Add a `monitorRadioHealth()` static (place before `loop()`):

```cpp
// The radio health monitor, run once per telemetry cycle. Recovery and reboot
// happen here; a soft re-init is logged and carried out immediately.
static void monitorRadioHealth() {
#ifdef FAKE_SIGNALS
  // Recovery-exercise mode: after FAKE_RADIO_FAIL_MS pretend the radio is deaf
  // (no decodes, floor pinned) so the soft re-init path runs and logs. It
  // requires a board to exercise the ladder.
  unsigned long decodeAt = lastDecodeAt;
  int           floor    = rtl_433_ESP::averageRssi;
  if (FAKE_RADIO_FAIL_MS > 0 && millis() > (unsigned long)FAKE_RADIO_FAIL_MS) {
    decodeAt = 0;
    floor    = NOISE_FLOOR_DBM - 1;
  }
  radio_health::HealthAction action = radio_health::evaluate(
      healthState, millis(), floor, decodeAt);
#else
  radio_health::HealthAction action = radio_health::evaluate(
      healthState, millis(), rtl_433_ESP::averageRssi, lastDecodeAt);
#endif
  if (action == radio_health::HealthAction::softReinit) {
    reinitRadio();
    recordRecoveryEvent();
  } else if (action == radio_health::HealthAction::reboot) {
    Log.error(F("radio health: reboot" CR));
    esp_restart();
  }
}
```

In `fakeSignalTick()` (under `FAKE_SIGNALS`), stamp `lastDecodeAt` so a synthetic decode resets the health counters like a real one:

```cpp
  last = millis();
  lastDecodeAt = last;
```

In `loop()`, call the monitor before `recordReceiver()` in the telemetry block, and add the once-per-boot SNTP stamp:

```cpp
  static unsigned long lastTelemetry = 0;
  if (millis() - lastTelemetry >= RECEIVER_TELEMETRY_MS) {
    lastTelemetry = millis();
    monitorRadioHealth();
    recordReceiver();
  }

  // The clock comes up via SNTP after WiFi connects; stamp this boot's UTC once.
  if (!bootUtcStamped) {
    time_t utc = time(nullptr);
    if (utc >= 1700000000) {
      health_store::noteFirstSync(utc);
      bootUtcStamped = true;
    }
  }
```

- [ ] **Step 7: Build flags in `platformio.ini`**

After the `DEVICE_STALE_HOURS` line, add:

```
  '-DSILENT_MS=180000'              ; no decode this long: the silent window
  '-DNOISE_FLOOR_DBM=-120'          ; averageRssi at/below this: the parked signature
  '-DFROZEN_MS=300000'              ; averageRssi byte-identical this long: the wedged signature
  '-DRECOVERY_BACKOFF_MS=120000'    ; suppress a re-trigger this long after a soft re-init
  '-DMAX_SOFT_RECOVERY=3'           ; soft re-inits without a decode before rebooting
```

Next to the commented `FAKE_SIGNALS` line, add:

```
;  '-DFAKE_RADIO_FAIL_MS=300000'    ; FAKE_SIGNALS: pretend the radio is deaf after this long
```

- [ ] **Step 8: Verify**

- `bash test/host/run.sh` still PASSes (radio_health.cpp unchanged).
- `pio run -e esp32s3-generic` compiles. Confirm the boot line and the telemetry appendf compile clean under `-Wall -Wextra` (PlatformIO warnings; they are not errors).
- `cd receiver && npx playwright test` — binding suite passes; new fields are additive.
- `cd dashboard && npm test` — dashboard suite passes; unknown fields render automatically.

- [ ] **Step 9: Commit** — `feat(receiver): radio health detection, recovery, and telemetry`

---

### Task 4: Coredump tooling

**Files:**
- Create: `receiver/tools/coredump.md`
- Create: `receiver/tools/fetch_coredump.sh` (optional but requested)

- [ ] **Step 1: Create `receiver/tools/coredump.md`**

Short doc: what a coredump is, where it lives (64 K `coredump` partition at `0x3f0000`; `Found core dump N bytes in flash` on the USB console at boot; the `coredump_pending` telemetry field), how to fetch and decode with the PlatformIO/ESP-IDF toolchain, and the one-liner script. Reference `firmware.elf` at `receiver/.pio/build/esp32s3-generic/firmware.elf`.

- [ ] **Step 2: Create `receiver/tools/fetch_coredump.sh`**

```sh
#!/bin/sh
# Read and decode the receiver's coredump partition (64 K at 0x3f0000).
# Usage: tools/fetch_coredump.sh [serial-port]
set -e
port=${1:-/dev/ttyACM0}
here=$(cd "$(dirname "$0")" && pwd)
build="$here/../.pio/build/esp32s3-generic"
esptool=$HOME/.platformio/packages/tool-esptoolpy/esptool.py
espcoredump=$HOME/.platformio/packages/tool-espcoredump/espcoredump.py
"$esptool" --port "$port" --baud 921600 read_flash 0x3f0000 0x10000 "$here/core.bin"
"$espcoredump" info_core "$here/core.bin" --elf "$build/firmware.elf"
```

Confirm the two tool paths exist at execution time (`ls` the `$HOME/.platformio/packages` dir); adjust if the PlatformIO version names them differently.

- [ ] **Step 3: Verify** — `sh -n tools/fetch_coredump.sh` (syntax); the doc is prose.
- [ ] **Step 4: Commit** — `docs(receiver): coredump fetch and decode tooling`

---

### Task 5: Docs and backlog

**Files:**
- Modify: `receiver/docs/backlog.md`
- Modify: `receiver/docs/architecture.md`
- Modify: `receiver/README.md`

- [ ] **Step 1: `receiver/docs/backlog.md`**

- Remove the entire "Radio SPI is shared between two tasks with no lock" section (lines 43-54). It is replaced by the root-cause finding: RadioLib's `ArduinoHal` wraps every register transaction in `beginTransaction()`, whose Arduino ESP32 SPI driver takes a per-bus mutex, so the two tasks are serialized, not racing. The backlog does not need a replacement entry; the finding is recorded in the spec and, per Step 3 below, the architecture doc.
- Update the "The partition table uses 4 MB of a 16 MB chip" section: the proposed table's `coredump` row is outdated. The built `default.csv` already contains a 64 K `coredump` partition at `0x3f0000` (verified from `receiver/.pio/build/esp32s3-generic/partitions.bin`), so the proposed table should say `coredump | data | coredump | 0x3F0000 | 0x10000` and note that it already exists in the default table; the remaining rows (NVS/otadata/app sizes) keep their proposed values.

- [ ] **Step 2: `receiver/docs/architecture.md`**

- Add a **`radio_health.h` / `radio_health.cpp`** paragraph to "Module boundaries": Arduino-free decision module (like `topic`), host-tested by `test/host/run.sh`; the three window states (`silent`, `pinned`, `frozen`) and the recovery ladder (`decide` ordering: frozen→reboot, pinned→soft, quiet→none; backoff; `MAX_SOFT_RECOVERY`; any decode resets). Note the constants are build flags.
- Add a **`health_store.h` / `health_store.cpp`** paragraph: `Preferences` namespace `"health"`, bounded writes (once at boot, once on first SNTP sync, once per recovery event).
- Add a "Radio health and recovery" subsection to "Data flow" (or a new short section after "The receiver's own card"): monitor runs once per telemetry cycle in `loop()`, computes the window states from `lastDecodeAt` + `averageRssi`, returns an action; soft re-init re-runs `initReceiver()` (safe: task creation guarded, SPI mutex serializes), reboot via `esp_restart()`; the temperature read verifies the OpMode register and recovers immediately on failure.
- Update "The receiver's own card" telemetry table with the new fields and their sources (keep it a table like the existing one).

- [ ] **Step 3: `receiver/README.md` "Limits" section**

Add a bullet describing the recovery behavior, e.g.: the receiver monitors its own radio health once a minute and can recover a parked radio by re-running the radio init, or reboot when the receiver task wedges; `radio_ok` and the `recovery_count`/`last_recovery_s` fields on the receiver's card carry the state. Update the "Testing without a radio" paragraph to mention the `FAKE_RADIO_FAIL_MS` recovery-exercise mode.

- [ ] **Step 4: Verify** — docs are prose; nothing to run. `git diff` reads clean.
- [ ] **Step 5: Commit** — `docs(receiver): radio health module, recovery flow, and backlog cleanup`

---

### Task 6: Verification pass

Whole-branch check before the final review.

- [ ] **Step 1: Host tests** — `bash receiver/test/host/run.sh` (from `receiver/`) exits 0.
- [ ] **Step 2: Firmware build** — `pio run -e esp32s3-generic` compiles clean.
- [ ] **Step 3: Binding suite** — `cd receiver && npx playwright test`.
- [ ] **Step 4: Dashboard suite** — `cd dashboard && npm test`.
- [ ] **Step 5: Spec walkthrough** — every section of the spec maps to a commit in the branch log. Note any deviation and its reason in the task report.
- [ ] **Step 6: Fix anything found; commit** — `fix(receiver): …` per change.

---

After Task 6, dispatch a whole-branch final review before finishing the branch (per `superpowers:finishing-a-development-branch`).
