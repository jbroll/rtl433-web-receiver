#pragma once

#include <stdint.h>
#include <time.h>

namespace device_hooks {

struct Reading {
  const char* model;
  bool   has_rain_mm;
  float  rain_mm;
  bool   has_rain_in;
  float  rain_in;
  bool   set_rain_today_mm;
  float  rain_today_mm;
};

typedef void (*Hook)(const char* key, Reading& r);

void registerHook(const char* model, Hook h);
void dispatch(const char* key, Reading& r);
void begin();

void setTzOffset(int16_t minutes);
void setNow(time_t t);

}  // namespace device_hooks
