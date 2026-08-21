#include <stdio.h>

#include "location_store.h"

int main() {
  bool ok = location_store::selfTest();
  printf("location_store selfTest: %s\n", ok ? "PASS" : "FAIL");
  return ok ? 0 : 1;
}
