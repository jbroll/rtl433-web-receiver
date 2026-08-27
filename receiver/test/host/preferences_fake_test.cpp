#include <stdio.h>
#include <string.h>

#include <Preferences.h>

// Pins two typing behaviors of the Preferences fake against what real NVS
// does: a key's type follows whichever call wrote it last, and reading a
// key with the wrong accessor reads as absent rather than surfacing the
// other type's bytes.

static int failures = 0;

static void check(const char* what, bool ok) {
  printf("%-64s %s\n", what, ok ? "PASS" : "FAIL");
  if (!ok) failures++;
}

int main() {
  Preferences p;
  p.begin("typing", false);

  p.putBytes("k", "abc", 3);
  p.putString("k", "hello");
  check("putString over a bytes key retypes it",
        p.getBytesLength("k") == 0 && strcmp(p.getString("k", "default").c_str(), "hello") == 0);

  p.putString("k2", "hello");
  check("getString reads back a string key normally",
        strcmp(p.getString("k2", "default").c_str(), "hello") == 0);
  p.putBytes("k2", "xyz", 3);
  check("getString on a bytes key returns the default",
        strcmp(p.getString("k2", "default").c_str(), "default") == 0);

  printf("preferences_fake selfTest: %s\n", failures == 0 ? "PASS" : "FAIL");
  return failures == 0 ? 0 : 1;
}
