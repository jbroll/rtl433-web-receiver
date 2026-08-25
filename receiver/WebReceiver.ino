/*
 rtl_433_ESP receiver with a live web page.

 First boot (or after a long BOOT-button press) opens a SoftAP captive
 portal to collect WiFi credentials; see receiver/docs/install.md. Copying
 .env.example to .env is an optional dev/CI shortcut instead.
*/

#include <stdarg.h>

#include <ArduinoJson.h>
#include <ArduinoLog.h>
#include <ESPmDNS.h>
#include <WiFi.h>
#include <Wire.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <rtl_433_ESP.h>

#include <Adafruit_BMP280.h>

#include "alias_store.h"
#include "device_hooks.h"
#include "health_store.h"
#include "layout_store.h"
#include "location_store.h"
#include "units_store.h"
#include "mqtt_publish.h"
#include "mqtt_publish_store.h"
#include "ota_token_store.h"
#include "provisioning.h"
#include "radio_health.h"
#include "signal_store.h"
#include "tz_store.h"
#include "web_ui.h"
#include "wifi_store.h"
#include "esp_core_dump.h"  // esp_core_dump_image_check()
#include "esp_system.h"     // esp_reset_reason()

#ifndef MDNS_PREFIX
#  define MDNS_PREFIX "rtl433"
#endif

#ifndef RF_MODULE_FREQUENCY
#  define RF_MODULE_FREQUENCY 433.92
#endif

#ifndef DEVICE_STALE_HOURS
#define DEVICE_STALE_HOURS 72
#endif

#ifndef FAKE_RADIO_FAIL_MS
#define FAKE_RADIO_FAIL_MS 0 // FAKE_SIGNALS: pretend the radio is deaf after this long
#endif

#define JSON_MSG_BUFFER   512
#define WIFI_CONNECT_MS   20000
#define WIFI_BOOT_ATTEMPTS 5
#define WIFI_RETRY_MS     30000

#ifndef RECEIVER_TELEMETRY_MS
#define RECEIVER_TELEMETRY_MS 60000
#endif

// How long after a decode the radio is left alone. Signal gaps run to
// MINIMUM_SIGNAL_LENGTH, so a burst can still be in progress after one.
#define RECEIVER_QUIET_MS 500

// RadioLib returns the SX1231's temperature register negated and otherwise
// uncalibrated, which reads about 91 degrees high. The part is only specified
// to +/-5C anyway, so this tracks change rather than absolute temperature; to
// calibrate, set the flag to the reading it gives at a known ambient.
#ifndef RADIO_TEMP_OFFSET
#define RADIO_TEMP_OFFSET 91
#endif

#ifndef BUILD_ID
#  define BUILD_ID "dev"
#endif

// The library's radio object, file-scope in rtl_433_ESP.cpp and not exported by
// its header. Reaching it is what gets the SX1231's own temperature. The guard
// must match the library's: it defines the same name as an SX1231, CC1101 or
// SX127x under sibling guards, and a mismatched extern would link and misbehave.
#ifdef RF_RF69
extern RF69 radio;
#  define RADIO_TEMP_TRIES 20 // ~20ms; the measurement itself takes microseconds
#endif

char messageBuffer[JSON_MSG_BUFFER];

rtl_433_ESP rf;

// rtl_433_Callback runs on rtl_433_DecoderTask (core 1), not the loop task;
// signal_store and web_ui are only safe to touch from loop(), so the callback
// only hands the payload off through this queue.
#define RTL433_QUEUE_LEN 8

// Carries the whole message, not a SIGNAL_PAYLOAD_MAX-truncated copy: the
// store drops an over-long message rather than truncating it, and truncated
// JSON would fail to parse at all.
struct SignalQueueItem {
  char payload[JSON_MSG_BUFFER];
  int  rssi;
};

static QueueHandle_t rtl433Queue         = nullptr;
static uint32_t      rtl433QueueDropped  = 0;
// Written from the decoder task, read from loop(); a stale read only delays a
// telemetry sample by a minute.
static volatile unsigned long lastDecodeAt = 0;
static radio_health::HealthState healthState;
static bool                      bootCoredumpPending = false;
static bool                      bootUtcStamped = false;
static bool                      bmp280_ok = false;
static uint8_t                   bmp280_addr = 0;
static Adafruit_BMP280           bmp280;

