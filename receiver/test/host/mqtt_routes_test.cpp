#include <stdio.h>
#include <string.h>

#include <ArduinoJson.h>

#include "mqtt_publish.h"
#include "mqtt_publish_store.h"
#include "mqtt_routes.h"

using mqtt_routes::Method;
using mqtt_routes::Response;

static int failures = 0;

static void check(const char* what, bool ok) {
  printf("%-72s %s\n", what, ok ? "PASS" : "FAIL");
  if (!ok) failures++;
}

static Response post(const char* path, const char* body, bool sameOrigin = true) {
  return mqtt_routes::dispatch(Method::Post, path, sameOrigin, String(body));
}

static Response get(const char* path) {
  return mqtt_routes::dispatch(Method::Get, path, true, String(""));
}

static void clearStore() {
  for (uint8_t i = 0; i < MQTT_PUBLISH_SLOTS; i++) {
    const char* url = mqtt_publish_store::urlAt(i);
    if (url != nullptr) mqtt_publish_store::remove(url);
  }
}

static bool storeHas(const char* url, const char* token) {
  int i = mqtt_publish_store::indexOf(url);
  return i >= 0 && strcmp(mqtt_publish_store::tokenAt((uint8_t)i), token) == 0;
}

static void preflight() {
  Response r = mqtt_routes::dispatch(Method::Options, "/$mqtt", true, String(""));
  check("OPTIONS /$mqtt is a 204 preflight",
        r.status == 204 && r.preflight && r.body.length() == 0);
  Response rr = mqtt_routes::dispatch(Method::Options, "/$mqtt/remove", true, String(""));
  check("OPTIONS /$mqtt/remove is a 204 preflight", rr.status == 204 && rr.preflight);
  check("a preflight does not reconverge the connections", !r.reloadConnections);
  Response off = mqtt_routes::dispatch(Method::Options, "/$mqtt", false, String(""));
  check("a preflight is answered off-origin too", off.status == 204 && off.preflight);
}

static void listing() {
  clearStore();
  mqtt_publish_store::add("mqtt://one.example:1883", "t1");
  mqtt_publish_store::add("mqtt://host", "t2"); // no port: mqtt_publish cannot parse it
  mqtt_publish::begin("test-client");

  Response r = get("/$mqtt");
  check("GET /$mqtt is a 200 of application/json",
        r.status == 200 && strcmp(r.contentType, "application/json") == 0);
  check("GET /$mqtt does not reconverge the connections", !r.reloadConnections);
  check("GET /$mqtt is not a preflight", !r.preflight);

  JsonDocument doc;
  bool         parsed = deserializeJson(doc, r.body) == DeserializationError::Ok;
  check("GET /$mqtt returns a JSON array", parsed && doc.is<JsonArray>());
  if (!parsed || !doc.is<JsonArray>()) return;
  JsonArray arr = doc.as<JsonArray>();
  check("it lists one entry per active connection", arr.size() == mqtt_publish::count());

  bool sawStored = false, sawBuildFlag = false, sawReason = false, tokenLeaked = false;
  for (JsonObject o : arr) {
    const char* url = o["url"];
    if (url != nullptr && strcmp(url, "mqtt://one.example:1883") == 0) {
      sawStored = o["connected"].is<bool>() && o["connected"] == false;
    }
    if (url != nullptr && strcmp(url, "mqtt://buildflag.example:1883") == 0) sawBuildFlag = true;
    if (o["reason"].is<const char*>()) sawReason = true;
    if (o["token"].is<const char*>()) tokenLeaked = true;
  }
  check("a stored broker appears with its url and connected state", sawStored);
  check("the build-flag broker is listed alongside the stored ones", sawBuildFlag);
  check("an unparseable url carries a reason", sawReason);
  check("no entry exposes a token", !tokenLeaked);
}

