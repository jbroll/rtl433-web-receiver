#include "topic.h"

#include <string.h>

namespace topic {

static bool segmentHas(const char* seg, size_t len, char c) {
  return memchr(seg, c, len) != NULL;
}

bool validTopic(const char* t) {
  if (t == NULL || *t == '\0') {
    return false;
  }
  const char* seg = t;
  for (const char* p = t;; p++) {
    if (*p == '+' || *p == '#' || *p == ' ') {
      return false;
    }
    if (*p == '/' || *p == '\0') {
      if (p == seg) {
        return false;
      }
      seg = p + 1;
    }
    if (*p == '\0') {
      return true;
    }
  }
}

bool validFilter(const char* f) {
  if (f == NULL || *f == '\0') {
    return false;
  }
  const char* seg = f;
  for (const char* p = f;; p++) {
    if (*p == ' ') {
      return false;
    }
    if (*p == '/' || *p == '\0') {
      size_t len = (size_t)(p - seg);
      if (len == 0) {
        return false;
      }
      bool last = (*p == '\0');
      if (segmentHas(seg, len, '#') && !(len == 1 && seg[0] == '#' && last)) {
        return false;
      }
      if (segmentHas(seg, len, '+') && !(len == 1 && seg[0] == '+')) {
        return false;
      }
      seg = p + 1;
    }
    if (*p == '\0') {
      return true;
    }
  }
}

bool matchFilter(const char* filter, const char* t) {
  const char* f = filter;
  const char* p = t;
  for (;;) {
    if (f[0] == '#' && f[1] == '\0') {
      return true;
    }
    if (*f == '\0' || *p == '\0') {
      return *f == '\0' && *p == '\0';
    }
    const char* fend = strchr(f, '/');
    const char* pend = strchr(p, '/');
    if (fend == NULL) {
      fend = f + strlen(f);
    }
    if (pend == NULL) {
      pend = p + strlen(p);
    }
    size_t fl = (size_t)(fend - f), pl = (size_t)(pend - p);
    if (!(fl == 1 && f[0] == '+')) {
      if (fl != pl || strncmp(f, p, fl) != 0) {
        return false;
      }
    }
    f = (*fend == '\0') ? fend : fend + 1;
    p = (*pend == '\0') ? pend : pend + 1;
  }
}

static bool lastSegmentIs(const char* t, const char* want) {
  if (t == NULL) {
    return false;
  }
  const char* last = strrchr(t, '/');
  return strcmp(last != NULL ? last + 1 : t, want) == 0;
}

bool isAlias(const char* t) { return lastSegmentIs(t, "$alias"); }
bool isTz(const char* t) { return lastSegmentIs(t, "$tz"); }
bool isLayout(const char* t) { return lastSegmentIs(t, "$layout"); }
bool isLocation(const char* t) { return lastSegmentIs(t, "$location"); }
bool isUnits(const char* t) { return lastSegmentIs(t, "$units"); }

} // namespace topic
