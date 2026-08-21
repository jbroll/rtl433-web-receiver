#pragma once

#include <ArduinoJson.h>

namespace mqtt_publish {
// Reads mqtt_publish_store; call once, after WiFi has come up. clientId
// should be the receiver's mDNS hostname, matching the topic segment
// signal_store keys are built with.
void begin(const char* clientId);
// Services connect/reconnect (backed off by MQTT_RECONNECT_BACKOFF_MS) and
// PubSubClient::loop(). Call every main-loop iteration. A no-op when no
// broker is configured or WiFi is down.
void loop();
// Registered as a signal_store::RecordHook. Publishes doc, retained, to
// topic key. A no-op (fire-and-forget) if not currently connected.
void onRecord(const char* key, JsonDocument& doc);
} // namespace mqtt_publish
