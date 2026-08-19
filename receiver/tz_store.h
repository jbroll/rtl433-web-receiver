#pragma once

#include <Arduino.h>
#include <stdint.h>

namespace tz_store {
bool     begin();
int16_t  offsetMinutes();
void     set(int16_t minutes);
}  // namespace tz_store
