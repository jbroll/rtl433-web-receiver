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

namespace radio_health {

enum class HealthAction : uint8_t { none, softReinit, reboot };

// The monitor's state, carried across telemetry cycles. Everything here takes
// time as a parameter, so the module never reads the millis() clock itself.
struct HealthState {
  unsigned long lastDecodeAt = 0;    // uptime ms of the most recent decode, 0 until first
  int           lastFloor = INT16_MIN; // previous averageRssi, for the frozen window
  unsigned long floorSince = 0;      // uptime ms when lastFloor last changed
  unsigned long lastRecoveryAt = 0;  // uptime ms of the last soft re-init, 0 until first
};

// Pure decision, host-tested directly. silent/pinned/frozen are the window
// states; elapsedMs is uptime since the last recovery (ULONG_MAX if none yet).
HealthAction decide(bool silent, bool pinned, bool frozen, unsigned long elapsedMs);

// One telemetry cycle. now is uptime ms, floor the current averageRssi, and
// lastDecodeAt the uptime ms of the most recent decode. Resets counters when a
// decode arrived since the last cycle, then returns the recovery action.
HealthAction evaluate(HealthState& state, unsigned long now, int floor,
                      unsigned long lastDecodeAt);

// Stamps a completed soft re-init into the state.
void noteRecovery(HealthState& state, unsigned long now);

} // namespace radio_health
