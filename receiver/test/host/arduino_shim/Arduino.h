#pragma once

// Host stand-in for the pieces of Arduino.h that signal_store.cpp and
// alias_store.cpp actually use: millis()/delay() for timestamps, F() as a
// no-op (there is no flash-vs-RAM distinction on host), and just enough of
// String for ArduinoJson's Arduino-String integration (.as<String>(),
// serializeJson into a String) to link.

#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include <string>

#define F(x) x

// Real millis() only advances with wall-clock time, so calls made back to
// back (no delay() between them) read the same value. Only delay() moves
// this counter; selfTest() relies on that to land several record() calls in
// the same tick.
inline unsigned long& _fakeMillisCounter() {
  static unsigned long ms = 1;
  return ms;
}

inline unsigned long millis() {
  return _fakeMillisCounter();
}

inline void delay(unsigned long ms) {
  _fakeMillisCounter() += ms;
}

class String {
 public:
  String() {}
  String(const char* s) : _s(s ? s : "") {}

  String& operator=(const char* s) {
    _s = s ? s : "";
    return *this;
  }

  bool concat(const char* s) {
    if (s) _s += s;
    return true;
  }

  const char* c_str() const { return _s.c_str(); }
  size_t      length() const { return _s.size(); }

 private:
  std::string _s;
};
