#pragma once

#include <Arduino.h>

#include "signal_store.h"

namespace web_ui {
void begin();
void loop();
void broadcast(const DeviceSlot& slot);
void broadcastAlias(const char* topic, const char* name);
void broadcastLayout(const char* blob);
void broadcastLocation(const char* blob);
void broadcastUnits(const char* blob);
void broadcastTz(int16_t minutes);
void writeJsonString(Print& out, const char* s);
} // namespace web_ui
