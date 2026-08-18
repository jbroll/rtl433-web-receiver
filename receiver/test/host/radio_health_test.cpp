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
