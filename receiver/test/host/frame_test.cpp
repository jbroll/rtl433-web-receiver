#include <stdio.h>
#include <string.h>

#include "frame.h"

static int failures = 0;

static void check(const char* what, bool ok) {
  printf("%-64s %s\n", what, ok ? "PASS" : "FAIL");
  if (!ok) failures++;
}

int main() {
  {
    SizedFrame<8> f;
    f.write((const uint8_t*)"ab", 2);
    check("data() is NUL-terminated after a partial write", f.data()[2] == '\0');
    check("length() matches what was written", f.length() == 2);
    check("no overflow on a write within capacity", !f.overflowed());
  }
  {
    // capacity 4 leaves room for 3 payload bytes plus the terminator.
    SizedFrame<4> f;
    f.write((const uint8_t*)"abc", 3);
    check("a write that exactly fills the buffer is NUL-terminated",
          f.data()[3] == '\0');
    check("the exact-fit write is not flagged as overflow", !f.overflowed());
  }
  {
    SizedFrame<4> f;
    f.write((const uint8_t*)"abcd", 4);
    check("a write past capacity is truncated to cap - 1 bytes", f.length() == 3);
    check("a write past capacity is flagged as overflow", f.overflowed());
    check("the truncated write is still NUL-terminated", f.data()[3] == '\0');
  }
  {
    // A reused buffer's stale tail must not leak past the new write's NUL.
    SizedFrame<8> f;
    f.write((const uint8_t*)"abcdefg", 7);
    f.reset();
    f.write((const uint8_t*)"xy", 2);
    check("reset() clears the overflow flag", !f.overflowed());
    check("a reused buffer terminates at the new length, not the old one",
          f.data()[2] == '\0');
    check("a reused buffer's stale tail is not read back through data()",
          strcmp(f.data(), "xy") == 0);
  }
  {
    // Frame::write's byte-at-a-time overload goes through the same path.
    SizedFrame<4> f;
    f.print('a');
    f.print('b');
    f.print('c');
    check("byte-at-a-time writes stay NUL-terminated", f.data()[3] == '\0');
  }

  printf("%d failure(s)\n", failures);
  return failures == 0 ? 0 : 1;
}
