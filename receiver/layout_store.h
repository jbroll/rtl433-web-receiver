#pragma once

#include <Arduino.h>

// A layout is one JSON object for the whole receiver (unlike alias_store's
// per-topic table), so it is one NVS entry holding the blob verbatim rather
// than a table serialized to/from JSON at persist time.
// A card costs the template about 165 bytes, and SIGNAL_DEVICE_SLOTS is 24
// plus four feed cards, so 2 KB ran out at seven devices. The blob is stored
// with putBytes() rather than putString() because an NVS string has to fit one
// page's free run, which capped it near 2.7 KB on a device whose nvs partition
// already held the radio calibration.
#define LAYOUT_STORE_MAX 5120

namespace layout_store {
bool        begin();
// Never NULL; "" when nothing is stored.
const char* get();
bool        set(const char* json);
#ifdef FAKE_SIGNALS
bool selfTest();
#endif
} // namespace layout_store
