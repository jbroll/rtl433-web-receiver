#include "mqtt_publish.h"

#include <ArduinoLog.h>
#include <PubSubClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <string.h>
#include <stdlib.h>

#include "alias_store.h"
#include "layout_store.h"
#include "location_store.h"
#include "units_store.h"
#include "json_string.h"
#include "mqtt_publish_store.h"
#include "signal_store.h"
#include "tz_store.h"

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

// One entry per active connection: up to MQTT_PUBLISH_SLOTS dashboard-added
// bridges plus the build-flag default. A fixed array, not a dynamic list, so
// PubSubClient::setClient()'s stored reference to plainClient/secureClient
// never dangles across a begin() rebuild.
#define MQTT_PUBLISH_MAX_CONNECTIONS (MQTT_PUBLISH_SLOTS + 1)

// PubSubClient's default constructor mallocs MQTT_MAX_PACKET_SIZE
// immediately; every unused slot sits at this size instead until
// setupConnection() grows it for a broker actually in use.
#define MQTT_PUBLISH_IDLE_BUFFER_SIZE 128

struct Connection {
  WiFiClient       plainClient;
  WiFiClientSecure secureClient;
  PubSubClient     mqtt;
  ParsedBroker     broker;
  char             url[MQTT_PUBLISH_STORE_URL_MAX] = "";
  char             token[MQTT_PUBLISH_STORE_TOKEN_MAX] = "";
  const char*      reason = nullptr;
  bool             enabled = false;
  unsigned long    lastAttempt = 0;

  Connection() { mqtt.setBufferSize(MQTT_PUBLISH_IDLE_BUFFER_SIZE); }
};

static Connection _conn[MQTT_PUBLISH_MAX_CONNECTIONS];
static uint8_t    _slotOrder[MQTT_PUBLISH_MAX_CONNECTIONS];
static uint8_t    _connCount = 0;
static char       _clientId[64] = "";

static void setupConnection(Connection& c, const char* url, const char* token) {
  strncpy(c.url, url, sizeof(c.url) - 1);
  c.url[sizeof(c.url) - 1] = '\0';
  c.broker = parseBrokerUrl(url);
  if (!c.broker.valid) {
    Log.warning(F("mqtt publish: broker URL \"%s\" is not a valid mqtt(s)://host:port, skipped" CR), url);
    c.enabled = false;
    c.reason  = "invalid mqtt(s)://host:port url";
    return;
  }
  strncpy(c.token, token ? token : "", sizeof(c.token) - 1);
  c.token[sizeof(c.token) - 1] = '\0';
  c.reason = nullptr;

  // Grown here, before enabled is set, so nothing can connect through this
  // slot while it still holds the idle-sized buffer.
  if (!c.mqtt.setBufferSize(MQTT_MAX_PACKET_SIZE)) {
    Log.warning(F("mqtt publish: buffer alloc for %s failed, out of memory, skipped" CR), url);
    c.enabled = false;
    c.reason  = "out of memory growing publish buffer";
    return;
  }

  if (c.broker.tls) {
    c.secureClient.setCACert(ISRG_ROOT_X1);
    c.secureClient.setTimeout(5);
    c.secureClient.setHandshakeTimeout(5);
    c.mqtt.setClient(c.secureClient);
  } else {
    c.mqtt.setClient(c.plainClient);
  }
  c.mqtt.setServer(c.broker.host, c.broker.port);
  // A dead broker must not stall loop(), and with it rf.loop(), for the 15 s
  // PubSubClient default.
  c.mqtt.setSocketTimeout(5);
  c.enabled = true;
  c.lastAttempt = millis() - MQTT_RECONNECT_BACKOFF_MS;
  Log.notice(F("mqtt publish: enabled, broker %s:%u (%s)" CR),
             c.broker.host, c.broker.port, c.broker.tls ? "TLS" : "plain");
}

// A Print sink over a fixed buffer for json_string::writeJsonString, which
// needs a Print& and would otherwise have to allocate a JsonDocument just to
// escape one string.
class BufferPrint : public Print {
 public:
  BufferPrint(char* buf, size_t cap) : _buf(buf), _cap(cap) { _buf[0] = '\0'; }
  size_t write(uint8_t b) override {
    if (_len + 1 >= _cap) { _overflow = true; return 0; }
    _buf[_len++] = (char)b;
    _buf[_len] = '\0';
    return 1;
  }
  size_t length() const { return _len; }
  bool   overflowed() const { return _overflow; }

 private:
  char*  _buf;
  size_t _cap;
  size_t _len = 0;
  bool   _overflow = false;
};

