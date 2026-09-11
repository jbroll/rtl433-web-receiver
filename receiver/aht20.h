#pragma once

#include <stddef.h>
#include <stdint.h>

// The frame decode is header-only with no Arduino header so test/host/run.sh
// can check it; aht20.cpp is the Wire half.
namespace aht20 {

constexpr uint8_t ADDR = 0x38;

// CRC-8, polynomial 0x31, initial value 0xFF (AHT20 datasheet section 5.4).
inline uint8_t crc8(const uint8_t* data, size_t len) {
  uint8_t crc = 0xFF;
  for (size_t i = 0; i < len; i++) {
    crc ^= data[i];
    for (int bit = 0; bit < 8; bit++) {
      crc = (crc & 0x80) ? (uint8_t)((crc << 1) ^ 0x31) : (uint8_t)(crc << 1);
    }
  }
  return crc;
}

// A measurement frame is status, 20-bit humidity, 20-bit temperature, CRC.
inline bool decode(const uint8_t frame[7], float& temperatureC, float& humidity) {
  if ((frame[0] & 0x80) || crc8(frame, 6) != frame[6]) {
    return false;
  }
  uint32_t h = ((uint32_t)frame[1] << 12) | ((uint32_t)frame[2] << 4) | (frame[3] >> 4);
  uint32_t t = ((uint32_t)(frame[3] & 0x0F) << 16) | ((uint32_t)frame[4] << 8) | frame[5];
  humidity     = (float)h * 100.0f / 1048576.0f;
  temperatureC = (float)t * 200.0f / 1048576.0f - 50.0f;
  return true;
}

bool begin();
bool read(float& temperatureC, float& humidity);

} // namespace aht20
