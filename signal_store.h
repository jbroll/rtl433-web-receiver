#pragma once

#include <Arduino.h>

// The rtl_433 message plus the time, rssi and count record() stamps into it. The
// library's own buffer is 512 bytes and the three fields cost about 56.
#define SIGNAL_PAYLOAD_MAX  600
#define SIGNAL_DEVICE_SLOTS 24
// A 14 byte source, a 64 byte model, and a 16 byte id.
#define SIGNAL_KEY_MAX      96
#define SIGNAL_MODEL_MAX    64
#define SIGNAL_SOURCE_MAX   32

struct DeviceSlot {
  char          key[SIGNAL_KEY_MAX];
  char          payload[SIGNAL_PAYLOAD_MAX + 1];
  unsigned long lastSeen;
  uint32_t      count;
  bool          used;
};

namespace signal_store {
void reset();
// The first segment of every key. mdnsHostname() supplies it once WiFi is up.
void        setSource(const char* source);
const char* source();
// isDecode false records the receiver's own telemetry: it takes a device slot
// like any other, but stays out of the decode count.
bool              record(const char* payload, int rssi, bool isDecode = true);
uint8_t           deviceCount();
const DeviceSlot& device(uint8_t i);
// Raw table index rather than recency order, so a cursor over it does not skip
// or repeat a slot when a device is heard from mid-walk.
const DeviceSlot* slotAt(uint8_t i);
void              sweepStale(unsigned long now, unsigned long staleMs);
uint32_t          totalRecorded();
uint32_t          droppedCount();
#ifdef FAKE_SIGNALS
bool selfTest();
#endif
} // namespace signal_store
