#pragma once

// Host stand-in for Arduino's Print: only the two overloads
// web_ui::writeJsonString and mqtt_publish's BufferPrint actually call.

#include <stdint.h>
#include <stddef.h>

class Print {
 public:
  virtual ~Print() {}
  virtual size_t write(uint8_t b) = 0;
  // Real Arduino's Print declares this virtual too, so a subclass (like
  // web_ui.cpp's Frame) can override it to avoid a byte-at-a-time copy.
  virtual size_t write(const uint8_t* buffer, size_t size) {
    size_t n = 0;
    while (size--) n += write(*buffer++);
    return n;
  }
  size_t write(const char* s) {
    size_t n = 0;
    while (s && *s) n += write((uint8_t)*s++);
    return n;
  }
  size_t print(char c) { return write((uint8_t)c); }
  size_t print(const char* s) { return write(s); }
};
