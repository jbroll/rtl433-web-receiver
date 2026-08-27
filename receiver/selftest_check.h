#pragma once

// Shared body for the eight identical `static bool check(const char* what,
// bool ok)` PASS/FAIL loggers each store's selfTest() carried on its own.
#ifdef FAKE_SIGNALS
#include <ArduinoLog.h>

inline bool selfTestCheck(const char* module, const char* what, bool ok) {
  Log.notice(F("%s selfTest %s: %s" CR), module, what, ok ? "PASS" : "FAIL");
  return ok;
}
#endif
