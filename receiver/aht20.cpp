#include "aht20.h"

#include <Arduino.h>
#include <Wire.h>

namespace aht20 {

static const uint8_t STATUS_BUSY       = 0x80;
static const uint8_t STATUS_CALIBRATED = 0x08;

static bool status(uint8_t& s) {
  if (Wire.requestFrom(ADDR, (uint8_t)1) != 1) {
    return false;
  }
  s = Wire.read();
  return true;
}

static bool command(uint8_t cmd, uint8_t arg0, uint8_t arg1) {
  Wire.beginTransmission(ADDR);
  Wire.write(cmd);
  Wire.write(arg0);
  Wire.write(arg1);
  return Wire.endTransmission() == 0;
}

// The datasheet's init command (0xBE) is only needed when the calibrated bit
// is clear; a factory-calibrated part reports it set from power-on.
bool begin() {
  uint8_t s;
  if (!status(s)) {
    return false;
  }
  if (s & STATUS_CALIBRATED) {
    return true;
  }
  if (!command(0xBE, 0x08, 0x00)) {
    return false;
  }
  delay(10);
  return status(s) && (s & STATUS_CALIBRATED);
}

// A measurement takes 80 ms per the datasheet; the busy bit covers a slow one.
bool read(float& temperatureC, float& humidity) {
  if (!command(0xAC, 0x33, 0x00)) {
    return false;
  }
  delay(80);
  uint8_t frame[7];
  for (int tries = 0; tries < 5; tries++) {
    if (Wire.requestFrom(ADDR, (uint8_t)sizeof(frame)) != sizeof(frame)) {
      return false;
    }
    for (uint8_t& b : frame) {
      b = Wire.read();
    }
    if (!(frame[0] & STATUS_BUSY)) {
      return decode(frame, temperatureC, humidity);
    }
    delay(10);
  }
  return false;
}

} // namespace aht20
