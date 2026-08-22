#pragma once

#include <Arduino.h>

// mqtt://host:port or mqtts://host:port; "mqtts://weather.rkroll.com:8883" is
// 32 chars, so 128 leaves generous room.
#define MQTT_PUBLISH_STORE_URL_MAX   128
// The bridge's own AUTH_TOKEN is generated with `openssl rand -hex 24` (48
// hex chars); 65 matches WIFI_STORE_PASS_MAX's margin.
#define MQTT_PUBLISH_STORE_TOKEN_MAX 65
// A receiver pushes to at most this many dashboard-configured bridges at
// once, on top of the always-on MQTT_BROKER_URL build-flag default.
#define MQTT_PUBLISH_SLOTS 3
// NVS keys are capped at 15 characters, so the whole table is one blob under
// one key rather than an entry per slot, the same reason alias_store uses a
// blob for its 32-slot table. Three slots of a 128-byte url, a 65-byte
// token, and JSON overhead comfortably fit; 768 leaves headroom.
#define MQTT_PUBLISH_STORE_BLOB_MAX 768

namespace mqtt_publish_store {
bool        begin();          // opens the "mqtt" NVS namespace, migrates any old single-slot value
uint8_t     count();
const char* urlAt(uint8_t i);
const char* tokenAt(uint8_t i);
bool        add(const char* url, const char* token);    // updates in place if url exists
bool        remove(const char* url);
int         indexOf(const char* url);                   // -1 if absent
#ifdef FAKE_SIGNALS
bool selfTest();
#endif
} // namespace mqtt_publish_store