static size_t aliasPayload(char* out, size_t outSize, const char* name) {
  BufferPrint bp(out, outSize);
  json_string::writeJsonString(bp, name);
  return !bp.overflowed() && bp.length() > 0 ? bp.length() : 0;
}

static void replayAll(Connection& c) {
  uint8_t sent = 0;
  for (uint8_t i = 0; i < SIGNAL_DEVICE_SLOTS; i++) {
    const DeviceSlot* slot = signal_store::slotAt(i);
    if (slot == nullptr) continue;
    const char* payload = signal_store::latestPayload(*slot);
    if (payload == nullptr) continue;
    if (c.mqtt.publish(slot->key, payload, true)) sent++;
  }
  const char* layout = layout_store::get();
  if (layout[0] != '\0') {
    char topic[80];
    int  n = snprintf(topic, sizeof(topic), "%s/$layout", _clientId);
    if (n > 0 && (size_t)n < sizeof(topic) && c.mqtt.publish(topic, layout, true)) sent++;
  }
  const char* location = location_store::get();
  if (location[0] != '\0') {
    char topic[80];
    int  n = snprintf(topic, sizeof(topic), "%s/$location", _clientId);
    if (n > 0 && (size_t)n < sizeof(topic) && c.mqtt.publish(topic, location, true)) sent++;
  }
  const char* units = units_store::get();
  if (units[0] != '\0') {
    char topic[80];
    int  n = snprintf(topic, sizeof(topic), "%s/$units", _clientId);
    if (n > 0 && (size_t)n < sizeof(topic) && c.mqtt.publish(topic, units, true)) sent++;
  }
  for (uint8_t i = 0; i < ALIAS_SLOTS; i++) {
    const char* topic = alias_store::topicAt(i);
    const char* name  = alias_store::nameAt(i);
    if (topic == nullptr || name == nullptr || name[0] == '\0') continue;
    char   payload[ALIAS_PAYLOAD_MAX];
    size_t pn = aliasPayload(payload, sizeof(payload), name);
    if (pn > 0 && c.mqtt.publish(topic, payload, true)) sent++;
  }
  {
    char payload[8];
    int  pn = snprintf(payload, sizeof(payload), "%d", tz_store::offsetMinutes());
    if (pn > 0 && (size_t)pn < sizeof(payload)) {
      char topic[80];
      int  n = snprintf(topic, sizeof(topic), "%s/$tz", _clientId);
      if (n > 0 && (size_t)n < sizeof(topic) && c.mqtt.publish(topic, payload, true)) sent++;
    }
  }
  Log.notice(F("mqtt publish: replayed %d retained record(s) to %s on connect" CR), sent, c.broker.host);
}

static bool connectOnce(Connection& c) {
  if (millis() - c.lastAttempt < MQTT_RECONNECT_BACKOFF_MS) return false;
  c.lastAttempt = millis();
  bool ok = c.token[0] != '\0'
                ? c.mqtt.connect(_clientId, "", c.token)
                : c.mqtt.connect(_clientId);
  if (ok) {
    Log.notice(F("mqtt publish: connected to %s:%u" CR), c.broker.host, c.broker.port);
    replayAll(c);
  } else {
    Log.warning(F("mqtt publish: connect to %s:%u failed, state=%d" CR),
                c.broker.host, c.broker.port, c.mqtt.state());
    // state() alone can't distinguish a bad CA/handshake from a broker that
    // just refused the connection; only WiFiClientSecure knows which.
    if (c.broker.tls) {
      char tlsErr[128];
      if (c.secureClient.lastError(tlsErr, sizeof(tlsErr)) != 0) {
        Log.warning(F("mqtt publish: TLS error: %s" CR), tlsErr);
      }
    }
  }
  return ok;
}

static void teardown(Connection& c) {
  if (c.mqtt.connected()) {
    c.mqtt.disconnect();
  }
  c.plainClient.stop();
  c.secureClient.stop();
  // Return ignored: a failed shrink (realloc returning NULL) leaves the
  // prior, larger buffer in place rather than freeing it, so this slot just
  // costs more idle heap than architecture.md's "a few hundred bytes"
  // until the next successful setBufferSize() call, not a leak or a crash.
  c.mqtt.setBufferSize(MQTT_PUBLISH_IDLE_BUFFER_SIZE);
  c.enabled  = false;
  c.reason   = nullptr;
  c.url[0]   = '\0';
  c.token[0] = '\0';
}

