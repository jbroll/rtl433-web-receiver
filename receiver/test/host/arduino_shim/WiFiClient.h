#pragma once

// Host stand-in for WiFiClient: mqtt_publish.cpp only ever calls stop() on
// it, to tear a connection down. Records that a real socket would have been.
class WiFiClient {
 public:
  void stop() { stopCalls++; }
  void resetForTest() { stopCalls = 0; }
  int  stopCalls = 0;
};
