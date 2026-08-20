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
