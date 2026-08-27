#include "mqtt_routes.h"

#include <ArduinoJson.h>
#include <string.h>

#include "mqtt_publish.h"
#include "mqtt_publish_store.h"

namespace mqtt_routes {
namespace {

Response plain(int code, const char* body) {
  Response r;
  r.status = code;
  r.body   = body;
  return r;
}

Response preflight() {
  Response r;
  r.status    = 204;
  r.preflight = true;
  return r;
}

Response list() {
  JsonDocument doc;
  JsonArray    arr = doc.to<JsonArray>();
  for (uint8_t i = 0; i < mqtt_publish::count(); i++) {
    JsonObject o = arr.add<JsonObject>();
    o["url"] = mqtt_publish::urlAt(i);
    o["connected"] = mqtt_publish::connectedAt(i);
    const char* reason = mqtt_publish::reasonAt(i);
    if (reason != nullptr) o["reason"] = reason;
  }
  Response r;
  r.status      = 200;
  r.contentType = "application/json";
  serializeJson(doc, r.body);
  return r;
}

bool parseUrlBody(const String& body, JsonDocument& doc) {
  return deserializeJson(doc, body) == DeserializationError::Ok && doc.is<JsonObject>() &&
         doc["url"].is<const char*>();
}

Response add(const String& body) {
  JsonDocument doc;
  if (!parseUrlBody(body, doc)) {
    return plain(400, "body must be a JSON object with a url");
  }
  const char* url   = doc["url"];
  const char* token = doc["token"].is<const char*>() ? doc["token"].as<const char*>() : "";
  if (!mqtt_publish_store::add(url, token)) {
    return plain(400, "invalid url/token, or the bridge table is full");
  }
  Response r = plain(204, "");
  r.reloadConnections = true;
  return r;
}

Response remove(const String& body) {
  JsonDocument doc;
  if (!parseUrlBody(body, doc)) {
    return plain(400, "body must be a JSON object with a url");
  }
  const char* url = doc["url"];
  if (!mqtt_publish_store::remove(url)) {
    return plain(404, "not found");
  }
  Response r = plain(204, "");
  r.reloadConnections = true;
  return r;
}

} // namespace

Response dispatch(Method method, const char* path, bool sameOrigin, const String& body) {
  bool isRemove = strcmp(path, "/$mqtt/remove") == 0;
  bool isRoot   = strcmp(path, "/$mqtt") == 0;
  if (!isRoot && !isRemove) {
    return plain(404, "not found");
  }
  if (method == Method::Options) {
    return preflight();
  }
  // Only /$mqtt registers a GET; a GET of /$mqtt/remove reaches the server's
  // not-found handler, never here.
  if (method == Method::Get) {
    return isRoot ? list() : plain(404, "not found");
  }
  if (!sameOrigin) {
    return plain(403, "off-origin");
  }
  return isRemove ? remove(body) : add(body);
}

} // namespace mqtt_routes