void begin(const char* clientId) {
  strncpy(_clientId, clientId, sizeof(_clientId) - 1);
  _clientId[sizeof(_clientId) - 1] = '\0';

  // The wanted table: dashboard slots in store order, then the build-flag
  // default. Collected before touching _conn so the match below compares
  // against a stable snapshot.
  const char* wantUrl[MQTT_PUBLISH_MAX_CONNECTIONS];
  const char* wantToken[MQTT_PUBLISH_MAX_CONNECTIONS];
  uint8_t     wantCount = 0;
  for (uint8_t i = 0; i < MQTT_PUBLISH_SLOTS; i++) {
    const char* url = mqtt_publish_store::urlAt(i);
    if (url == nullptr) continue;
    wantUrl[wantCount]   = url;
    wantToken[wantCount] = mqtt_publish_store::tokenAt(i);
    wantCount++;
  }
#ifdef MQTT_BROKER_URL
  wantUrl[wantCount] = MQTT_BROKER_URL;
  wantToken[wantCount] =
#ifdef MQTT_TOKEN
      MQTT_TOKEN;
#else
      "";
#endif
  wantCount++;
#endif

  // Match each wanted entry against a live slot with the same url, token and
  // TLS flag (TLS is derived from the url, so this is the same comparison
  // twice, but explicit rather than assumed). A dashboard add or remove
  // reshuffles which index used to serve which broker, so matching by index
  // instead of by this triple is what would leave a stale connection
  // publishing to a broker the table no longer names.
  bool    claimed[MQTT_PUBLISH_MAX_CONNECTIONS] = {false};
  uint8_t assignedSlot[MQTT_PUBLISH_MAX_CONNECTIONS];
  for (uint8_t w = 0; w < wantCount; w++) {
    const char* token = wantToken[w] ? wantToken[w] : "";
    ParsedBroker wantBroker = parseBrokerUrl(wantUrl[w]);
    assignedSlot[w] = MQTT_PUBLISH_MAX_CONNECTIONS;
    for (uint8_t s = 0; s < MQTT_PUBLISH_MAX_CONNECTIONS; s++) {
      if (claimed[s]) continue;
      Connection& c = _conn[s];
      if (c.enabled && strcmp(c.url, wantUrl[w]) == 0 && strcmp(c.token, token) == 0 &&
          c.broker.tls == wantBroker.tls) {
        claimed[s]      = true;
        assignedSlot[w] = s;
        break;
      }
    }
  }

  // Tear down every live slot not kept for a still-wanted broker.
  for (uint8_t s = 0; s < MQTT_PUBLISH_MAX_CONNECTIONS; s++) {
    if (!claimed[s]) teardown(_conn[s]);
  }

  // Set up the wanted entries that found no match, into the slots freed above.
  for (uint8_t w = 0; w < wantCount; w++) {
    if (assignedSlot[w] != MQTT_PUBLISH_MAX_CONNECTIONS) continue;
    for (uint8_t s = 0; s < MQTT_PUBLISH_MAX_CONNECTIONS; s++) {
      if (claimed[s]) continue;
      claimed[s]      = true;
      assignedSlot[w] = s;
      setupConnection(_conn[s], wantUrl[w], wantToken[w]);
      break;
    }
  }

  // assignedSlot[w] can only be the MQTT_PUBLISH_MAX_CONNECTIONS sentinel
  // (unassigned) if wantCount exceeds the slot count, which the invariant
  // above rules out; skip it rather than trust that invariant here, so a
  // future change can't make this read _conn[MQTT_PUBLISH_MAX_CONNECTIONS].
  uint8_t orderCount = 0;
  for (uint8_t w = 0; w < wantCount; w++) {
    if (assignedSlot[w] == MQTT_PUBLISH_MAX_CONNECTIONS) continue;
    _slotOrder[orderCount++] = assignedSlot[w];
  }
  _connCount = orderCount;
  if (_connCount == 0) {
    Log.notice(F("mqtt publish: no broker configured, disabled" CR));
  }
}

void loop() {
  if (_connCount == 0) return;
  if (WiFi.status() != WL_CONNECTED) return;
  for (uint8_t i = 0; i < _connCount; i++) {
    Connection& c = _conn[_slotOrder[i]];
    if (!c.enabled) continue;
    if (!c.mqtt.connected()) {
      connectOnce(c);
      continue;
    }
    c.mqtt.loop();
  }
}

void onRecord(const char* key, JsonDocument& doc) {
  if (_connCount == 0) return;
  char   payload[SIGNAL_PAYLOAD_MAX + 1];
  size_t n = serializeJson(doc, payload, sizeof(payload));
  if (n == 0 || n >= sizeof(payload)) return;
  for (uint8_t i = 0; i < _connCount; i++) {
    Connection& c = _conn[_slotOrder[i]];
    if (c.enabled && c.mqtt.connected()) c.mqtt.publish(key, payload, true);
  }
}

