#include <stdio.h>

#include "signal_store.h"

int main() {
  bool ok = signal_store::selfTest();
  printf("signal_store selfTest: %s\n", ok ? "PASS" : "FAIL");
  return ok ? 0 : 1;
}
