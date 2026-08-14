#pragma once

#include <Arduino.h>

#include "signal_store.h"

namespace web_ui {
void begin();
void loop();
// isDecode false marks the frame as the receiver's own telemetry, which the
// page applies to the device but keeps out of its raw log.
void broadcast(const DeviceSlot& slot, bool isDecode = true);
void writeJsonString(Print& out, const char* s);
} // namespace web_ui
