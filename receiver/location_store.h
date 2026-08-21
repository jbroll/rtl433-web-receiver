#pragma once

#include <Arduino.h>

// A location is one JSON object for the whole receiver (unlike alias_store's
// per-topic table), so it is one NVS entry holding the blob verbatim rather
// than a table serialized to/from JSON at persist time. Same storage shape as
// layout_store, sized for {lat,lon,label,zone,zoom} rather than a layout
// template.
#define LOCATION_STORE_MAX 512

namespace location_store {
bool        begin();
// Never NULL; "" when nothing is stored.
const char* get();
bool        set(const char* json);
#ifdef FAKE_SIGNALS
bool selfTest();
#endif
} // namespace location_store
