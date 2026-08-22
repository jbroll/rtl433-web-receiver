#include <stdio.h>

#include "mqtt_publish_store.h"

int main() {
  bool ok = mqtt_publish_store::selfTest();
  printf("mqtt_publish_store selfTest: %s\n", ok ? "PASS" : "FAIL");
  return ok ? 0 : 1;
}