static void addRoute() {
  clearStore();
  mqtt_publish::begin("test-client");

  check("POST /$mqtt off-origin is 403",
        post("/$mqtt", "{\"url\":\"mqtt://a.example:1883\"}", false).status == 403);
  check("an off-origin POST does not reach the store",
        mqtt_publish_store::indexOf("mqtt://a.example:1883") < 0);

  Response bad = post("/$mqtt", "not json");
  check("POST /$mqtt with an unparseable body is 400", bad.status == 400);
  check("the 400 names the expected body",
        strcmp(bad.body.c_str(), "body must be a JSON object with a url") == 0);
  check("POST /$mqtt with a JSON array is 400", post("/$mqtt", "[1,2]").status == 400);
  check("POST /$mqtt with no url is 400", post("/$mqtt", "{\"token\":\"t\"}").status == 400);
  check("POST /$mqtt with a non-string url is 400", post("/$mqtt", "{\"url\":7}").status == 400);
  check("a rejected body does not reconverge the connections", !bad.reloadConnections);

  Response ok = post("/$mqtt", "{\"url\":\"mqtt://a.example:1883\",\"token\":\"tok\"}");
  check("POST /$mqtt with a url and token is 204",
        ok.status == 204 && ok.body.length() == 0 && strcmp(ok.contentType, "text/plain") == 0);
  check("it stores the url and token", storeHas("mqtt://a.example:1883", "tok"));
  check("it asks the caller to reconverge the connections", ok.reloadConnections);

  Response noToken = post("/$mqtt", "{\"url\":\"mqtt://b.example:1883\"}");
  check("a missing token is stored as empty, not rejected",
        noToken.status == 204 && storeHas("mqtt://b.example:1883", ""));

  Response invalid = post("/$mqtt", "{\"url\":\"http://a.example\"}");
  check("a url the store rejects is 400", invalid.status == 400);
  check("the 400 names the store's rejection",
        strcmp(invalid.body.c_str(), "invalid url/token, or the bridge table is full") == 0);
  check("a store rejection does not reconverge the connections", !invalid.reloadConnections);

  post("/$mqtt", "{\"url\":\"mqtt://c.example:1883\"}");
  check("a full table is 400", post("/$mqtt", "{\"url\":\"mqtt://d.example:1883\"}").status == 400);

  check("re-adding a stored url updates it in place",
        post("/$mqtt", "{\"url\":\"mqtt://a.example:1883\",\"token\":\"new\"}").status == 204 &&
            storeHas("mqtt://a.example:1883", "new"));
}

static void removeRoute() {
  clearStore();
  mqtt_publish_store::add("mqtt://a.example:1883", "tok");
  mqtt_publish::begin("test-client");

  check("POST /$mqtt/remove off-origin is 403",
        post("/$mqtt/remove", "{\"url\":\"mqtt://a.example:1883\"}", false).status == 403);
  check("an off-origin remove leaves the entry in place",
        mqtt_publish_store::indexOf("mqtt://a.example:1883") >= 0);
  check("POST /$mqtt/remove with an unparseable body is 400",
        post("/$mqtt/remove", "{").status == 400);
  check("POST /$mqtt/remove with no url is 400", post("/$mqtt/remove", "{}").status == 400);

  Response missing = post("/$mqtt/remove", "{\"url\":\"mqtt://gone.example:1883\"}");
  check("removing a url that is not stored is 404", missing.status == 404);
  check("the 404 body is 'not found'", strcmp(missing.body.c_str(), "not found") == 0);
  check("a 404 remove does not reconverge the connections", !missing.reloadConnections);

  Response ok = post("/$mqtt/remove", "{\"url\":\"mqtt://a.example:1883\"}");
  check("removing a stored url is 204", ok.status == 204 && ok.body.length() == 0);
  check("it drops the entry", mqtt_publish_store::indexOf("mqtt://a.example:1883") < 0);
  check("it asks the caller to reconverge the connections", ok.reloadConnections);
}

static void unroutable() {
  check("an unknown path is 404", get("/$mqttx").status == 404);
  check("a POST to an unknown path is 404 before the origin check",
        post("/$mqtt/other", "{\"url\":\"mqtt://a.example:1883\"}", false).status == 404);
  check("GET /$mqtt/remove is 404", get("/$mqtt/remove").status == 404);
}

int main() {
  mqtt_publish_store::begin();
  preflight();
  listing();
  addRoute();
  removeRoute();
  unroutable();
  clearStore();
  printf("mqtt_routes: %s\n", failures == 0 ? "PASS" : "FAIL");
  return failures == 0 ? 0 : 1;
}
