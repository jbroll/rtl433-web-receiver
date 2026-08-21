#include <stdio.h>

#include "layout_store.h"

int main() {
  bool ok = layout_store::selfTest();
  printf("layout_store selfTest: %s\n", ok ? "PASS" : "FAIL");
  return ok ? 0 : 1;
}
