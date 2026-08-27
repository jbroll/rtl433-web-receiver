#include <stdio.h>
#include <string.h>

#include <new>

#include "frame.h"

static int failures = 0;

static void check(const char* what, bool ok) {
  printf("%-64s %s\n", what, ok ? "PASS" : "FAIL");
  if (!ok) failures++;
}

// Placement-news a SizedFrame<CAP> into memory poisoned with a non-zero
// pattern first. A freshly declared SizedFrame on the stack often lands on
// zeroed memory anyway, so a check against a coincidentally-zero byte would
// still pass even if the code under test never wrote a terminator; poisoning
// the storage first means only an actual write can produce a NUL.
template <size_t CAP>
struct PoisonedFrame {
  alignas(SizedFrame<CAP>) unsigned char storage[sizeof(SizedFrame<CAP>)];
  SizedFrame<CAP>* f;

  PoisonedFrame() {
    memset(storage, 0xAA, sizeof(storage));
    f = new (storage) SizedFrame<CAP>();
  }
  ~PoisonedFrame() { f->~SizedFrame<CAP>(); }
};

int main() {
  {
    PoisonedFrame<8> p;
    p.f->write((const uint8_t*)"ab", 2);
    check("data() is NUL-terminated after a partial write", p.f->data()[2] == '\0');
    check("length() matches what was written", p.f->length() == 2);
    check("no overflow on a write within capacity", !p.f->overflowed());
  }
  {
    // capacity 4 leaves room for 3 payload bytes plus the terminator.
    PoisonedFrame<4> p;
    p.f->write((const uint8_t*)"abc", 3);
    check("a write that exactly fills the buffer is NUL-terminated",
          p.f->data()[3] == '\0');
    check("the exact-fit write is not flagged as overflow", !p.f->overflowed());
  }
  {
    PoisonedFrame<4> p;
    p.f->write((const uint8_t*)"abcd", 4);
    check("a write past capacity is truncated to cap - 1 bytes", p.f->length() == 3);
    check("a write past capacity is flagged as overflow", p.f->overflowed());
    check("the truncated write is still NUL-terminated", p.f->data()[3] == '\0');
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
    // reset() must terminate on its own; nothing here writes after it.
    SizedFrame<8> f;
    f.write((const uint8_t*)"abcdefg", 7);
    f.reset();
    check("reset() alone leaves data() empty with no follow-up write",
          f.data()[0] == '\0');
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
