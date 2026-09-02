#include <ArduinoJson.h>
#include <ArduinoLog.h>
#include <rtl_433_ESP.h>

#define JSON_MSG_BUFFER 512

char messageBuffer[JSON_MSG_BUFFER];
rtl_433_ESP rf;
static unsigned long decodes = 0;

void rtl_433_Callback(char* message) {
  decodes++;
  Serial0.printf("[%lu] %s\n", decodes, message);
}

void setup() {
  Serial0.begin(115200);
  delay(1500);
  Log.begin(LOG_LEVEL, &Serial0);
  Serial0.println("\n=== 915 MHz scan ===");
  rf.initReceiver(RF_MODULE_RECEIVER_GPIO, RF_MODULE_FREQUENCY);
  rf.setCallback(rtl_433_Callback, messageBuffer, JSON_MSG_BUFFER);
  rf.enableReceiver();
  rf.getModuleStatus();
  Serial0.println("=== listening ===");
}

void loop() {
  static unsigned long lastReport = 0;
  rf.loop();
  if (millis() - lastReport > 15000) {
    lastReport = millis();
    Serial0.printf("-- %lus: decodes=%lu averageRssi=%d rssiThreshold=%d\n",
                   millis() / 1000, decodes, rtl_433_ESP::averageRssi,
                   rtl_433_ESP::rssiThreshold);
  }
}
