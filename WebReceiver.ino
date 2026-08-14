/*
 rtl_433_ESP receiver with a live web page.

 Copy .env.example to .env and fill it in before building.
*/

#include <stdarg.h>

#include <ArduinoJson.h>
#include <ArduinoLog.h>
#include <ESPmDNS.h>
#include <WiFi.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <rtl_433_ESP.h>

#include "alias_store.h"
#include "signal_store.h"
#include "web_ui.h"

#if !defined(WIFI_SSID) || !defined(WIFI_PASSWORD)
#  error ".env is missing or incomplete - copy .env.example to .env and fill it in"
#endif

#ifndef MDNS_PREFIX
#  define MDNS_PREFIX "rtl433"
#endif

#ifndef RF_MODULE_FREQUENCY
#  define RF_MODULE_FREQUENCY 433.92
#endif

#ifndef DEVICE_STALE_HOURS
#define DEVICE_STALE_HOURS 72
#endif

#define JSON_MSG_BUFFER   512
#define WIFI_CONNECT_MS   20000
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

// Carries the whole message, not a SIGNAL_PAYLOAD_MAX-truncated copy: the store
// truncates after parsing, and truncated JSON would fail to parse at all.
struct SignalQueueItem {
  char payload[JSON_MSG_BUFFER];
  int  rssi;
};

static QueueHandle_t rtl433Queue         = nullptr;
static uint32_t      rtl433QueueDropped  = 0;
// Written from the decoder task, read from loop(); a stale read only delays a
// telemetry sample by a minute.
static volatile unsigned long lastDecodeAt = 0;

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

static void startMDNS() {
  MDNS.end(); // a second begin() without this fails to re-add the http service
  if (MDNS.begin(mdnsHostname())) {
    MDNS.addService("http", "tcp", 80);
    Log.notice(F("mDNS started: %s.local" CR), mdnsHostname());
  } else {
    Log.warning(F("mDNS start failed" CR));
  }
}

static void connectWiFi() {
  Log.notice(F("WiFi connecting to %s" CR), WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < WIFI_CONNECT_MS) {
    delay(200);
  }
  if (wifiReady()) {
    Log.notice(F("WiFi connected: %s" CR), WiFi.localIP().toString().c_str());
    startMDNS();
    wifiWasConnected = true;
  } else {
    Log.warning(F("WiFi connect failed, decoding continues" CR));
  }
}

static void serviceWiFi() {
  static unsigned long lastAttempt = 0;
  if (wifiReady()) {
    if (!wifiWasConnected) {
      wifiWasConnected = true;
      Log.notice(F("WiFi up: %s" CR), WiFi.localIP().toString().c_str());
      startMDNS();
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
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
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
  while (xQueueReceive(rtl433Queue, &item, 0) == pdTRUE) {
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
  }
  // Silently leaving the part in standby would look exactly like a quiet band:
  // the receiver task keeps sampling RSSI and no decode ever arrives again.
  int state = radio.receiveDirect();
  if (state != RADIOLIB_ERR_NONE) {
    Log.warning(F("receiveDirect after temperature read failed: %d, retrying" CR), state);
    state = radio.receiveDirect();
  }
  rf.enableReceiver();
  return state == RADIOLIB_ERR_NONE ? t : INT16_MIN;
#else
  return INT16_MIN;
#endif
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
static void recordReceiver() {
  static int lastRadioC = INT16_MIN;
  int        radioC = radioTemperature();
  if (radioC == INT16_MIN) {
    radioC = lastRadioC; // a skipped read keeps the last one rather than a hole
  } else {
    lastRadioC = radioC;
  }

  char buf[JSON_MSG_BUFFER];
  size_t n = 0;
  n = appendf(buf, sizeof(buf), n,
              "{\"model\":\"Receiver\",\"temperature_C\":%.1f,\"heap_kB\":%lu",
              temperatureRead(), (unsigned long)(ESP.getFreeHeap() / 1024));
  if (radioC != INT16_MIN) {
    n = appendf(buf, sizeof(buf), n, ",\"radio_C\":%d", radioC);
  }
  // Zero until the receiver task has averaged its first batch of samples. The
  // page merges fields across messages, so leaving it out beats reporting 0.
  if (rtl_433_ESP::averageRssi != 0) {
    n = appendf(buf, sizeof(buf), n, ",\"noise_dBm\":%d", rtl_433_ESP::averageRssi);
  }
  appendf(buf, sizeof(buf), n, "}");

  if (signal_store::record(buf, wifiReady() ? WiFi.RSSI() : 0, false)) {
    web_ui::broadcast(signal_store::device(0), false);
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
  char buf[JSON_MSG_BUFFER];
  snprintf(buf, sizeof(buf),
           "{\"model\":\"Fake-TH\",\"id\":%d,\"channel\":%d,\"temperature_C\":%d.%d,"
           "\"humidity\":%d,\"battery_ok\":1,\"wind_avg_km_h\":%d}",
           seq % 30, (seq % 3) + 1, 18 + (seq % 10), seq % 10, 30 + (seq % 60),
           seq % 25);
  seq++;
  if (signal_store::record(buf, -60 - (seq % 30))) {
    web_ui::broadcast(signal_store::device(0));
  }
  return true;
}
#endif

void setup() {
  Serial0.begin(921600);
  delay(1000);
#ifndef LOG_LEVEL
  LOG_LEVEL_SILENT
#endif
  Log.begin(LOG_LEVEL, &Serial0);
  Log.notice(F(" " CR));
  Log.notice(F("****** setup ******" CR));
  connectWiFi();
  alias_store::begin();
  web_ui::begin();
  rtl433Queue = xQueueCreate(RTL433_QUEUE_LEN, sizeof(SignalQueueItem));
  rf.initReceiver(RF_MODULE_RECEIVER_GPIO, RF_MODULE_FREQUENCY);
  rf.setCallback(rtl_433_Callback, messageBuffer, JSON_MSG_BUFFER);
  rf.enableReceiver();
#ifdef FAKE_SIGNALS
  signal_store::selfTest();
  alias_store::selfTest();
#endif
  recordReceiver();
  Log.notice(F("****** setup complete ******" CR));
  rf.getModuleStatus();
}

void loop() {
  rf.loop();
  serviceWiFi();
  web_ui::loop();
  drainSignalQueue();
#ifdef FAKE_SIGNALS
  fakeSignalTick();
#endif

  static unsigned long lastTelemetry = 0;
  if (millis() - lastTelemetry >= RECEIVER_TELEMETRY_MS) {
    lastTelemetry = millis();
    recordReceiver();
  }

  static unsigned long lastSweep = 0;
  if (millis() - lastSweep >= 60000) {
    lastSweep = millis();
    signal_store::sweepStale(millis(), (unsigned long)DEVICE_STALE_HOURS * 3600000UL);
  }
}
