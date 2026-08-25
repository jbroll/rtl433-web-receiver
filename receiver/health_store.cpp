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
  if (_open) {
    return true;
  }
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
