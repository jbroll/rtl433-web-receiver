#pragma once

#include <Arduino.h>

// Any hex token up to 64 chars, plus a null terminator.
#define OTA_TOKEN_STORE_MAX 65

namespace ota_token_store {
bool        begin();          // opens the "ota" NVS namespace
bool        hasToken();
const char* token();          // stored token, else the OTA_TOKEN build flag, else ""
bool        set(const char* token);
bool        clear();          // erases the stored token; token() falls back to OTA_TOKEN if set
#ifdef FAKE_SIGNALS
bool selfTest();
#endif
} // namespace ota_token_store
