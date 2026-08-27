#include <stdio.h>

#include "ota_token_store.h"

int main() {
  bool ok = ota_token_store::selfTest();
  printf("ota_token_store selfTest: %s\n", ok ? "PASS" : "FAIL");
  return ok ? 0 : 1;
}
