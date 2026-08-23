#pragma once

#include <Arduino.h>

// Unit preferences are one JSON object for the whole receiver (unlike
// alias_store's per-topic table), so it is one NVS entry holding the blob
// verbatim rather than a table serialized to/from JSON at persist time. Same
// storage shape as location_store, sized for a units/decimals pair plus a
// per-quantity override map.
#define UNITS_STORE_MAX 256

namespace units_store {
bool        begin();
// Never NULL; "" when nothing is stored.
const char* get();
bool        set(const char* json);
#ifdef FAKE_SIGNALS
bool selfTest();
#endif
} // namespace units_store