bool wifiReady() {
  return WiFi.status() == WL_CONNECTED;
}

static bool wifiWasConnected = false;

// Suffixed with the low three MAC bytes so several boards can share a network.
static const char* mdnsHostname() {
  static char host[64] = "";
  if (host[0] == '\0') {
    uint8_t mac[6];
    WiFi.macAddress(mac);
    snprintf(host, sizeof(host), "%s-%02x%02x%02x", MDNS_PREFIX, mac[3], mac[4], mac[5]);
  }
  return host;
}

// The device has no RTC, so record() gets its timestamp from SNTP. Resynced on
// each reconnect; until the first sync a message carries no time at all.
static void startTime() {
  configTime(0, 0, "pool.ntp.org");
}

static void startMDNS() {
  MDNS.end(); // a second begin() without this fails to re-add the http service
  if (MDNS.begin(mdnsHostname())) {
    MDNS.addService("http", "tcp", 80);
    Log.notice(F("mDNS started: %s.local" CR), mdnsHostname());
  } else {
    Log.warning(F("mDNS start failed" CR));
  }
}

// Set by connectWiFi() and re-used by serviceWiFi()'s reconnect loop, since
// the active credentials can come from wifi_store or the .env macros.
static char _activeSsid[WIFI_STORE_SSID_MAX] = "";
static char _activePass[WIFI_STORE_PASS_MAX] = "";

static void connectWiFi(const char* ssid, const char* pass) {
  strncpy(_activeSsid, ssid, sizeof(_activeSsid) - 1);
  _activeSsid[sizeof(_activeSsid) - 1] = '\0';
  strncpy(_activePass, pass, sizeof(_activePass) - 1);
  _activePass[sizeof(_activePass) - 1] = '\0';

  Log.notice(F("WiFi connecting to %s" CR), _activeSsid);
  WiFi.mode(WIFI_STA);
  WiFi.begin(_activeSsid, _activePass);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < WIFI_CONNECT_MS) {
    delay(200);
  }
  if (wifiReady()) {
    Log.notice(F("WiFi connected: %s" CR), WiFi.localIP().toString().c_str());
    startMDNS();
    startTime();
    signal_store::setSource(mdnsHostname());
    wifiWasConnected = true;
  } else {
    Log.warning(F("WiFi connect failed" CR));
  }
}

static void serviceWiFi() {
  static unsigned long lastAttempt = 0;
  if (wifiReady()) {
    if (!wifiWasConnected) {
      wifiWasConnected = true;
      Log.notice(F("WiFi up: %s" CR), WiFi.localIP().toString().c_str());
      startMDNS();
      startTime();
      signal_store::setSource(mdnsHostname());
    }
    return;
  }
  if (wifiWasConnected) {
    wifiWasConnected = false;
    Log.warning(F("WiFi dropped" CR));
  }
  if (millis() - lastAttempt < WIFI_RETRY_MS) {
    return;
  }
  lastAttempt = millis();
  WiFi.disconnect();
  WiFi.begin(_activeSsid, _activePass);
}

#define BOOT_BUTTON_GPIO 0
#define BOOT_HOLD_MS     3000

// GPIO0 is the Freenove ESP32-S3 board's BOOT button, pulled up on-board.
// Held low continuously for BOOT_HOLD_MS at boot clears stored WiFi
// credentials so the device re-enters provisioning. Returns immediately
// (no delay) if the button is not held at boot.
static bool bootButtonHeld() {
  pinMode(BOOT_BUTTON_GPIO, INPUT_PULLUP);
  if (digitalRead(BOOT_BUTTON_GPIO) != LOW) {
    return false;
  }
  unsigned long start = millis();
  while (digitalRead(BOOT_BUTTON_GPIO) == LOW) {
    if (millis() - start >= BOOT_HOLD_MS) {
      return true;
    }
    delay(20);
  }
  return false;
}

