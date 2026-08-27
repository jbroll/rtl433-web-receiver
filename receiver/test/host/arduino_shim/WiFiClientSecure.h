#pragma once

#include <stdint.h>

#include "WiFiClient.h"

// Host stand-in for WiFiClientSecure: mqtt_publish.cpp calls setCACert(),
// setTimeout() and setHandshakeTimeout() once per TLS setupConnection(), and
// stop() on teardown. Records calls; a real TLS handshake never happens.
class WiFiClientSecure : public WiFiClient {
 public:
  void setCACert(const char* rootCA) { caCert = rootCA; }
  int  setTimeout(uint32_t seconds) {
    timeoutSeconds = seconds;
    return 1;
  }
  void setHandshakeTimeout(unsigned long seconds) { handshakeTimeoutSeconds = seconds; }
  // No real handshake ever runs here, so there is never an error to report.
  int lastError(char* buf, size_t size) {
    if (size > 0) buf[0] = '\0';
    return 0;
  }
  void resetForTest() {
    WiFiClient::resetForTest();
    caCert                  = nullptr;
    timeoutSeconds          = 0;
    handshakeTimeoutSeconds = 0;
  }

  const char*   caCert = nullptr;
  uint32_t      timeoutSeconds = 0;
  unsigned long handshakeTimeoutSeconds = 0;
};
