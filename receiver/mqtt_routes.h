#pragma once

#include <Arduino.h>

// The /$mqtt and /$mqtt/remove request handling, split out of web_ui.cpp so it
// can be host-tested without a WebServer. web_ui.cpp does the transport work:
// it reads the method, path, body and origin, and writes the returned status,
// body and headers back.
namespace mqtt_routes {

enum class Method { Get, Post, Options };

struct Response {
  int         status      = 404;
  const char* contentType = "text/plain";
  String      body;
  // A preflight answer carries the Allow-Methods/Allow-Headers/Max-Age
  // headers and no Cache-Control; every other answer is the reverse.
  bool preflight = false;
  // The table changed, so the caller must reconverge the connections. Doing
  // that here would drag mqtt_publish::begin()'s WiFi work into the seam.
  bool reloadConnections = false;
};

// path is the request path ("/$mqtt" or "/$mqtt/remove"); sameOrigin is
// web_ui's origin check, already applied to the request.
Response dispatch(Method method, const char* path, bool sameOrigin, const String& body);

} // namespace mqtt_routes
