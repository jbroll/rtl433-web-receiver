#pragma once

#include <Arduino.h>

// A real rtl_433 message carries model, readings, protocol name, rssi and
// duration; the Acurite 5n1's runs past 200 bytes and must not be cut, or it
// stops being parseable JSON.
#define SIGNAL_PAYLOAD_MAX  512
#define SIGNAL_DEVICE_SLOTS 24
#define SIGNAL_EVENT_SLOTS  40
#define SIGNAL_KEY_MAX      48
#define SIGNAL_MODEL_MAX    32

struct DeviceSlot {
  char          key[SIGNAL_KEY_MAX];
  char          model[SIGNAL_MODEL_MAX];
  char          payload[SIGNAL_PAYLOAD_MAX + 1];
  int           rssi;
  unsigned long lastSeen;
  uint32_t      count;
  bool          used;
};

struct SignalEvent {
  char          payload[SIGNAL_PAYLOAD_MAX + 1];
  unsigned long at;
};

namespace signal_store {
void               reset();
// isDecode false records the receiver's own telemetry: it takes a device slot
// like any other, but stays out of the raw log and the decode count.
bool               record(const char* payload, int rssi, bool isDecode = true);
uint8_t            deviceCount();
const DeviceSlot&  device(uint8_t i);
uint8_t            eventCount();
const SignalEvent& event(uint8_t i);
void               sweepStale(unsigned long now, unsigned long staleMs);
uint32_t           totalRecorded();
uint32_t           droppedCount();
#ifdef FAKE_SIGNALS
bool selfTest();
#endif
} // namespace signal_store