void rtl_433_Callback(char* message) {
  Log.notice(F("Received message : %s" CR), message);
  lastDecodeAt = millis();
  SignalQueueItem item;
  strncpy(item.payload, message, sizeof(item.payload) - 1);
  item.payload[sizeof(item.payload) - 1] = '\0';
  item.rssi = rtl_433_ESP::signalRssi;
  if (rtl433Queue == nullptr || xQueueSend(rtl433Queue, &item, 0) != pdTRUE) {
    rtl433QueueDropped++;
    Log.warning(F("signal queue full, dropped %lu total" CR),
                (unsigned long)rtl433QueueDropped);
  }
}

static void drainSignalQueue() {
  if (rtl433Queue == nullptr) {
    return;
  }
  SignalQueueItem item;
  // Bounded so a burst that refills the queue as fast as it drains cannot
  // starve the rest of loop().
  for (int n = 0; n < RTL433_QUEUE_LEN &&
                  xQueueReceive(rtl433Queue, &item, 0) == pdTRUE; n++) {
    if (signal_store::record(item.payload, item.rssi)) {
      web_ui::broadcast(signal_store::device(0));
    }
  }
}

// Reading the temperature parks the radio in standby, so reception stops around
// it and is restarted by hand. RadioLib's getTemperature() is not used: it polls
// the measurement bit unbounded, and a lost SPI transaction there would hang
// loop() with the radio deaf and the interrupt detached.
static int radioTemperature() {
#ifdef RF_RF69
  // currentRssi is a 2ms peak hold, so quiet here can still be a gap inside a
  // packet; lastDecodeAt catches the packet either side of that gap.
  // currentRssi 0 is the value before the receiver task has taken a sample, not
  // a signal 0 dBm strong.
  if (rtl_433_ESP::currentRssi != 0 &&
      rtl_433_ESP::currentRssi > rtl_433_ESP::rssiThreshold) {
    return INT16_MIN;
  }
  if (millis() - lastDecodeAt < RECEIVER_QUIET_MS) {
    return INT16_MIN;
  }

  rf.disableReceiver();
  delay(5); // let an RSSI read already on the SPI bus finish
  Module* mod = radio.getMod();
  int    t = INT16_MIN;
  // The RF69 defers OP_MODE writes for a while after entering RX (the mode
  // change lands once the receiver settles), so the STANDBY write right after
  // init can time RadioLib's checkback out. A failed write skips the read; the
  // radio is put back in RX below, so reception resumes either way.
  if (radio.setMode(RADIOLIB_RF69_STANDBY) == RADIOLIB_ERR_NONE) {
    mod->SPIsetRegValue(RADIOLIB_RF69_REG_TEMP_1, RADIOLIB_RF69_TEMP_MEAS_START, 3, 3);
    for (int i = 0; i < RADIO_TEMP_TRIES; i++) {
      if (mod->SPIgetRegValue(RADIOLIB_RF69_REG_TEMP_1, 2, 2) !=
          RADIOLIB_RF69_TEMP_MEAS_RUNNING) {
        int8_t raw = (int8_t)mod->SPIgetRegValue(RADIOLIB_RF69_REG_TEMP_2);
        t = -(int)raw - RADIO_TEMP_OFFSET;
        break;
      }
      delay(1);
    }
  } else {
    Log.warning(F("setMode standby failed, skipping radio temperature read" CR));
  }
  // Silently leaving the part in standby would look exactly like a quiet band:
  // the receiver task keeps sampling RSSI and no decode ever arrives again.
  int state = radio.receiveDirect();
  if (state != RADIOLIB_ERR_NONE) {
    Log.warning(F("receiveDirect after temperature read failed: %d, retrying" CR), state);
    state = radio.receiveDirect();
  }
  // receiveDirect's return alone is not the whole proof: the OpMode register
  // read confirms the part is actually in RX, not parked in standby.
  if (state != RADIOLIB_ERR_NONE || !radioBackInRx(mod)) {
    Log.error(F("radio not back in RX after temperature read" CR));
    reinitRadio();
    recordRecoveryEvent();
    return INT16_MIN;
  }
  rf.enableReceiver();
  return t;
#else
  return INT16_MIN;
#endif
}

