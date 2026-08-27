#pragma once

#include <Arduino.h>
#include <string.h>

// Assembles a whole SSE frame so broadcast() sends it in one call, and flags
// overflow rather than clamping, so a truncated frame is never put on the wire.
class Frame : public Print {
 public:
  size_t write(uint8_t b) override { return write(&b, 1); }

  size_t write(const uint8_t* data, size_t len) override {
    size_t room = _cap - 1 - _len;
    size_t n = len < room ? len : room;
    if (n < len) {
      _overflow = true;
    }
    memcpy(_buf + _len, data, n);
    _len += n;
    _buf[_len] = '\0';
    return n;
  }

  const char* data() const { return _buf; }
  size_t      length() const { return _len; }
  bool        overflowed() const { return _overflow; }

  void reset() {
    _len = 0;
    _overflow = false;
    _buf[0] = '\0';
  }

 protected:
  Frame(char* buf, size_t cap) : _buf(buf), _cap(cap) {}

 private:
  char*  _buf;
  size_t _cap;
  size_t _len      = 0;
  bool   _overflow = false;
};

template <size_t CAP>
class SizedFrame : public Frame {
 public:
  SizedFrame() : Frame(_storage, CAP) {}

 private:
  char _storage[CAP];
};
