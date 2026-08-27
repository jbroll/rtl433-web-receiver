#pragma once

#include <stdint.h>
#include <string.h>

#include <string>

#include "WiFiClient.h"

#ifndef MQTT_MAX_PACKET_SIZE
#define MQTT_MAX_PACKET_SIZE 256
#endif

// Matches PubSubClient.h's own #define; mqtt_publish.cpp's identical
// #define (mqtt_publish.cpp:108) is a no-op redefinition since the values
// agree.
#ifndef MQTT_PUBLISH_IDLE_BUFFER_SIZE
#define MQTT_PUBLISH_IDLE_BUFFER_SIZE 128
#endif

// From PubSubClient.h: room reserved at the front of the buffer for the
// fixed header, ahead of the topic/payload publish() writes.
#ifndef MQTT_MAX_HEADER_SIZE
#define MQTT_MAX_HEADER_SIZE 5
#endif

// Host stand-in for PubSubClient: records every call mqtt_publish.cpp makes
// instead of touching a socket. connect()'s outcome and setBufferSize()'s
// failure are test-settable, since those are the two paths a host test can't
// otherwise reach (no broker to actually accept or refuse a connection, and
// no way to make malloc fail on demand).
class PubSubClient {
 public:
  // One-shot: consumed by the next setBufferSize() call, matching how a real
  // allocator would fail once and let a later smaller/retried call succeed.
  static bool failNextSetBufferSize;

  bool setBufferSize(uint16_t size) {
    // teardown() also calls setBufferSize, shrinking back to the idle size;
    // only a growth call is what a real allocator could fail, so only that
    // consumes the flag, else an unrelated slot's teardown could eat it
    // before setupConnection() ever gets to the call under test.
    if (failNextSetBufferSize && size > MQTT_PUBLISH_IDLE_BUFFER_SIZE) {
      failNextSetBufferSize = false;
      return false;
    }
    // Only recorded on success, matching the real library's bufferSize field:
    // a failed resize leaves the previous allocation (and its size) in place.
    lastBufferSize = size;
    return true;
  }
  PubSubClient& setClient(WiFiClient& c) {
    client = &c;
    return *this;
  }
  PubSubClient& setServer(const char* domain, uint16_t port) {
    server     = domain;
    serverPort = port;
    setServerCalls++;
    return *this;
  }
  PubSubClient& setSocketTimeout(uint16_t timeout) {
    socketTimeout = timeout;
    return *this;
  }

  bool connect(const char* id) { return connectImpl(id); }
  bool connect(const char* id, const char* user, const char* pass) {
    (void)user;
    (void)pass;
    return connectImpl(id);
  }
  void disconnect() {
    disconnectCalls++;
    // Real disconnect() dereferences _client to write the DISCONNECT packet
    // and stop() it; connected() (and so mqtt_publish.cpp's only caller of
    // disconnect()) already requires a client, but guard here too rather
    // than assume that invariant holds for every future caller.
    if (client != nullptr) client->stop();
    _connected = false;
  }
  bool loop() {
    loopCalls++;
    return _connected;
  }
  bool publish(const char* topic, const char* payload, bool retained = true) {
    (void)retained;
    publishCalls++;
    if (!connected()) return false;
    // Same length test as PubSubClient::publish: too little buffer for the
    // header, topic length prefix, topic, and payload sends nothing.
    size_t topicLen = topic ? strlen(topic) : 0;
    size_t plength  = payload ? strlen(payload) : 0;
    if (lastBufferSize < MQTT_MAX_HEADER_SIZE + 2 + topicLen + plength) return false;
    // The caller's topic/payload buffers are typically stack locals, gone by
    // the time a test reads these back, so copy rather than keep a pointer.
    _lastPublishTopic   = topic ? topic : "";
    _lastPublishPayload = payload ? payload : "";
    lastPublishTopic    = _lastPublishTopic.c_str();
    lastPublishPayload  = _lastPublishPayload.c_str();
    return true;
  }
  bool connected() { return client != nullptr && _connected; }
  int  state() { return connected() ? 0 : -2; }

  // Test-only: simulate a live connection without a real handshake, or set
  // whether the next connect() call succeeds.
  void setConnectedForTest(bool c) { _connected = c; }
  bool willConnectForTest = true;

  const char* server         = nullptr;
  uint16_t    serverPort     = 0;
  uint16_t    socketTimeout  = 0;
  uint16_t    lastBufferSize = 0;
  WiFiClient* client         = nullptr;
  int         connectCalls    = 0;
  int         disconnectCalls = 0;
  int         loopCalls       = 0;
  int         publishCalls    = 0;
  int         setServerCalls  = 0;
  const char* lastPublishTopic   = nullptr;
  const char* lastPublishPayload = nullptr;

  // Test-only: wipe bookkeeping between scenarios that reuse the same
  // physical slot for an unrelated broker, so call counts start at zero.
  void resetForTest() {
    server = nullptr;
    serverPort = socketTimeout = lastBufferSize = 0;
    connectCalls = disconnectCalls = loopCalls = publishCalls = setServerCalls = 0;
    _lastPublishTopic.clear();
    _lastPublishPayload.clear();
    lastPublishTopic = lastPublishPayload = nullptr;
    client         = nullptr;
    _connected     = false;
    willConnectForTest = true;
  }

 private:
  bool connectImpl(const char* id) {
    (void)id;
    // Real connect() dereferences _client unconditionally; a slot that
    // bailed out of setupConnection() before setClient() never reaches a
    // real connect() call in production, so treat it as a call that can't
    // succeed rather than crash.
    if (client == nullptr) return false;
    connectCalls++;
    _connected = willConnectForTest;
    return _connected;
  }
  bool        _connected = false;
  std::string _lastPublishTopic;
  std::string _lastPublishPayload;
};

inline bool PubSubClient::failNextSetBufferSize = false;