// Re-runs the radio config path. The library has no SPI mutex, so the receiver
// task and the DIO2 interrupt are stopped first: otherwise radio.reset() and the
// SPI re-config interleave with the task's RSSI reads and the chip can come back
// mis-registered. initReceiver()'s task creation is guarded, so no second
// receiver task spawns.
static void reinitRadio() {
  rf.disableReceiver();
  delay(5); // let an RSSI read already on the SPI bus finish
  rf.initReceiver(RF_MODULE_RECEIVER_GPIO, RF_MODULE_FREQUENCY);
  rf.setCallback(rtl_433_Callback, messageBuffer, JSON_MSG_BUFFER);
  rf.enableReceiver();
}

// Confirms the SX1231 is actually in RX. receiveDirect()'s return alone is not
// the whole proof: the OpMode register is read back, bits 4:2 being the mode
// setMode() wrote. RadioLib's SPIgetRegValue returns those bits in place, so
// the compare is against RADIOLIB_RF69_RX itself, not the value right-shifted.
static bool radioBackInRx(Module* mod) {
  return mod->SPIgetRegValue(RADIOLIB_RF69_REG_OP_MODE, 4, 2) == RADIOLIB_RF69_RX;
}

// One recovery event: stamps the state and NVS, then logs. Called for both the
// monitor's soft re-init and the temperature-path recovery.
static void recordRecoveryEvent() {
  radio_health::noteRecovery(healthState, millis());
  time_t utc = time(nullptr);
  health_store::noteRecovery(utc >= 1700000000 ? utc : 0);
  Log.warning(F("radio health: recovery_count=%lu" CR),
              (unsigned long)health_store::recoveryCount());
}

// snprintf returns what it would have written, so an unclamped running offset
// walks past the buffer once the text does not fit.
static size_t appendf(char* buf, size_t size, size_t at, const char* fmt, ...) {
  if (at >= size - 1) {
    return size - 1;
  }
  va_list args;
  va_start(args, fmt);
  int n = vsnprintf(buf + at, size - at, fmt, args);
  va_end(args);
  if (n < 0) {
    return at;
  }
  return (size_t)n >= size - at ? size - 1 : at + (size_t)n;
}

// The receiver's own readings, recorded as a device so the page renders them
// with everything it already does for a sensor. rssi is the WiFi link, which is
// what the card's corner reading means for this one.
static void recordBMP280() {
  if (!bmp280_ok) {
    return;
  }
  float t = bmp280.readTemperature();
  float p = bmp280.readPressure() / 100.0F;
  if (isnan(t) || isnan(p)) {
    Log.warning(F("BMP280 read failed" CR));
    return;
  }

  char buf[JSON_MSG_BUFFER];
  snprintf(buf, sizeof(buf),
           "{\"model\":\"BMP280\",\"id\":\"%#04x\",\"channel\":1,"
           "\"temperature_C\":%.2f,\"pressure_hPa\":%.2f}",
           bmp280_addr, t, p);
  Log.notice(F("BMP280: %s" CR), buf);

  if (signal_store::record(buf, wifiReady() ? WiFi.RSSI() : 0)) {
    web_ui::broadcast(signal_store::device(0));
  }
}

