#pragma once

#include <Arduino.h>

// mqtt://host:port or mqtts://host:port; "mqtts://weather.rkroll.com:8883" is
// 32 chars, so 128 leaves generous room.
#define MQTT_PUBLISH_STORE_URL_MAX   128
// The bridge's own AUTH_TOKEN is generated with `openssl rand -hex 24` (48
// hex chars); 65 matches WIFI_STORE_PASS_MAX's margin.
#define MQTT_PUBLISH_STORE_TOKEN_MAX 65

namespace mqtt_publish_store {
bool        begin();          // opens the "mqtt" NVS namespace
bool        hasBroker();
const char* brokerUrl();      // stored value, else the MQTT_BROKER_URL build flag, else ""
const char* token();          // stored value, else the MQTT_TOKEN build flag, else ""
bool        set(const char* brokerUrl, const char* token);
void        clear();
#ifdef FAKE_SIGNALS
bool selfTest();
#endif
} // namespace mqtt_publish_store
