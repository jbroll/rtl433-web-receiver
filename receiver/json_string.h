#pragma once

#include <Arduino.h>

// JSON string escaping, its own translation unit (rather than living in
// web_ui.cpp) so mqtt_publish.cpp can use it without pulling in web_ui.h's
// WebServer/Update/lwip dependencies, none of which build on host.
namespace json_string {
void writeJsonString(Print& out, const char* s);
} // namespace json_string