static void recordReceiver() {
  static int lastRadioC = INT16_MIN;
  int        radioC = radioTemperature();
  if (radioC == INT16_MIN) {
    radioC = lastRadioC; // a skipped read keeps the last one rather than a hole
  } else {
    lastRadioC = radioC;
  }

  // 0 only while the last soft re-init has not yet been confirmed by a decode.
  bool radioOk = healthState.lastRecoveryAt == 0 ||
                 lastDecodeAt > healthState.lastRecoveryAt;

  char buf[JSON_MSG_BUFFER];
  size_t n = 0;
  n = appendf(buf, sizeof(buf), n,
              "{\"model\":\"Receiver\",\"build\":\"" BUILD_ID "\","
              "\"uptime_s\":%lu,\"boot_count\":%lu,\"last_reset_reason\":%d,"
              "\"recovery_count\":%lu,\"last_recovery_s\":%lu,"
              "\"radio_ok\":%d,\"coredump_pending\":%d,"
              "\"temperature_C\":%.1f,\"heap_kB\":%lu",
              (unsigned long)(millis() / 1000),
              (unsigned long)health_store::bootCount(),
              (int)health_store::resetReason(),
              (unsigned long)health_store::recoveryCount(),
              (unsigned long)(healthState.lastRecoveryAt / 1000),
              radioOk ? 1 : 0,
              bootCoredumpPending ? 1 : 0,
              temperatureRead(), (unsigned long)(ESP.getFreeHeap() / 1024));
  if (radioC != INT16_MIN) {
    n = appendf(buf, sizeof(buf), n, ",\"radio_C\":%d", radioC);
  }
  // Zero until the receiver task has averaged its first batch of samples. The
  // page merges fields across messages, so leaving it out beats reporting 0.
  if (rtl_433_ESP::averageRssi != 0) {
    n = appendf(buf, sizeof(buf), n,
                ",\"noise_dBm\":%d,\"rssi_thresh\":%d",
                rtl_433_ESP::averageRssi, rtl_433_ESP::rssiThreshold);
  }
  appendf(buf, sizeof(buf), n, "}");

  if (signal_store::record(buf, wifiReady() ? WiFi.RSSI() : 0, false)) {
    web_ui::broadcast(signal_store::device(0));
  }
}

#ifdef FAKE_SIGNALS
static bool fakeSignalTick() {
  static unsigned long last = 0;
  static int           seq = 0;
  if (millis() - last < 3000) {
    return false;
  }
  last = millis();
  lastDecodeAt = last;
  char buf[JSON_MSG_BUFFER];
  snprintf(buf, sizeof(buf),
           "{\"model\":\"Fake-TH\",\"id\":%d,\"channel\":%d,\"temperature_C\":%d.%d,"
           "\"humidity\":%d,\"battery_ok\":1,\"wind_avg_km_h\":%d}",
           (seq / 2) % 30, (seq % 3) + 1, 18 + (seq % 10), seq % 10, 30 + (seq % 60),
           seq % 25);
  seq++;
  if (signal_store::record(buf, -60 - (seq % 30))) {
    web_ui::broadcast(signal_store::device(0));
  }
  return true;
}
#endif

// After a power outage the router comes up well after the ESP32, so one
// WIFI_CONNECT_MS window is not enough to tell a slow network from a wrong
// password.
static void bootConnect(const char* ssid, const char* pass) {
  for (int attempt = 1; attempt <= WIFI_BOOT_ATTEMPTS && !wifiReady(); attempt++) {
    Log.notice(F("WiFi boot attempt %d of %d" CR), attempt, WIFI_BOOT_ATTEMPTS);
    connectWiFi(ssid, pass);
  }
}

// The radio health monitor, run once per telemetry cycle. Recovery happens
// here; a soft re-init is logged and carried out immediately.
static void monitorRadioHealth() {
#ifdef FAKE_SIGNALS
  // Recovery-exercise mode: after FAKE_RADIO_FAIL_MS pretend the radio is deaf
  // (no decodes, floor pinned) so the soft re-init path runs and logs. It
  // requires a board to exercise the ladder.
  unsigned long decodeAt = lastDecodeAt;
  int           floor    = rtl_433_ESP::averageRssi;
  if (FAKE_RADIO_FAIL_MS > 0 && millis() > (unsigned long)FAKE_RADIO_FAIL_MS) {
    decodeAt = 0;
    floor    = NOISE_FLOOR_DBM - 1;
  }
  radio_health::HealthAction action = radio_health::evaluate(
      healthState, millis(), floor, decodeAt);
#else
  radio_health::HealthAction action = radio_health::evaluate(
      healthState, millis(), rtl_433_ESP::averageRssi, lastDecodeAt);
#endif
  if (action == radio_health::HealthAction::softReinit) {
    reinitRadio();
    recordRecoveryEvent();
  }
}

