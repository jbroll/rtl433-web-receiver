#include <stdio.h>

#include "alias_store.h"

int main() {
  bool ok = alias_store::selfTest();
  printf("alias_store selfTest: %s\n", ok ? "PASS" : "FAIL");
  return ok ? 0 : 1;
}
