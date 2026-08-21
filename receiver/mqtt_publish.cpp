#include "mqtt_publish.h"

#include <ArduinoLog.h>
#include <PubSubClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <string.h>
#include <stdlib.h>

#include "mqtt_publish_store.h"
#include "signal_store.h"

#ifndef MQTT_RECONNECT_BACKOFF_MS
#define MQTT_RECONNECT_BACKOFF_MS 30000
#endif

namespace mqtt_publish {

// Let's Encrypt's ISRG Root X1, self-signed, valid 2015-06-04 to 2035-06-04.
static const char ISRG_ROOT_X1[] PROGMEM = R"EOF(
-----BEGIN CERTIFICATE-----
MIIFazCCA1OgAwIBAgIRAIIQz7DSQONZRGPgu2OCiwAwDQYJKoZIhvcNAQELBQAw
TzELMAkGA1UEBhMCVVMxKTAnBgNVBAoTIEludGVybmV0IFNlY3VyaXR5IFJlc2Vh
cmNoIEdyb3VwMRUwEwYDVQQDEwxJU1JHIFJvb3QgWDEwHhcNMTUwNjA0MTEwNDM4
WhcNMzUwNjA0MTEwNDM4WjBPMQswCQYDVQQGEwJVUzEpMCcGA1UEChMgSW50ZXJu
ZXQgU2VjdXJpdHkgUmVzZWFyY2ggR3JvdXAxFTATBgNVBAMTDElTUkcgUm9vdCBY
MTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBAK3oJHP0FDfzm54rVygc
h77ct984kIxuPOZXoHj3dcKi/vVqbvYATyjb3miGbESTtrFj/RQSa78f0uoxmyF+
0TM8ukj13Xnfs7j/EvEhmkvBioZxaUpmZmyPfjxwv60pIgbz5MDmgK7iS4+3mX6U
A5/TR5d8mUgjU+g4rk8Kb4Mu0UlXjIB0ttov0DiNewNwIRt18jA8+o+u3dpjq+sW
T8KOEUt+zwvo/7V3LvSye0rgTBIlDHCNAymg4VMk7BPZ7hm/ELNKjD+Jo2FR3qyH
B5T0Y3HsLuJvW5iB4YlcNHlsdu87kGJ55tukmi8mxdAQ4Q7e2RCOFvu396j3x+UC
B5iPNgiV5+I3lg02dZ77DnKxHZu8A/lJBdiB3QW0KtZB6awBdpUKD9jf1b0SHzUv
KBds0pjBqAlkd25HN7rOrFleaJ1/ctaJxQZBKT5ZPt0m9STJEadao0xAH0ahmbWn
OlFuhjuefXKnEgV4We0+UXgVCwOPjdAvBbI+e0ocS3MFEvzG6uBQE3xDk3SzynTn
jh8BCNAw1FtxNrQHusEwMFxIt4I7mKZ9YIqioymCzLq9gwQbooMDQaHWBfEbwrbw
qHyGO0aoSCqI3Haadr8faqU9GY/rOPNk3sgrDQoo//fb4hVC1CLQJ13hef4Y53CI
rU7m2Ys6xt0nUW7/vGT1M0NPAgMBAAGjQjBAMA4GA1UdDwEB/wQEAwIBBjAPBgNV
HRMBAf8EBTADAQH/MB0GA1UdDgQWBBR5tFnme7bl5AFzgAiIyBpY9umbbjANBgkq
hkiG9w0BAQsFAAOCAgEAVR9YqbyyqFDQDLHYGmkgJykIrGF1XIpu+ILlaS/V9lZL
ubhzEFnTIZd+50xx+7LSYK05qAvqFyFWhfFQDlnrzuBZ6brJFe+GnY+EgPbk6ZGQ
3BebYhtF8GaV0nxvwuo77x/Py9auJ/GpsMiu/X1+mvoiBOv/2X/qkSsisRcOj/KK
NFtY2PwByVS5uCbMiogziUwthDyC3+6WVwW6LLv3xLfHTjuCvjHIInNzktHCgKQ5
ORAzI4JMPJ+GslWYHb4phowim57iaztXOoJwTdwJx4nLCgdNbOhdjsnvzqvHu7Ur
TkXWStAmzOVyyghqpZXjFaH3pO3JLF+l+/+sKAIuvtd7u+Nxe5AW0wdeRlN8NwdC
jNPElpzVmbUq4JUagEiuTDkHzsxHpFKVK7q4+63SM1N95R1NbdWhscdCb+ZAJzVc
oyi3B43njTOQ5yOf+1CceWxG1bQVs5ZufpsMljq4Ui0/1lvh+wjChP4kqKOJ2qxq
4RgqsahDYVvTH9w7jXbyLeiNdd8XM2w9U/t7y0Ff/9yi0GE44Za4rF2LN9d11TPA
mRGunUHBcnWEvgJBQl9nJEiU0Zsnvgc/ubhPgXRR4Xq37Z0j4r7g1SgEEzwxA57d
emyPxgcYxn/eR44/KJ4EBs+lVDR3veyJm+kXQ99b21/+jh5Xos1AnX5iItreGCc=
-----END CERTIFICATE-----
)EOF";

