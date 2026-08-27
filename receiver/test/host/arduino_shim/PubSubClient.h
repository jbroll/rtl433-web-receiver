#pragma once

#include <stdint.h>
#include <string.h>

#include <string>

#include "WiFiClient.h"

#ifndef MQTT_MAX_PACKET_SIZE
#define MQTT_MAX_PACKET_SIZE 256
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
    lastBufferSize = size;
    // teardown() also calls setBufferSize, shrinking back to the idle size;
    // only a growth call is what a real allocator could fail, so only that
    // consumes the flag, else an unrelated slot's teardown could eat it
    // before setupConnection() ever gets to the call under test.
    if (failNextSetBufferSize && size > 128) {
      failNextSetBufferSize = false;
      return false;
    }
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
    _connected = false;
  }
  bool loop() {
    loopCalls++;
    return _connected;
  }
  bool publish(const char* topic, const char* payload, bool retained = true) {
    (void)retained;
    publishCalls++;
    // The caller's topic/payload buffers are typically stack locals, gone by
    // the time a test reads these back, so copy rather than keep a pointer.
    _lastPublishTopic   = topic ? topic : "";
    _lastPublishPayload = payload ? payload : "";
    lastPublishTopic    = _lastPublishTopic.c_str();
    lastPublishPayload  = _lastPublishPayload.c_str();
    return _connected;
  }
  bool connected() { return _connected; }
  int  state() { return _connected ? 0 : -2; }

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
    connectCalls++;
    _connected = willConnectForTest;
    return _connected;
  }
  bool        _connected = false;
  std::string _lastPublishTopic;
  std::string _lastPublishPayload;
};

inline bool PubSubClient::failNextSetBufferSize = false;
