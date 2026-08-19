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
        radio_health::decide(true, false, false, NEVER) == radio_health::HealthAction::none);
  // parked -> soft
  check("a parked radio (silent + pinned) soft re-inits",
        radio_health::decide(true, true, false, NEVER) == radio_health::HealthAction::softReinit);
  // wedged -> reboot
  check("a wedged radio (silent + frozen, healthy floor) reboots",
        radio_health::decide(true, false, true, NEVER) == radio_health::HealthAction::reboot);
  // A stuck chip is frozen AND pinned at the below-floor RSSI. Reboot does not
  // power-cycle the radio, so it survives esp_restart() and the reboot would
  // only take the web server down; soft re-init is the recovery attempt.
  check("a stuck chip (frozen + pinned) soft re-inits instead of rebooting",
        radio_health::decide(true, true, true, NEVER) == radio_health::HealthAction::softReinit);
  // active radio
  check("an active radio takes no action",
        radio_health::decide(false, true, false, NEVER) == radio_health::HealthAction::none);
  // backoff
  check("backoff suppresses a re-trigger",
        radio_health::decide(true, true, false, RECOVERY_BACKOFF_MS - 1) == radio_health::HealthAction::none);
  check("a re-trigger fires again after the backoff",
        radio_health::decide(true, true, false, RECOVERY_BACKOFF_MS + 1) == radio_health::HealthAction::softReinit);

  // evaluate(): the window computation, the decode reset, and the backoff
  radio_health::HealthState st;
  check("a fresh, active radio is healthy",
        radio_health::evaluate(st, 0, -85, 0) == radio_health::HealthAction::none);
  check("a short quiet period is not yet silent",
        radio_health::evaluate(st, 10000, -85, 0) == radio_health::HealthAction::none);
  check("a pinned floor across the silent window soft re-inits",
        radio_health::evaluate(st, SILENT_MS + 1, NOISE_FLOOR_DBM, 0) == radio_health::HealthAction::softReinit);

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

  // frozen window
  radio_health::HealthState st2;
  radio_health::evaluate(st2, 0, -85, 0);
  check("a stable floor is not frozen before FROZEN_MS",
        radio_health::evaluate(st2, FROZEN_MS - 1, -85, 0) == radio_health::HealthAction::none);
  check("a byte-identical healthy floor across FROZEN_MS is frozen and reboots",
        radio_health::evaluate(st2, FROZEN_MS, -85, 0) == radio_health::HealthAction::reboot);
  // a stuck chip is frozen AND pinned; the pinned signature must win
  radio_health::HealthState st3;
  radio_health::evaluate(st3, 0, NOISE_FLOOR_DBM, 0);
  check("a frozen pinned floor soft re-inits instead of rebooting",
        radio_health::evaluate(st3, FROZEN_MS, NOISE_FLOOR_DBM, 0) == radio_health::HealthAction::softReinit);

  printf("%s\n", failures == 0 ? "radio_health: PASS" : "radio_health: FAIL");
  return failures == 0 ? 0 : 1;
}