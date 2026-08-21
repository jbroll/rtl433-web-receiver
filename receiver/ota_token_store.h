#pragma once

#include <Arduino.h>

// 16 random bytes hex-encoded is 32 chars, plus a null terminator.
#define OTA_TOKEN_STORE_MAX 33

namespace ota_token_store {
bool        begin();          // opens the "ota" NVS namespace
bool        hasToken();
const char* token();          // stored token, else the OTA_TOKEN build flag, else ""
bool        set(const char* token);
#ifdef FAKE_SIGNALS
bool selfTest();
#endif
} // namespace ota_token_store
