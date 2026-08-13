/*
 rtl_433_ESP receiver with a live web page.

 Copy .env.example to .env and fill it in before building.
*/

#include <ArduinoJson.h>
#include <ArduinoLog.h>
#include <ESPmDNS.h>
#include <WiFi.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <rtl_433_ESP.h>

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

#define JSON_MSG_BUFFER   512
#define WIFI_CONNECT_MS   20000
#define WIFI_RETRY_MS     30000

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
  web_ui::begin();
  rtl433Queue = xQueueCreate(RTL433_QUEUE_LEN, sizeof(SignalQueueItem));
  rf.initReceiver(RF_MODULE_RECEIVER_GPIO, RF_MODULE_FREQUENCY);
  rf.setCallback(rtl_433_Callback, messageBuffer, JSON_MSG_BUFFER);
  rf.enableReceiver();
#ifdef FAKE_SIGNALS
  signal_store::selfTest();
#endif
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
}