void setup() {
  Serial0.begin(921600);
  delay(1000);
#ifndef LOG_LEVEL
  #define LOG_LEVEL LOG_LEVEL_SILENT
#endif
  Log.begin(LOG_LEVEL, &Serial0);
  Log.notice(F(" " CR));
  Log.notice(F("****** setup ******" CR));

  wifi_store::begin();
  ota_token_store::begin();
  mqtt_publish_store::begin();
  if (bootButtonHeld()) {
    Log.notice(F("BOOT button held: clearing stored WiFi credentials" CR));
    wifi_store::clear();
  }

  Wire.begin(21, 47);
  if (bmp280.begin(0x76)) {
    bmp280_ok = true;
    bmp280_addr = 0x76;
  } else if (bmp280.begin(0x77)) {
    bmp280_ok = true;
    bmp280_addr = 0x77;
  }
  if (bmp280_ok) {
    Log.notice(F("BMP280 initialized at 0x%02x" CR), bmp280_addr);
  } else {
    Log.warning(F("BMP280 not found on I2C" CR));
  }

  health_store::begin();
  bootCoredumpPending = esp_core_dump_image_check() == ESP_OK;
  health_store::noteBoot((uint8_t)esp_reset_reason());
  Log.notice(F("boot: build=%s reset=%d boot_count=%lu heap=%lu coredump=%d" CR),
             BUILD_ID, (int)health_store::resetReason(),
             (unsigned long)health_store::bootCount(),
             (unsigned long)ESP.getFreeHeap(), bootCoredumpPending ? 1 : 0);
  if (wifi_store::hasCredentials()) {
    bootConnect(wifi_store::ssid(), wifi_store::password());
  }
#if defined(WIFI_SSID) && defined(WIFI_PASSWORD)
  else {
    bootConnect(WIFI_SSID, WIFI_PASSWORD);
    if (wifiReady()) {
      wifi_store::set(WIFI_SSID, WIFI_PASSWORD);
    }
  }
#endif
  if (!wifiReady()) {
    provisioning::run(); // blocks; ends in ESP.restart() once configured
  }
  signal_store::setSource(mdnsHostname());
  tz_store::begin();
  device_hooks::begin();
  signal_store::addRecordHook(device_hooks::dispatch);
  mqtt_publish::begin(mdnsHostname());
  signal_store::addRecordHook(mqtt_publish::onRecord);
  alias_store::begin();
  layout_store::begin();
  location_store::begin();
  units_store::begin();
  web_ui::begin();
  rtl433Queue = xQueueCreate(RTL433_QUEUE_LEN, sizeof(SignalQueueItem));
  rf.initReceiver(RF_MODULE_RECEIVER_GPIO, RF_MODULE_FREQUENCY);
  rf.setCallback(rtl_433_Callback, messageBuffer, JSON_MSG_BUFFER);
  rf.enableReceiver();
#ifdef FAKE_SIGNALS
  signal_store::selfTest();
  alias_store::selfTest();
  layout_store::selfTest();
  location_store::selfTest();
  units_store::selfTest();
  wifi_store::selfTest();
  ota_token_store::selfTest();
  mqtt_publish_store::selfTest();
#endif
  recordReceiver();
  Log.notice(F("****** setup complete ******" CR));
  rf.getModuleStatus();
}

void loop() {
  rf.loop();
  serviceWiFi();
  web_ui::loop();
  mqtt_publish::loop();
  drainSignalQueue();
#ifdef FAKE_SIGNALS
  fakeSignalTick();
#endif

  static unsigned long lastTelemetry = 0;
  if (millis() - lastTelemetry >= RECEIVER_TELEMETRY_MS) {
    lastTelemetry = millis();
    monitorRadioHealth();
    recordReceiver();
  }

  static unsigned long lastBMP280 = 0;
  if (millis() - lastBMP280 >= 30000) {
    lastBMP280 = millis();
    recordBMP280();
  }

  // The clock comes up via SNTP after WiFi connects; stamp this boot's UTC once.
  if (!bootUtcStamped) {
    time_t utc = time(nullptr);
    if (utc >= 1700000000) {
      health_store::noteFirstSync(utc);
      bootUtcStamped = true;
    }
  }

  static unsigned long lastSweep = 0;
  if (millis() - lastSweep >= 60000) {
    lastSweep = millis();
    signal_store::sweepStale(millis(), (unsigned long)DEVICE_STALE_HOURS * 3600000UL);
  }
}
