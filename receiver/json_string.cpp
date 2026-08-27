#include "json_string.h"

#include <stdio.h>

namespace json_string {

void writeJsonString(Print& out, const char* s) {
  out.print('"');
  for (const char* p = s; *p; p++) {
    switch (*p) {
      case '"': out.print("\\\""); break;
      case '\\': out.print("\\\\"); break;
      case '\n': out.print("\\n"); break;
      case '\r': out.print("\\r"); break;
      case '\t': out.print("\\t"); break;
      default:
        if ((unsigned char)*p < 0x20) {
          char esc[7];
          snprintf(esc, sizeof(esc), "\\u%04x", *p);
          out.print(esc);
        } else {
          out.print(*p);
        }
    }
  }
  out.print('"');
}

} // namespace json_string
