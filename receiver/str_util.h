#pragma once

#include <stddef.h>
#include <string.h>

// strncpy leaves dest unterminated when src fills it; the stores rely on
// every fixed buffer being a C string.
inline void copyTruncated(char* dest, size_t destSize, const char* src) {
  strncpy(dest, src, destSize - 1);
  dest[destSize - 1] = '\0';
}
