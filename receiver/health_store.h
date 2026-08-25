#pragma once

#include <Arduino.h>
#include <stdint.h>
#include <time.h>

namespace health_store {
// Reads the "health" NVS namespace and loads the counters into RAM. Call once
// from setup(), before noteBoot().
bool     begin();
uint32_t bootCount();
uint8_t  resetReason();
uint32_t recoveryCount();

// setup(): increments boot_count and stores the reset reason. Bounded: once per boot.
void noteBoot(uint8_t resetReason);
// Per soft re-init: increments recovery_count; if utc is a real epoch (>0),
// also stores last_recovery. Not bounded: a radio that stays deaf re-arms
// recovery every RECOVERY_BACKOFF_MS, and each attempt writes NVS again.
void noteRecovery(time_t utc);
// Once, on the first SNTP sync of a boot: stores last_boot_utc.
void noteFirstSync(time_t utc);
} // namespace health_store
