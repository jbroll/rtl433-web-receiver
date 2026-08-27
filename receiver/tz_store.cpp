#include "tz_store.h"

#include <Preferences.h>

#include "device_hooks.h"

namespace tz_store {

static Preferences _prefs;
static bool        _open = false;
static int16_t     _offset = -240;

static const char* kOffset = "offset";

bool begin() {
  if (_open) {
    return true;
  }
  _open = _prefs.begin("tz", false);
  _offset = _open ? (int16_t)_prefs.getShort(kOffset, -240) : -240;
  device_hooks::setTzOffset(_offset);
  return _open;
}

int16_t offsetMinutes() { return _offset; }

void set(int16_t minutes) {
  bool changed = minutes != _offset;
  _offset = minutes;
  device_hooks::setTzOffset(minutes);
  if (_open && changed) {
    _prefs.putShort(kOffset, minutes);
  }
}

}  // namespace tz_store
