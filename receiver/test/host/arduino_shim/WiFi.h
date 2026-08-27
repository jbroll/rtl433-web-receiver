#pragma once

// Host stand-in for WiFi.h: mqtt_publish::loop() only reads WiFi.status(),
// gated by a test-settable value instead of a real radio.
enum wl_status_t { WL_DISCONNECTED = 0, WL_CONNECTED = 3 };

class WiFiClass {
 public:
  wl_status_t status() { return _status; }
  void        setStatusForTest(wl_status_t s) { _status = s; }

 private:
  wl_status_t _status = WL_CONNECTED;
};

inline WiFiClass WiFi;
