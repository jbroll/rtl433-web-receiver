#pragma once

#include <Arduino.h>

// 802.11 SSID limit is 32 bytes; WPA2 password limit is 64 bytes. Both plus a
// null terminator.
#define WIFI_STORE_SSID_MAX 33
#define WIFI_STORE_PASS_MAX 65

namespace wifi_store {
bool        begin();          // opens the "wifi" NVS namespace
bool        hasCredentials();
const char* ssid();
const char* password();
bool        set(const char* ssid, const char* password);
void        clear();
#ifdef FAKE_SIGNALS
bool selfTest();
#endif
} // namespace wifi_store
