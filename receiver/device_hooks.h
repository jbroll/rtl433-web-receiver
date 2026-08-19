#pragma once

#include <ArduinoJson.h>
#include <stdint.h>
#include <time.h>

namespace device_hooks {

typedef void (*Hook)(const char* key, JsonDocument& doc);

void registerHook(const char* model, Hook h);
void dispatch(const char* key, JsonDocument& doc);
void begin();

void setTzOffset(int16_t minutes);
void setNow(time_t t);

}  // namespace device_hooks
