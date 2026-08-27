#pragma once

#include <ArduinoJson.h>
#include <stdint.h>

#ifdef FAKE_SIGNALS
#include <PubSubClient.h>
#include <WiFiClientSecure.h>
#endif

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
// Active connections: table slots plus the build-flag default if
// MQTT_BROKER_URL is set, whether or not each one's url parsed. Used by the
// /$mqtt HTTP endpoint to report status; token is never exposed here.
uint8_t     count();
const char* urlAt(uint8_t i);
bool        connectedAt(uint8_t i);
// Why urlAt(i) will never connect, or nullptr if it's enabled or does not
// exist. Set when a slot's url fails mqtt(s)://host:port parsing.
const char* reasonAt(uint8_t i);

#ifdef FAKE_SIGNALS
// Host-test-only: whether setupConnection() enabled slot i (it got a server
// and a grown buffer), independent of whether it is currently connected.
// connectedAt() alone can't distinguish "never enabled" from "enabled but
// not yet connected" since neither drives loop()/connectOnce().
bool enabledAt(uint8_t i);
// Host-test-only: the live connection objects behind slot i, ranked the same
// as urlAt()/connectedAt(). References into a static array that is never
// reallocated, so they stay valid across the begin() that reassigns i.
PubSubClient&     mqttAt(uint8_t i);
WiFiClient&       plainClientAt(uint8_t i);
WiFiClientSecure& secureClientAt(uint8_t i);
// Host-test-only: the physical _conn[] slots by raw index (not ranked, and
// reachable whether or not the slot is currently live), so a test can wipe
// every fake's bookkeeping between scenarios that reuse the same slots.
uint8_t           maxConnections();
PubSubClient&     mqttRawAt(uint8_t physicalIndex);
WiFiClient&       plainClientRawAt(uint8_t physicalIndex);
WiFiClientSecure& secureClientRawAt(uint8_t physicalIndex);
#endif
} // namespace mqtt_publish