struct ParsedBroker {
  bool     tls   = false;
  bool     valid = false;
  char     host[64] = "";
  uint16_t port  = 0;
};

// mqtt://host:port or mqtts://host:port. A port is required, matching every
// example in .env.example and the provisioning form's placeholder — this
// mirrors dashboard/src/sources.js's normalizeBase() in spirit (a small,
// deliberately strict parser for a URL shape this project controls both
// ends of), not URL parsing in general.
static ParsedBroker parseBrokerUrl(const char* url) {
  ParsedBroker p;
  if (url == nullptr) return p;
  const char* rest;
  if (strncmp(url, "mqtts://", 8) == 0) {
    p.tls = true;
    rest  = url + 8;
  } else if (strncmp(url, "mqtt://", 7) == 0) {
    p.tls = false;
    rest  = url + 7;
  } else {
    return p;
  }
  const char* colon = strchr(rest, ':');
  if (colon == nullptr) return p;
  size_t hostLen = (size_t)(colon - rest);
  if (hostLen == 0 || hostLen >= sizeof(p.host)) return p;
  strncpy(p.host, rest, hostLen);
  p.host[hostLen] = '\0';
  char* end   = nullptr;
  long  port  = strtol(colon + 1, &end, 10);
  if (end == colon + 1 || (*end != '\0') || port <= 0 || port > 65535) return p;
  p.port  = (uint16_t)port;
  p.valid = true;
  return p;
}

static WiFiClient       _plainClient;
static WiFiClientSecure _secureClient;
static PubSubClient     _mqtt;
static ParsedBroker     _broker;
static char             _token[MQTT_PUBLISH_STORE_TOKEN_MAX] = "";
static char             _clientId[64] = "";
static bool             _enabled = false;
static unsigned long    _lastAttempt = 0;

static void replayAll() {
  uint8_t sent = 0;
  for (uint8_t i = 0; i < SIGNAL_DEVICE_SLOTS; i++) {
    const DeviceSlot* slot = signal_store::slotAt(i);
    if (slot == nullptr) continue;
    const char* payload = signal_store::latestPayload(*slot);
    if (payload == nullptr) continue;
    if (_mqtt.publish(slot->key, payload, true)) sent++;
  }
  Log.notice(F("mqtt publish: replayed %d retained record(s) on connect" CR), sent);
}

static bool connectOnce() {
  if (millis() - _lastAttempt < MQTT_RECONNECT_BACKOFF_MS) return false;
  _lastAttempt = millis();
  bool ok = _token[0] != '\0'
                ? _mqtt.connect(_clientId, "", _token)
                : _mqtt.connect(_clientId);
  if (ok) {
    Log.notice(F("mqtt publish: connected to %s:%u" CR), _broker.host, _broker.port);
    replayAll();
  } else {
    Log.warning(F("mqtt publish: connect to %s:%u failed, state=%d" CR),
                _broker.host, _broker.port, _mqtt.state());
  }
  return ok;
}

void begin(const char* clientId) {
  strncpy(_clientId, clientId, sizeof(_clientId) - 1);
  _clientId[sizeof(_clientId) - 1] = '\0';

  const char* url = mqtt_publish_store::brokerUrl();
  if (url[0] == '\0') {
    Log.notice(F("mqtt publish: no broker configured, disabled" CR));
    _enabled = false;
    return;
  }
  _broker = parseBrokerUrl(url);
  if (!_broker.valid) {
    Log.warning(F("mqtt publish: broker URL \"%s\" is not a valid mqtt(s)://host:port, disabled" CR), url);
    _enabled = false;
    return;
  }
  strncpy(_token, mqtt_publish_store::token(), sizeof(_token) - 1);
  _token[sizeof(_token) - 1] = '\0';

  if (_broker.tls) {
    _secureClient.setCACert(ISRG_ROOT_X1);
    _secureClient.setTimeout(5);
    _secureClient.setHandshakeTimeout(5);
    _mqtt.setClient(_secureClient);
  } else {
    _mqtt.setClient(_plainClient);
  }
  _mqtt.setServer(_broker.host, _broker.port);
  // A dead broker must not stall loop(), and with it rf.loop(), for the 15 s
  // PubSubClient default.
  _mqtt.setSocketTimeout(5);
  _enabled = true;
  Log.notice(F("mqtt publish: enabled, broker %s:%u (%s)" CR),
             _broker.host, _broker.port, _broker.tls ? "TLS" : "plain");
  _lastAttempt = millis() - MQTT_RECONNECT_BACKOFF_MS;
}

void loop() {
  if (!_enabled) return;
  if (WiFi.status() != WL_CONNECTED) return;
  if (!_mqtt.connected()) {
    connectOnce();
    return;
  }
  _mqtt.loop();
}

void onRecord(const char* key, JsonDocument& doc) {
  if (!_enabled || !_mqtt.connected()) return;
  char payload[SIGNAL_PAYLOAD_MAX + 1];
  size_t n = serializeJson(doc, payload, sizeof(payload));
  if (n == 0 || n >= sizeof(payload)) return;
  _mqtt.publish(key, payload, true);
}

} // namespace mqtt_publish
