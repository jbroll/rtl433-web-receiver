#include <math.h>
#include <stdio.h>
#include <string.h>

#include "aht20.h"

static int failures = 0;

static void check(const char* what, bool ok) {
  printf("%-64s %s\n", what, ok ? "PASS" : "FAIL");
  if (!ok) failures++;
}

// Humidity raw 0x80000 (50%), temperature raw 0x60000 (25 C).
static void frameFor(uint8_t frame[7], uint8_t status) {
  const uint8_t body[6] = {status, 0x80, 0x00, 0x06, 0x00, 0x00};
  memcpy(frame, body, sizeof(body));
  frame[6] = aht20::crc8(frame, 6);
}

int main() {
  const uint8_t check_input[] = "123456789";
  check("crc8 matches the CRC-8/NRSC-5 check value 0xF7",
        aht20::crc8(check_input, 9) == 0xF7);

  uint8_t frame[7];
  float   t = 0, h = 0;
  frameFor(frame, 0x1C);
  check("a valid frame decodes", aht20::decode(frame, t, h));
  check("humidity raw 0x80000 is 50%", fabsf(h - 50.0f) < 0.001f);
  check("temperature raw 0x60000 is 25 C", fabsf(t - 25.0f) < 0.001f);

  frameFor(frame, 0x1C);
  frame[6] ^= 0x01;
  check("a frame with a bad CRC is rejected", !aht20::decode(frame, t, h));

  frameFor(frame, 0x9C);
  check("a frame with the busy bit set is rejected", !aht20::decode(frame, t, h));

  return failures ? 1 : 0;
}
