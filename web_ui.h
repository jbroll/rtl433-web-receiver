#pragma once

#include <Arduino.h>

#include "signal_store.h"

namespace web_ui {
void begin();
void loop();
void broadcast(const DeviceSlot& slot);
void writeJsonString(Print& out, const char* s);
} // namespace web_ui
