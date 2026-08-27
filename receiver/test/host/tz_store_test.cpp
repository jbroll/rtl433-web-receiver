#include <stdio.h>

#include <Preferences.h>

#include "tz_store.h"

static int failures = 0;

static void check(const char* what, bool ok) {
  printf("%-64s %s\n", what, ok ? "PASS" : "FAIL");
  if (!ok) failures++;
}

int main() {
  check("begin() opens the tz namespace", tz_store::begin());
  check("a fresh namespace defaults to -240 (EDT)", tz_store::offsetMinutes() == -240);

  Preferences::resetCallCounts();
  tz_store::set(60);
  check("set() updates offsetMinutes()", tz_store::offsetMinutes() == 60);
  check("set() of a changed value writes to NVS", Preferences::putBytesCallCount() == 1);

  // A second Preferences handle on the same namespace/key proves the write
  // landed in NVS, not just in tz_store's own in-RAM copy.
  Preferences p;
  p.begin("tz", false);
  check("the write is readable back from NVS", p.getShort("offset", -999) == 60);

  Preferences::resetCallCounts();
  tz_store::set(60);
  check("set() of an unchanged value skips the NVS write", Preferences::putBytesCallCount() == 0);
  check("offsetMinutes() still reads the unchanged value", tz_store::offsetMinutes() == 60);

  tz_store::set(-300);
  check("set() of a second changed value updates offsetMinutes()", tz_store::offsetMinutes() == -300);
  check("the second write also lands in NVS", p.getShort("offset", -999) == -300);

  printf("tz_store selfTest: %s\n", failures == 0 ? "PASS" : "FAIL");
  return failures == 0 ? 0 : 1;
}
