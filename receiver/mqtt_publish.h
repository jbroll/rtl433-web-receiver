#pragma once

#include <ArduinoJson.h>
#include <stdint.h>

namespace mqtt_publish {
// Reads mqtt_publish_store and the MQTT_BROKER_URL/MQTT_TOKEN build flags;
// call once, after WiFi has come up, and again any time the store's table
// changes (see web_ui.cpp's /$mqtt handlers). clientId should be the
// receiver's mDNS hostname, matching the topic segment signal_store keys are
// built with.
void begin(const char* clientId);
// Services every connection's connect/reconnect (backed off by
// MQTT_RECONNECT_BACKOFF_MS) and PubSubClient::loop(). Call every main-loop
// iteration. A no-op when no broker is configured or WiFi is down.
void loop();
// Registered as a signal_store::RecordHook. Publishes doc, retained, to
// topic key, on every connected connection. A no-op (fire-and-forget) when
// no broker is configured; a connection that isn't currently connected is
// simply skipped.
void onRecord(const char* key, JsonDocument& doc);
// Publishes the stored $layout, retained, to <clientId>/$layout, on every
// connected connection. Same fire-and-forget behavior as onRecord.
void publishLayout(const char* blob);
// Publishes the stored $location, retained, to <clientId>/$location, on
// every connected connection. Same fire-and-forget behavior as onRecord.
void publishLocation(const char* blob);
// Publishes the stored $units, retained, to <clientId>/$units, on every
// connected connection. Same fire-and-forget behavior as onRecord.
void publishUnits(const char* blob);
// Publishes one alias, retained, to topic verbatim (it already carries the
// source segment). An empty name is a zero-length retained publish, a delete.
void publishAlias(const char* topic, const char* name);
// Publishes the current tz offset, retained, to <clientId>/$tz, on every
// connected connection. Same fire-and-forget behavior as onRecord.
void publishTz(int16_t minutes);
// Active connections: table slots with a valid broker url, plus the
// build-flag default if MQTT_BROKER_URL is set and valid. Used by the
// /$mqtt HTTP endpoint to report status; token is never exposed here.
uint8_t     count();
const char* urlAt(uint8_t i);
bool        connectedAt(uint8_t i);
} // namespace mqtt_publish
