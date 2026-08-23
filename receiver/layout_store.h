#pragma once

#include <Arduino.h>

// A layout is one JSON object for the whole receiver (unlike alias_store's
// per-topic table), so it is one NVS entry holding the blob verbatim rather
// than a table serialized to/from JSON at persist time.
// A card costs the template about 170 bytes, and SIGNAL_DEVICE_SLOTS is 24, so
// 2 KB ran out at seven devices. 4000 is the ceiling nvs_set_str() documents
// for a single string entry.
#define LAYOUT_STORE_MAX 4000

namespace layout_store {
bool        begin();
// Never NULL; "" when nothing is stored.
const char* get();
bool        set(const char* json);
#ifdef FAKE_SIGNALS
bool selfTest();
#endif
} // namespace layout_store
