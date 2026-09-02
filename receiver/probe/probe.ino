// Radio bring-up probe: bit-banged SPI, no RadioLib, no mode changes.
// The SX1276 answers on CS=40 and reaches OOK continuous RX at 915 MHz.
// Remaining questions: which pin is DATA (DIO2) rather than Dclk (DIO1), and
// whether RESET is wired anywhere. Dclk follows the bitrate register; DATA
// does not, so sweeping the bitrate separates them.

#include <Arduino.h>

static const int PIN_MISO = 1;
static const int PIN_MOSI = 42;
static const int PIN_SCK = 41;
static const int PIN_CS = 40;

// Every GPIO the WROOM-1 leaves free, minus the SPI bus and UART0.
static const int PINS[] = {2,  3,  4,  5,  6,  7,  8,  9,  10, 11, 12,
                           13, 14, 15, 16, 17, 18, 21, 38, 39, 45, 46,
                           47, 48};
static const size_t PIN_N = sizeof(PINS) / sizeof(int);

static bool isBusPin(int pin) {
  return pin == PIN_MISO || pin == PIN_MOSI || pin == PIN_SCK || pin == PIN_CS;
}

static void busIdle() {
  pinMode(PIN_SCK, OUTPUT);
  pinMode(PIN_MOSI, OUTPUT);
  pinMode(PIN_MISO, INPUT);
  pinMode(PIN_CS, OUTPUT);
  digitalWrite(PIN_CS, HIGH);
  digitalWrite(PIN_SCK, LOW);
  digitalWrite(PIN_MOSI, LOW);
}

static uint8_t transferByte(uint8_t out) {
  uint8_t in = 0;
  for (int bit = 7; bit >= 0; bit--) {
    digitalWrite(PIN_MOSI, (out >> bit) & 1);
    delayMicroseconds(1);
    digitalWrite(PIN_SCK, HIGH);
    delayMicroseconds(1);
    in = (in << 1) | (digitalRead(PIN_MISO) ? 1 : 0);
    digitalWrite(PIN_SCK, LOW);
    delayMicroseconds(1);
  }
  return in;
}

static uint8_t readReg(uint8_t addr) {
  digitalWrite(PIN_CS, LOW);
  delayMicroseconds(2);
  transferByte(addr & 0x7f);
  uint8_t value = transferByte(0x00);
  delayMicroseconds(2);
  digitalWrite(PIN_CS, HIGH);
  delayMicroseconds(5);
  return value;
}

static void writeReg(uint8_t addr, uint8_t value) {
  digitalWrite(PIN_CS, LOW);
  delayMicroseconds(2);
  transferByte(addr | 0x80);
  transferByte(value);
  delayMicroseconds(2);
  digitalWrite(PIN_CS, HIGH);
  delayMicroseconds(5);
}

static void setFrequency(double mhz) {
  uint32_t frf = (uint32_t)((mhz * 1000000.0) / (32000000.0 / 524288.0) + 0.5);
  writeReg(0x06, (frf >> 16) & 0xff);
  writeReg(0x07, (frf >> 8) & 0xff);
  writeReg(0x08, frf & 0xff);
}

static void setBitrate(uint32_t bps) {
  uint32_t value = 32000000UL / bps;
  writeReg(0x02, (value >> 8) & 0xff);
  writeReg(0x03, value & 0xff);
}

static void startOokRx(double mhz, bool bitSync) {
  writeReg(0x01, 0x20);
  delay(10);
  setFrequency(mhz);
  writeReg(0x12, 0x01);              // RxBw 250 kHz
  writeReg(0x0c, 0x23);              // LNA max gain, HF boost
  writeReg(0x14, bitSync ? 0x28 : 0x08);  // OOK peak threshold, bit sync on/off
  writeReg(0x31, 0x00);              // continuous mode
  writeReg(0x40, 0x00);
  writeReg(0x01, 0x25);              // OOK, high band, RX continuous
  delay(20);
}

// Returns the edge count over 200 ms sampled at 20 kHz.
static int countEdges(int pin, int *highOut) {
  pinMode(pin, INPUT);
  int high = 0;
  int edges = 0;
  int last = digitalRead(pin);
  for (int s = 0; s < 4000; s++) {
    int now = digitalRead(pin);
    high += now;
    if (now != last) {
      edges++;
    }
    last = now;
    delayMicroseconds(50);
  }
  if (highOut) {
    *highOut = high;
  }
  return edges;
}

static void sweepPins(const char *label) {
  Serial0.printf("\n-- %s --\n", label);
  for (size_t i = 0; i < PIN_N; i++) {
    if (isBusPin(PINS[i])) {
      continue;
    }
    int high = 0;
    int edges = countEdges(PINS[i], &high);
    if (edges > 0 || (high > 0 && high < 4000)) {
      Serial0.printf("  GPIO %-2d  high %4d/4000  edges %d\n", PINS[i], high,
                     edges);
    }
  }
}

static void findReset() {
  Serial0.println("\n-- reset line search over every free GPIO --");
  bool found = false;
  for (size_t i = 0; i < PIN_N; i++) {
    int pin = PINS[i];
    if (isBusPin(pin)) {
      continue;
    }
    busIdle();
    writeReg(0x28, 0xa5);
    if (readReg(0x28) != 0xa5) {
      Serial0.printf("  GPIO %-2d  scratch write failed, skipped\n", pin);
      continue;
    }
    pinMode(pin, OUTPUT);
    digitalWrite(pin, LOW);
    delay(2);
    pinMode(pin, INPUT);
    delay(20);
    busIdle();
    uint8_t after = readReg(0x28);
    if (after != 0xa5) {
      Serial0.printf("  GPIO %-2d  0x28 -> 0x%02x  <== RESET (active low)\n",
                     pin, after);
      found = true;
    }
  }
  if (!found) {
    Serial0.println("  no GPIO resets the part: RESET is not wired");
  }
  busIdle();
}

void setup() {
  Serial0.begin(115200);
  delay(1500);
  Serial0.println();
  Serial0.println("=== SX1276 probe on CS=40 ===");
  busIdle();
  Serial0.printf("RegVersion (0x42) = 0x%02x\n", readReg(0x42));

  findReset();

  startOokRx(915.0, false);
  Serial0.printf("\nOOK RX, bit sync OFF: RegOpMode=0x%02x IrqFlags1=0x%02x\n",
                 readReg(0x01), readReg(0x3e));
  sweepPins("bit sync OFF (no Dclk); only DATA should toggle");

  startOokRx(915.0, true);
  setBitrate(4800);
  Serial0.printf("\nOOK RX, bit sync ON, bitrate 4800: RegBitrate=%02x %02x\n",
                 readReg(0x02), readReg(0x03));
  sweepPins("bit sync ON at 4800 bps");

  setBitrate(1200);
  delay(20);
  Serial0.printf("\nbitrate 1200: RegBitrate=%02x %02x\n", readReg(0x02),
                 readReg(0x03));
  sweepPins("bit sync ON at 1200 bps -- a Dclk pin's edge count drops 4x");

  Serial0.println("\n=== probe complete ===");
}

void loop() {
  delay(10000);
}
