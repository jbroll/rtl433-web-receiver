#include <stdio.h>

#include "units_store.h"

int main() {
  bool ok = units_store::selfTest();
  printf("units_store selfTest: %s\n", ok ? "PASS" : "FAIL");
  return ok ? 0 : 1;
}
