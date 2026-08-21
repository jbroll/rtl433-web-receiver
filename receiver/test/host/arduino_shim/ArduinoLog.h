#pragma once

// Host stand-in for ArduinoLog.h: a global Log object with the two levels
// signal_store.cpp and alias_store.cpp call, each a printf passthrough so
// selfTest()'s own PASS/FAIL lines still show up in test output.

#include <cstdarg>
#include <cstdio>

#define CR "\n"

class LogClass {
 public:
  void notice(const char* fmt, ...) {
    va_list args;
    va_start(args, fmt);
    vprintf(fmt, args);
    va_end(args);
  }

  void warning(const char* fmt, ...) {
    va_list args;
    va_start(args, fmt);
    vprintf(fmt, args);
    va_end(args);
  }
};

inline LogClass Log;