void publishLayout(const char* blob) {
  if (_connCount == 0) return;
  if (blob == nullptr || blob[0] == '\0') return;
  char topic[80];
  int  n = snprintf(topic, sizeof(topic), "%s/$layout", _clientId);
  if (n < 0 || (size_t)n >= sizeof(topic)) return;
  for (uint8_t i = 0; i < _connCount; i++) {
    Connection& c = _conn[_slotOrder[i]];
    if (c.enabled && c.mqtt.connected()) c.mqtt.publish(topic, blob, true);
  }
}

void publishLocation(const char* blob) {
  if (_connCount == 0) return;
  if (blob == nullptr || blob[0] == '\0') return;
  char topic[80];
  int  n = snprintf(topic, sizeof(topic), "%s/$location", _clientId);
  if (n < 0 || (size_t)n >= sizeof(topic)) return;
  for (uint8_t i = 0; i < _connCount; i++) {
    Connection& c = _conn[_slotOrder[i]];
    if (c.enabled && c.mqtt.connected()) c.mqtt.publish(topic, blob, true);
  }
}

void publishUnits(const char* blob) {
  if (_connCount == 0) return;
  if (blob == nullptr || blob[0] == '\0') return;
  char topic[80];
  int  n = snprintf(topic, sizeof(topic), "%s/$units", _clientId);
  if (n < 0 || (size_t)n >= sizeof(topic)) return;
  for (uint8_t i = 0; i < _connCount; i++) {
    Connection& c = _conn[_slotOrder[i]];
    if (c.enabled && c.mqtt.connected()) c.mqtt.publish(topic, blob, true);
  }
}

void publishAlias(const char* topic, const char* name) {
  if (_connCount == 0) return;
  if (topic == nullptr || topic[0] == '\0') return;
  char payload[ALIAS_PAYLOAD_MAX];
  // A cleared alias is a zero-length retained publish, the only thing that
  // drops the bridge's retained copy.
  payload[0] = '\0';
  if (name != nullptr && name[0] != '\0'
      && aliasPayload(payload, sizeof(payload), name) == 0) return;
  for (uint8_t i = 0; i < _connCount; i++) {
    Connection& c = _conn[_slotOrder[i]];
    if (c.enabled && c.mqtt.connected()) c.mqtt.publish(topic, payload, true);
  }
}

void publishTz(int16_t minutes) {
  if (_connCount == 0) return;
  char payload[8];
  int  pn = snprintf(payload, sizeof(payload), "%d", minutes);
  if (pn < 0 || (size_t)pn >= sizeof(payload)) return;
  char topic[80];
  int  n = snprintf(topic, sizeof(topic), "%s/$tz", _clientId);
  if (n < 0 || (size_t)n >= sizeof(topic)) return;
  for (uint8_t i = 0; i < _connCount; i++) {
    Connection& c = _conn[_slotOrder[i]];
    if (c.enabled && c.mqtt.connected()) c.mqtt.publish(topic, payload, true);
  }
}

uint8_t count() { return _connCount; }

const char* urlAt(uint8_t i) { return i < _connCount ? _conn[_slotOrder[i]].url : nullptr; }

bool connectedAt(uint8_t i) { return i < _connCount && _conn[_slotOrder[i]].mqtt.connected(); }

const char* reasonAt(uint8_t i) { return i < _connCount ? _conn[_slotOrder[i]].reason : nullptr; }

#ifdef FAKE_SIGNALS
bool enabledAt(uint8_t i) { return i < _connCount && _conn[_slotOrder[i]].enabled; }
PubSubClient&     mqttAt(uint8_t i) { return _conn[_slotOrder[i]].mqtt; }
WiFiClient&       plainClientAt(uint8_t i) { return _conn[_slotOrder[i]].plainClient; }
WiFiClientSecure& secureClientAt(uint8_t i) { return _conn[_slotOrder[i]].secureClient; }
uint8_t           maxConnections() { return MQTT_PUBLISH_MAX_CONNECTIONS; }
PubSubClient&     mqttRawAt(uint8_t i) { return _conn[i].mqtt; }
WiFiClient&       plainClientRawAt(uint8_t i) { return _conn[i].plainClient; }
WiFiClientSecure& secureClientRawAt(uint8_t i) { return _conn[i].secureClient; }
#endif

} // namespace mqtt_publish
