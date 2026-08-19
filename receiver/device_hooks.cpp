#include "device_hooks.h"

#include <stdlib.h>
#include <string.h>

namespace device_hooks {

#define RAIN_HOOK_SLOTS 8
#define RAIN_KEY_MAX    96
#define MAX_HOOKS       8

struct RainBaseline {
  char    key[RAIN_KEY_MAX];
  float   baseline;
  int32_t day;
  bool    used;
};

struct HookEntry {
  char  model[32];
  Hook  fn;
  bool  used;
};

static RainBaseline _rain[RAIN_HOOK_SLOTS];
static HookEntry    _hooks[MAX_HOOKS];
static int16_t      _tzOffset = -240;
static time_t       _nowOverride = 0;

static time_t now() {
  return _nowOverride > 0 ? _nowOverride : time(NULL);
}

static int32_t localDay() {
  time_t t = now();
  if (t < 1700000000) return 0;
  return (int32_t)((t + (time_t)_tzOffset * 60) / 86400);
}

void setTzOffset(int16_t minutes) { _tzOffset = minutes; }
void setNow(time_t t) { _nowOverride = t; }

void registerHook(const char* model, Hook h) {
  for (int i = 0; i < MAX_HOOKS; i++) {
    if (!_hooks[i].used) {
      strncpy(_hooks[i].model, model, sizeof(_hooks[i].model) - 1);
      _hooks[i].model[sizeof(_hooks[i].model) - 1] = '\0';
      _hooks[i].fn = h;
      _hooks[i].used = true;
      return;
    }
  }
}

static Hook findHook(const char* model) {
  if (model == NULL) return NULL;
  for (int i = 0; i < MAX_HOOKS; i++) {
    if (_hooks[i].used && strcmp(_hooks[i].model, model) == 0) {
      return _hooks[i].fn;
    }
  }
  return NULL;
}

static int findRain(const char* key) {
  for (int i = 0; i < RAIN_HOOK_SLOTS; i++) {
    if (_rain[i].used && strcmp(_rain[i].key, key) == 0) return i;
  }
  return -1;
}

static int claimRain() {
  for (int i = 0; i < RAIN_HOOK_SLOTS; i++) {
    if (!_rain[i].used) return i;
  }
  int oldest = 0;
  for (int i = 1; i < RAIN_HOOK_SLOTS; i++) {
    if (_rain[i].day < _rain[oldest].day) oldest = i;
  }
  _rain[oldest].used = false;
  return oldest;
}

static void rainHook(const char* key, JsonDocument& doc) {
  if (!doc["rain_mm"].is<float>()) return;
  float mm = doc["rain_mm"].as<float>();

  int32_t day = localDay();
  int idx = findRain(key);

  if (idx < 0) {
    idx = claimRain();
    strncpy(_rain[idx].key, key, RAIN_KEY_MAX - 1);
    _rain[idx].key[RAIN_KEY_MAX - 1] = '\0';
    _rain[idx].baseline = mm;
    _rain[idx].day = day;
    _rain[idx].used = true;
    doc["rain_today_mm"] = 0.0f;
    return;
  }

  if (day != _rain[idx].day || mm < _rain[idx].baseline) {
    _rain[idx].baseline = mm;
    _rain[idx].day = day;
    doc["rain_today_mm"] = 0.0f;
    return;
  }

  float delta = mm - _rain[idx].baseline;
  doc["rain_today_mm"] = (float)(int)(delta * 10 + (delta >= 0 ? 0.5f : -0.5f)) / 10.0f;
}

void dispatch(const char* key, JsonDocument& doc) {
  const char* model = doc["model"].as<const char*>();
  Hook h = findHook(model);
  if (h != NULL) h(key, doc);
}

void begin() {
  memset(_rain, 0, sizeof(_rain));
  memset(_hooks, 0, sizeof(_hooks));
  registerHook("Acurite-5n1", rainHook);
}

}  // namespace device_hooks
