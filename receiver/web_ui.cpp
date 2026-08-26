#include "web_ui.h"

#include <ArduinoJson.h>
#include <ArduinoLog.h>
#include <Update.h>
#include <WebServer.h>
#include <WiFi.h>
#include <errno.h>
#include <lwip/sockets.h>

#include "alias_store.h"
#include "dashboard_html.h"
#include "layout_store.h"
#include "location_store.h"
#include "units_store.h"
#include "mqtt_publish.h"
#include "mqtt_publish_store.h"
#include "ota_token_store.h"
#include "signal_store.h"
#include "topic.h"
#include "tz_store.h"

extern bool wifiReady();

#ifndef BUILD_ID
#  define BUILD_ID "dev"
#endif

namespace web_ui {

static WebServer _server(80);
static bool      _started = false;

#define WEB_UI_SSE_CLIENTS 4
#define WEB_UI_SSE_FILTERS 4
#define WEB_UI_FILTER_MAX  65
#define SSE_KEEPALIVE_MS   15000
// A browser reading 32 payloads of 600 bytes in one pass overflows the socket's
// send buffer and is dropped, so the replay is drained a few frames per loop().
#define REPLAY_PER_LOOP    3

static WiFiClient    _sse[WEB_UI_SSE_CLIENTS];
static uint32_t      _sseAttachedAt[WEB_UI_SSE_CLIENTS] = {0};
static char          _filters[WEB_UI_SSE_CLIENTS][WEB_UI_SSE_FILTERS][WEB_UI_FILTER_MAX];
static uint8_t       _filterCount[WEB_UI_SSE_CLIENTS] = {0};
static int16_t       _replay[WEB_UI_SSE_CLIENTS] = {-1, -1, -1, -1};
static uint32_t      _sseAttachCounter = 0;
static unsigned long _lastKeepalive = 0;

namespace {

// Waits at most timeoutUs for the socket to accept bytes. A positive result
// does not guarantee a full write completes without blocking.
static bool socketReadyToWrite(WiFiClient& client, long timeoutUs = 0) {
  if (!client.connected()) {
    return false;
  }
  int fd = client.fd();
  if (fd < 0) {
    return false;
  }
  fd_set writeSet;
  FD_ZERO(&writeSet);
  FD_SET(fd, &writeSet);
  timeval wait{timeoutUs / 1000000, timeoutUs % 1000000};
  return select(fd + 1, nullptr, &writeSet, nullptr, &wait) > 0 && FD_ISSET(fd, &writeSet);
}

// WiFiClient::write() retries a partial send internally for up to ten seconds,
// which would stall loop() waiting on a slow or dead client.
static void sendFrameOrDrop(WiFiClient& client, const char* data, size_t len) {
  int fd = client.fd();
  if (fd < 0) {
    client.stop();
    return;
  }
  ssize_t sent = ::send(fd, data, len, MSG_DONTWAIT);
  if (sent != (ssize_t)len) {
    client.stop();
  }
}

// A closed browser tab leaves WiFiClient::connected() true until the next
// keepalive write fails; peek for the peer's FIN so a slot frees immediately.
static bool peerClosed(WiFiClient& client) {
  int fd = client.fd();
  if (fd < 0) {
    return true;
  }
  char    probe;
  ssize_t n = ::recv(fd, &probe, 1, MSG_DONTWAIT | MSG_PEEK);
  if (n == 0) {
    return true;
  }
  if (n < 0 && errno != EWOULDBLOCK && errno != EAGAIN) {
    return true;
  }
  return false;
}

static void releaseSlot(int i) {
  _sse[i].stop();
  _filterCount[i] = 0;
  _replay[i] = -1;
}

static void reapClosedClients() {
  for (int i = 0; i < WEB_UI_SSE_CLIENTS; i++) {
    if (_sse[i] && peerClosed(_sse[i])) {
      releaseSlot(i);
    }
  }
}

// A browser reads a multi-KB page slowly enough to fill the socket's send
// buffer, so give each chunk a bounded wait: aborting on the first not-ready
// probe truncates the page, and a truncated page runs no script at all.
#define CHUNK_WAIT_US    150000
#define CHUNK_BUDGET_MS  1500

// Batches body bytes into chunked writes, dropping a client that stays unready
// rather than letting WiFiClient::write() stall loop() for its full retry loop.
class ChunkedResponse : public Print {
 public:
  ChunkedResponse(WebServer& server, WiFiClient client) : _server(server), _client(client) {}

  size_t write(uint8_t b) override { return write(&b, 1); }

  size_t write(const uint8_t* data, size_t len) override {
    size_t sent = 0;
    while (sent < len) {
      if (_fill == sizeof(_buf)) {
        flush();
        if (_aborted) {
          return sent;
        }
      }
      size_t n = min(sizeof(_buf) - _fill, len - sent);
      memcpy(_buf + _fill, data + sent, n);
      _fill += n;
      sent += n;
    }
    return sent;
  }

  void flush() {
    if (_aborted || _fill == 0) {
      return;
    }
    unsigned long start = millis();
    while (!socketReadyToWrite(_client, CHUNK_WAIT_US)) {
      if (!_client.connected() || millis() - start >= CHUNK_BUDGET_MS) {
        _aborted = true;
        _client.stop();
        return;
      }
    }
    _server.sendContent(_buf, _fill);
    _fill = 0;
  }

  void finish() {
    flush();
    // Always terminate: on an aborted client this is a no-op write (the
    // client is already disconnected), but it clears WebServer::_chunked
    // so _finalizeResponse() doesn't try to send a second terminator.
    _server.sendContent("");
  }

 private:
  WebServer& _server;
  WiFiClient _client;
  char       _buf[512];
  size_t     _fill    = 0;
  bool       _aborted = false;
};

// "data: {"topic":"","payload":}\n\n" plus a key, plus a payload.
#define FRAME_OVERHEAD (64 + SIGNAL_KEY_MAX)
// A device payload is embedded raw and an alias name is escaped, which can
// double it.
#define FRAME_DEVICE_CAP (FRAME_OVERHEAD + (2 * SIGNAL_PAYLOAD_MAX + 2) + 1)
// The layout blob is embedded raw and is several times any device payload, so
// it gets its own size rather than putting 4 KB on the stack for every frame.
#define FRAME_LAYOUT_CAP (FRAME_OVERHEAD + LAYOUT_STORE_MAX + 1)

// Assembles a whole SSE frame so broadcast() sends it in one call, and flags
// overflow rather than clamping, so a truncated frame is never put on the wire.
class Frame : public Print {
 public:
  size_t write(uint8_t b) override { return write(&b, 1); }

  size_t write(const uint8_t* data, size_t len) override {
    size_t n = min(len, _cap - 1 - _len);
    if (n < len) {
      _overflow = true;
    }
    memcpy(_buf + _len, data, n);
    _len += n;
    return n;
  }

  const char* data() const { return _buf; }
  size_t      length() const { return _len; }
  bool        overflowed() const { return _overflow; }

  void reset() {
    _len = 0;
    _overflow = false;
    _buf[0] = '\0';
  }

 protected:
  Frame(char* buf, size_t cap) : _buf(buf), _cap(cap) {}

 private:
  char*  _buf;
  size_t _cap;
  size_t _len      = 0;
  bool   _overflow = false;
};

// Zero-initialized so the untouched byte past the last write is always the
// null terminator data() promises.
template <size_t CAP>
class SizedFrame : public Frame {
 public:
  SizedFrame() : Frame(_storage, CAP) {}

 private:
  char _storage[CAP] = {};
};

typedef SizedFrame<FRAME_DEVICE_CAP> FrameBuffer;
typedef SizedFrame<FRAME_LAYOUT_CAP> LayoutFrameBuffer;

// A blob the store accepts has to fit a frame. When it didn't, a save
// persisted and answered 204 while every frame carrying it was dropped, so the
// layout was readable over HTTP and invisible to the dashboard.
static_assert(FRAME_LAYOUT_CAP > 31 + SIGNAL_KEY_MAX + LAYOUT_STORE_MAX,
              "layout frame buffer is too small for LAYOUT_STORE_MAX");

} // namespace

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

namespace {

static bool slotWants(int i, const char* topic) {
  for (uint8_t f = 0; f < _filterCount[i]; f++) {
    if (topic::matchFilter(_filters[i][f], topic)) {
      return true;
    }
  }
  return false;
}

// payload is JSON text, embedded as it stands: an object for a device, a quoted
// string for an alias.
static void buildFrame(Frame& frame, const char* topic, const char* payload) {
  frame.print("data: {\"topic\":");
  writeJsonString(frame, topic);
  frame.print(",\"payload\":");
  frame.print(payload);
  frame.print("}\n\n");
}

// alias frame: payload is a quoted string (escaped inline)
static void buildAliasFrame(Frame& frame, const char* topic, const char* name) {
  frame.print("data: {\"topic\":");
  writeJsonString(frame, topic);
  frame.print(",\"payload\":");
  writeJsonString(frame, name);
  frame.print("}\n\n");
}

static void sendTo(int i, const Frame& frame) {
  WiFiClient& c = _sse[i];
  if (!c) {
    return;
  }
  if (!socketReadyToWrite(c)) {
    Log.warning(F("SSE slot %d not ready, dropping" CR), i);
    releaseSlot(i);
    return;
  }
  sendFrameOrDrop(c, frame.data(), frame.length());
  if (!c) {
    releaseSlot(i);
  }
}

} // namespace

static void streamProgmemBytes(Print& out, const unsigned char* data, size_t total) {
  char buf[256];
  for (size_t off = 0; off < total; off += sizeof(buf)) {
    size_t n = min(sizeof(buf), total - off);
    memcpy_P(buf, data + off, n);
    out.write(reinterpret_cast<const uint8_t*>(buf), n);
  }
}

// Reads are open to any origin; writes are gated by sameOriginOrBare().
static void sendCors() {
  _server.sendHeader("Access-Control-Allow-Origin", "*");
}

static void handleRoot() {
  WiFiClient client = _server.client();
  _server.setContentLength(CONTENT_LENGTH_UNKNOWN);
  sendCors();
  _server.sendHeader("Cache-Control", "no-store");
  _server.sendHeader("Content-Encoding", "gzip");
  _server.send(200, "text/html", "");

  ChunkedResponse out(_server, client);
  streamProgmemBytes(out, DASHBOARD_HTML_GZ, DASHBOARD_HTML_GZ_LEN);
  out.finish();
}

static void sendStatus(int code, const char* body) {
  sendCors();
  _server.sendHeader("Cache-Control", "no-store");
  _server.send(code, "text/plain", body);
}

// Every write route is gated here. The ownSource path check compares against a
// source the requester chose, so it is not an origin check, and a text/plain
// POST is a CORS simple request that any page on the LAN could send. A request
// with no Origin header (curl) is trusted; one whose Origin does not match this
// receiver's own Host is refused.
static bool sameOriginOrBare() {
  String origin = _server.header("Origin");
  if (origin.length() == 0) {
    return true;
  }
  int    schemeEnd  = origin.indexOf("://");
  String originHost = schemeEnd >= 0 ? origin.substring(schemeEnd + 3) : origin;
  return originHost == _server.hostHeader();
}

static bool refuseOffOrigin() {
  if (sameOriginOrBare()) {
    return false;
  }
  sendStatus(403, "off-origin");
  return true;
}

static void handleAliasPost(const char* path) {
  if (refuseOffOrigin()) return;
  const char* src = signal_store::source();
  size_t      srcLen = strlen(src);
  bool        ownSource = strncmp(path, src, srcLen) == 0 && path[srcLen] == '/';
  if (!topic::isAlias(path) || !ownSource) {
    sendStatus(405, "not allowed");
    return;
  }
  String body = _server.arg("plain");
  const char* name;
  JsonDocument doc;
  if (body.length() == 0) {
    name = "";
  } else {
    if (deserializeJson(doc, body) != DeserializationError::Ok || !doc.is<const char*>()) {
      sendStatus(400, "body must be a JSON string");
      return;
    }
    name = doc.as<const char*>();
  }
  if (strlen(path) >= ALIAS_TOPIC_MAX) {
    sendStatus(400, "alias too long");
    return;
  }
  if (*name == '\0') {
    if (alias_store::get(path) != NULL && !alias_store::remove(path)) {
      sendStatus(503, "alias remove failed");
      return;
    }
  } else if (!alias_store::set(path, name)) {
    sendStatus(503, "alias store full");
    return;
  }
  const char* stored = alias_store::get(path);
  if (stored == NULL) stored = "";
  web_ui::broadcastAlias(path, stored);
  mqtt_publish::publishAlias(path, stored);
  sendCors();
  _server.sendHeader("Cache-Control", "no-store");
  _server.send(204, "text/plain", "");
}

static void handleLayoutPost(const char* path) {
  if (refuseOffOrigin()) return;
  // The dashboard POSTs the bare form to its own origin; the source-prefixed
  // form is the curl-able equivalent.
  const char* src = signal_store::source();
  size_t      srcLen = strlen(src);
  bool        ownSource = strncmp(path, src, srcLen) == 0 && path[srcLen] == '/';
  if (strcmp(path, "$layout") != 0 && !ownSource) {
    sendStatus(405, "not allowed");
    return;
  }
  String body = _server.arg("plain");
  JsonDocument doc;
  if (deserializeJson(doc, body) != DeserializationError::Ok || !doc.is<JsonObject>()) {
    sendStatus(400, "body must be a JSON object");
    return;
  }
  if (!layout_store::set(body.c_str())) {
    sendStatus(503, "layout store full");
    return;
  }
  web_ui::broadcastLayout(layout_store::get());
  mqtt_publish::publishLayout(layout_store::get());
  sendCors();
  _server.sendHeader("Cache-Control", "no-store");
  _server.send(204, "text/plain", "");
}

static void handleLocationPost(const char* path) {
  if (refuseOffOrigin()) return;
  // The dashboard POSTs the bare form to its own origin; the source-prefixed
  // form is the curl-able equivalent.
  const char* src = signal_store::source();
  size_t      srcLen = strlen(src);
  bool        ownSource = strncmp(path, src, srcLen) == 0 && path[srcLen] == '/';
  if (strcmp(path, "$location") != 0 && !ownSource) {
    sendStatus(405, "not allowed");
    return;
  }
  String body = _server.arg("plain");
  JsonDocument doc;
  if (deserializeJson(doc, body) != DeserializationError::Ok || !doc.is<JsonObject>()) {
    sendStatus(400, "body must be a JSON object");
    return;
  }
  if (!location_store::set(body.c_str())) {
    sendStatus(503, "location store full");
    return;
  }
  web_ui::broadcastLocation(location_store::get());
  mqtt_publish::publishLocation(location_store::get());
  sendCors();
  _server.sendHeader("Cache-Control", "no-store");
  _server.send(204, "text/plain", "");
}

static void handleUnitsPost(const char* path) {
  if (refuseOffOrigin()) return;
  // The dashboard POSTs the bare form to its own origin; the source-prefixed
  // form is the curl-able equivalent.
  const char* src = signal_store::source();
  size_t      srcLen = strlen(src);
  bool        ownSource = strncmp(path, src, srcLen) == 0 && path[srcLen] == '/';
  if (strcmp(path, "$units") != 0 && !ownSource) {
    sendStatus(405, "not allowed");
    return;
  }
  String body = _server.arg("plain");
  JsonDocument doc;
  if (deserializeJson(doc, body) != DeserializationError::Ok || !doc.is<JsonObject>()) {
    sendStatus(400, "body must be a JSON object");
    return;
  }
  if (!units_store::set(body.c_str())) {
    sendStatus(503, "units store full");
    return;
  }
  web_ui::broadcastUnits(units_store::get());
  mqtt_publish::publishUnits(units_store::get());
  sendCors();
  _server.sendHeader("Cache-Control", "no-store");
  _server.send(204, "text/plain", "");
}

static void handleTzPost(const char* path) {
  if (refuseOffOrigin()) return;
  // The dashboard POSTs the bare form to its own origin; the source-prefixed
  // form is the curl-able equivalent.
  const char* src = signal_store::source();
  size_t      srcLen = strlen(src);
  bool        ownSource = strncmp(path, src, srcLen) == 0 && path[srcLen] == '/';
  if (strcmp(path, "$tz") != 0 && !ownSource) {
    sendStatus(405, "not allowed");
    return;
  }
  String body = _server.arg("plain");
  JsonDocument doc;
  if (deserializeJson(doc, body) != DeserializationError::Ok || !doc.is<long>()) {
    sendStatus(400, "body must be a JSON number");
    return;
  }
  tz_store::set((int16_t)doc.as<long>());
  web_ui::broadcastTz(tz_store::offsetMinutes());
  mqtt_publish::publishTz(tz_store::offsetMinutes());
  sendCors();
  _server.sendHeader("Cache-Control", "no-store");
  _server.send(204, "text/plain", "");
}

static void handleMqttOptions() {
  sendCors();
  _server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  _server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
  _server.sendHeader("Access-Control-Max-Age", "600");
  _server.send(204, "text/plain", "");
}

static void handleMqttGet() {
  JsonDocument doc;
  JsonArray    arr = doc.to<JsonArray>();
  for (uint8_t i = 0; i < mqtt_publish::count(); i++) {
    JsonObject o = arr.add<JsonObject>();
    o["url"] = mqtt_publish::urlAt(i);
    o["connected"] = mqtt_publish::connectedAt(i);
  }
  String body;
  serializeJson(doc, body);
  sendCors();
  _server.sendHeader("Cache-Control", "no-store");
  _server.send(200, "application/json", body);
}

static void handleMqttPost() {
  if (!sameOriginOrBare()) {
    sendStatus(403, "off-origin");
    return;
  }
  String       body = _server.arg("plain");
  JsonDocument doc;
  if (deserializeJson(doc, body) != DeserializationError::Ok || !doc.is<JsonObject>() ||
      !doc["url"].is<const char*>()) {
    sendStatus(400, "body must be a JSON object with a url");
    return;
  }
  const char* url   = doc["url"];
  const char* token = doc["token"].is<const char*>() ? doc["token"].as<const char*>() : "";
  if (!mqtt_publish_store::add(url, token)) {
    sendStatus(400, "invalid url/token, or the bridge table is full");
    return;
  }
  mqtt_publish::begin(signal_store::source());
  sendCors();
  _server.sendHeader("Cache-Control", "no-store");
  _server.send(204, "text/plain", "");
}

static void handleMqttRemovePost() {
  if (!sameOriginOrBare()) {
    sendStatus(403, "off-origin");
    return;
  }
  String       body = _server.arg("plain");
  JsonDocument doc;
  if (deserializeJson(doc, body) != DeserializationError::Ok || !doc.is<JsonObject>() ||
      !doc["url"].is<const char*>()) {
    sendStatus(400, "body must be a JSON object with a url");
    return;
  }
  const char* url = doc["url"];
  mqtt_publish_store::remove(url); // a url that was never present is not an error
  mqtt_publish::begin(signal_store::source());
  sendCors();
  _server.sendHeader("Cache-Control", "no-store");
  _server.send(204, "text/plain", "");
}

// Set at UPLOAD_FILE_START, read once by handleUpdateComplete() and reset
// there — WebServer only invokes the upload callback for a multipart part
// carrying a filename, so any other POST /$update (e.g. no file part) skips
// straight to handleUpdateComplete() and must not see a stale prior result.
static bool _otaAuthorized = false;
static bool _otaStarted    = false;

static void handleUpdateUpload() {
  HTTPUpload& upload = _server.upload();
  if (upload.status == UPLOAD_FILE_START) {
    _otaStarted = false;
    if (!ota_token_store::hasToken()) {
      _otaAuthorized = false;
      return;
    }
    String expected = String("Bearer ") + ota_token_store::token();
    _otaAuthorized  = _server.header("Authorization") == expected;
    if (!_otaAuthorized) {
      Log.warning(F("OTA update: rejected, bad or missing token" CR));
      return;
    }
    Log.notice(F("OTA update: starting, filename=%s" CR), upload.filename.c_str());
    _otaStarted = Update.begin(UPDATE_SIZE_UNKNOWN, U_FLASH);
    if (!_otaStarted) {
      Log.warning(F("OTA update: Update.begin failed: %s" CR), Update.errorString());
    }
  } else if (upload.status == UPLOAD_FILE_WRITE) {
    if (_otaStarted && Update.write(upload.buf, upload.currentSize) != upload.currentSize) {
      Log.warning(F("OTA update: write failed: %s" CR), Update.errorString());
    }
  } else if (upload.status == UPLOAD_FILE_END) {
    if (_otaStarted && !Update.end(true)) {
      Log.warning(F("OTA update: Update.end failed: %s" CR), Update.errorString());
    }
  } else if (upload.status == UPLOAD_FILE_ABORTED) {
    if (_otaStarted) {
      Update.abort();
      _otaStarted = false;
    }
  }
}

static void handleUpdateComplete() {
  bool authorized = _otaAuthorized;
  bool started    = _otaStarted;
  _otaAuthorized = false;
  _otaStarted    = false;
  if (!ota_token_store::hasToken()) {
    sendStatus(404, "not found");
    return;
  }
  if (!authorized) {
    sendStatus(401, "unauthorized");
    return;
  }
  if (!started || Update.hasError()) {
    sendStatus(500, Update.errorString());
    return;
  }
  sendStatus(200, "ok");
  delay(500); // let the response flush before the restart drops the socket
  ESP.restart();
}

static void handleTopic() {
  String      uri = _server.uri();
  const char* path = uri.c_str();
  if (*path == '/') {
    path++;
  }
  if (!topic::validTopic(path)) {
    sendStatus(400, "malformed topic");
    return;
  }
  if (_server.method() == HTTP_OPTIONS) {
    sendCors();
    _server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    _server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
    _server.sendHeader("Access-Control-Max-Age", "600");
    _server.send(204, "text/plain", "");
    return;
  }
  if (_server.method() == HTTP_POST) {
    if (topic::isLayout(path)) {
      handleLayoutPost(path);
      return;
    }
    if (topic::isLocation(path)) {
      handleLocationPost(path);
      return;
    }
    if (topic::isUnits(path)) {
      handleUnitsPost(path);
      return;
    }
    if (topic::isTz(path)) {
      handleTzPost(path);
      return;
    }
    handleAliasPost(path);
    return;
  }
  if (_server.method() != HTTP_GET) {
    sendStatus(405, "not allowed");
    return;
  }
  if (topic::isLayout(path)) {
    const char* blob = layout_store::get();
    if (blob[0] == '\0') {
      sendStatus(404, "no message");
      return;
    }
    sendCors();
    _server.sendHeader("Cache-Control", "no-store");
    _server.send(200, "application/json", blob);
    return;
  }
  if (topic::isLocation(path)) {
    const char* blob = location_store::get();
    if (blob[0] == '\0') {
      sendStatus(404, "no message");
      return;
    }
    sendCors();
    _server.sendHeader("Cache-Control", "no-store");
    _server.send(200, "application/json", blob);
    return;
  }
  if (topic::isUnits(path)) {
    const char* blob = units_store::get();
    if (blob[0] == '\0') {
      sendStatus(404, "no message");
      return;
    }
    sendCors();
    _server.sendHeader("Cache-Control", "no-store");
    _server.send(200, "application/json", blob);
    return;
  }
  if (topic::isTz(path)) {
    char payload[8];
    int  n = snprintf(payload, sizeof(payload), "%d", tz_store::offsetMinutes());
    if (n < 0 || (size_t)n >= sizeof(payload)) {
      sendStatus(500, "internal error");
      return;
    }
    sendCors();
    _server.sendHeader("Cache-Control", "no-store");
    _server.send(200, "application/json", payload);
    return;
  }
  if (topic::isAlias(path)) {
    const char* name = alias_store::get(path);
    if (name == NULL) {
      sendStatus(404, "no message");
      return;
    }
    FrameBuffer json;
    writeJsonString(json, name);
    sendCors();
    _server.sendHeader("Cache-Control", "no-store");
    _server.send(200, "application/json", String(json.data()));
    return;
  }
  for (uint8_t i = 0; i < SIGNAL_DEVICE_SLOTS; i++) {
    const DeviceSlot* slot = signal_store::slotAt(i);
    if (slot != NULL && strcmp(slot->key, path) == 0) {
      const char* payload = signal_store::latestPayload(*slot);
      if (payload == NULL) break;
      sendCors();
      _server.sendHeader("Cache-Control", "no-store");
      _server.send(200, "application/json", payload);
      return;
    }
  }
  sendStatus(404, "no message");
}

static void handleEvents() {
  WiFiClient client = _server.client();

  char    filters[WEB_UI_SSE_FILTERS][WEB_UI_FILTER_MAX];
  uint8_t count = 0;
  for (int i = 0; i < _server.args(); i++) {
    if (_server.argName(i) != "f") {
      continue;
    }
    String v = _server.arg(i);
    if (count >= WEB_UI_SSE_FILTERS || v.length() >= WEB_UI_FILTER_MAX ||
        !topic::validFilter(v.c_str())) {
      sendStatus(400, "bad filter");
      return;
    }
    strcpy(filters[count++], v.c_str());
  }
  if (count == 0) {
    strcpy(filters[count++], "#");
  }

  reapClosedClients();

  int slot = -1;
  for (int i = 0; i < WEB_UI_SSE_CLIENTS; i++) {
    if (!_sse[i]) {
      slot = i;
      break;
    }
  }
  if (slot < 0) {
    // A peer that vanishes without a FIN holds its slot until a write fails, so
    // drop the longest-attached stream rather than locking a new viewer out.
    slot = 0;
    for (int i = 1; i < WEB_UI_SSE_CLIENTS; i++) {
      if (_sseAttachedAt[i] < _sseAttachedAt[slot]) {
        slot = i;
      }
    }
    releaseSlot(slot);
    Log.notice(F("SSE slots full, evicted slot %d" CR), slot);
  }
  static const char header[] = "HTTP/1.1 200 OK\r\n"
                                "Content-Type: text/event-stream\r\n"
                                "Cache-Control: no-store\r\n"
                                "Access-Control-Allow-Origin: *\r\n"
                                "Connection: keep-alive\r\n"
                                "\r\n"
                                "retry: 3000\r\n\r\n";
  sendFrameOrDrop(client, header, sizeof(header) - 1);
  if (!client.connected()) {
    return;
  }
  _sse[slot] = client;
  _sseAttachedAt[slot] = ++_sseAttachCounter;
  _filterCount[slot] = count;
  for (uint8_t f = 0; f < count; f++) {
    strcpy(_filters[slot][f], filters[f]);
  }
  _replay[slot] = 0;
  Log.notice(F("SSE client attached to slot %d, %d filters" CR), slot, (int)count);
}

// The cursor walks the sub table and then the alias table, so a device heard
// from mid-replay is delivered with its newer payload when the cursor reaches
// it, and one evicted mid-replay is simply not delivered. The sub table now
// has holes like the alias table, so every index is visited and NULLs skip.
static void drainReplay(int i, Frame& frame) {
  for (int sent = 0; sent < REPLAY_PER_LOOP && _replay[i] >= 0; ) {
    int16_t at = _replay[i]++;
    const char* topic = NULL;
    frame.reset();
    if (at < SIGNAL_SUB_TABLE) {
      const DeviceSub* sub = signal_store::subAt((uint8_t)at);
      if (sub == NULL || !sub->used) {
        continue;
      }
      const DeviceSlot* slot = signal_store::slotAt(sub->slotIdx);
      if (slot == NULL || !slot->used) {
        continue;
      }
      topic = slot->key;
      if (!slotWants(i, topic)) {
        continue;
      }
      buildFrame(frame, topic, sub->payload);
    } else if (at < SIGNAL_SUB_TABLE + ALIAS_SLOTS) {
      topic = alias_store::topicAt((uint8_t)(at - SIGNAL_SUB_TABLE));
      if (topic == NULL) {
        continue;
      }
      if (!slotWants(i, topic)) {
        continue;
      }
      buildAliasFrame(frame, topic, alias_store::nameAt((uint8_t)(at - SIGNAL_SUB_TABLE)));
    } else if (at == SIGNAL_SUB_TABLE + ALIAS_SLOTS) {
      const char* blob = layout_store::get();
      if (blob[0] == '\0') {
        continue;
      }
      static char layoutTopic[SIGNAL_KEY_MAX];
      int n = snprintf(layoutTopic, sizeof(layoutTopic), "%s/$layout", signal_store::source());
      if (n < 0 || (size_t)n >= sizeof(layoutTopic)) {
        continue;
      }
      topic = layoutTopic;
      if (!slotWants(i, topic)) {
        continue;
      }
      buildFrame(frame, topic, blob);
    } else if (at == SIGNAL_SUB_TABLE + ALIAS_SLOTS + 1) {
      const char* blob = location_store::get();
      if (blob[0] == '\0') {
        continue;
      }
      static char locationTopic[SIGNAL_KEY_MAX];
      int n = snprintf(locationTopic, sizeof(locationTopic), "%s/$location", signal_store::source());
      if (n < 0 || (size_t)n >= sizeof(locationTopic)) {
        continue;
      }
      topic = locationTopic;
      if (!slotWants(i, topic)) {
        continue;
      }
      buildFrame(frame, topic, blob);
    } else if (at == SIGNAL_SUB_TABLE + ALIAS_SLOTS + 2) {
      char tzPayload[8];
      int  tn = snprintf(tzPayload, sizeof(tzPayload), "%d", tz_store::offsetMinutes());
      if (tn < 0 || (size_t)tn >= sizeof(tzPayload)) {
        continue;
      }
      static char tzTopic[SIGNAL_KEY_MAX];
      int n = snprintf(tzTopic, sizeof(tzTopic), "%s/$tz", signal_store::source());
      if (n < 0 || (size_t)n >= sizeof(tzTopic)) {
        continue;
      }
      topic = tzTopic;
      if (!slotWants(i, topic)) {
        continue;
      }
      buildFrame(frame, topic, tzPayload);
    } else if (at == SIGNAL_SUB_TABLE + ALIAS_SLOTS + 3) {
      const char* blob = units_store::get();
      if (blob[0] == '\0') {
        continue;
      }
      static char unitsTopic[SIGNAL_KEY_MAX];
      int n = snprintf(unitsTopic, sizeof(unitsTopic), "%s/$units", signal_store::source());
      if (n < 0 || (size_t)n >= sizeof(unitsTopic)) {
        continue;
      }
      topic = unitsTopic;
      if (!slotWants(i, topic)) {
        continue;
      }
      buildFrame(frame, topic, blob);
    } else {
      _replay[i] = -1;
      return;
    }
    if (frame.overflowed()) {
      Log.warning(F("SSE replay frame overflow, skipping %s" CR), topic);
      continue;
    }
    if (!socketReadyToWrite(_sse[i])) {
      _replay[i]--; // retry this one next pass rather than losing it
      return;
    }
    sendTo(i, frame);
    sent++;
  }
}

void begin() {
  static const char* HEADER_KEYS[] = {"Origin"};
  _server.collectHeaders(HEADER_KEYS, 1);
  _server.on("/", HTTP_GET, handleRoot);
  _server.on("/events", HTTP_GET, handleEvents);
  _server.on("/$update", HTTP_POST, handleUpdateComplete, handleUpdateUpload);
  _server.on("/$mqtt", HTTP_GET, handleMqttGet);
  _server.on("/$mqtt", HTTP_POST, handleMqttPost);
  _server.on("/$mqtt", HTTP_OPTIONS, handleMqttOptions);
  _server.on("/$mqtt/remove", HTTP_POST, handleMqttRemovePost);
  _server.on("/$mqtt/remove", HTTP_OPTIONS, handleMqttOptions);
  // Topics are arbitrary paths, so every other request is dispatched here.
  _server.onNotFound(handleTopic);
  _server.begin();
  _started = true;
  Log.notice(F("web server listening on port 80" CR));
}

void loop() {
  if (!_started) {
    return;
  }
  // Ahead of the WiFi gate: a drop leaves every slot holding a dead client, and
  // nothing would free them until four more viewers had each evicted one.
  reapClosedClients();
  if (!wifiReady()) {
    return;
  }
  _server.handleClient();
  {
    // The replay carries the layout blob as well as device payloads, so it
    // needs the larger buffer. Static rather than automatic: 4 KB is more than
    // half the loop task's stack.
    static LayoutFrameBuffer replayFrame;
    for (int i = 0; i < WEB_UI_SSE_CLIENTS; i++) {
      if (_sse[i] && _replay[i] >= 0) {
        drainReplay(i, replayFrame);
      }
    }
  }
  if (millis() - _lastKeepalive >= SSE_KEEPALIVE_MS) {
    _lastKeepalive = millis();
    reapClosedClients();
    for (int i = 0; i < WEB_UI_SSE_CLIENTS; i++) {
      if (!_sse[i]) {
        continue;
      }
      if (!socketReadyToWrite(_sse[i])) {
        releaseSlot(i);
        continue;
      }
      static const char keepalive[] = ":keepalive\n\n";
      sendFrameOrDrop(_sse[i], keepalive, sizeof(keepalive) - 1);
    }
  }
}

// index is the topic's raw flat index (a sub-table index, or SIGNAL_SUB_TABLE
// + alias slot), or -1 when it has none (an alias that was just removed).
static void broadcastFrame(const char* topic, int index, const Frame& frame) {
  for (int i = 0; i < WEB_UI_SSE_CLIENTS; i++) {
    if (!_sse[i]) {
      continue;
    }
    // A slot still replaying gets an index its cursor hasn't reached yet from
    // the cursor itself, which reads the live table; one the cursor has
    // already passed is never revisited, so deliver it live instead.
    if (_replay[i] >= 0 && index >= 0 && index >= _replay[i]) {
      continue;
    }
    if (!slotWants(i, topic)) {
      continue;
    }
    sendTo(i, frame);
  }
}

void broadcast(const DeviceSlot& slot) {
  int subIdx = signal_store::latestSubIndex(slot);
  if (subIdx < 0) {
    return;
  }
  FrameBuffer frame;
  buildFrame(frame, slot.key, signal_store::subPayload(subIdx));
  if (frame.overflowed()) {
    Log.warning(F("SSE frame overflow, dropping frame" CR));
    return;
  }
  broadcastFrame(slot.key, subIdx, frame);
}

void broadcastAlias(const char* topic, const char* name) {
  FrameBuffer frame;
  buildAliasFrame(frame, topic, name);
  if (frame.overflowed()) {
    Log.warning(F("SSE alias frame overflow, dropping frame" CR));
    return;
  }
  int aliasIndex = alias_store::indexOf(topic);
  broadcastFrame(topic, aliasIndex < 0 ? -1 : SIGNAL_SUB_TABLE + aliasIndex, frame);
}

void broadcastLayout(const char* blob) {
  char topic[SIGNAL_KEY_MAX];
  int  n = snprintf(topic, sizeof(topic), "%s/$layout", signal_store::source());
  if (n < 0 || (size_t)n >= sizeof(topic)) {
    return;
  }
  // Static for the same reason the replay buffer is: 4 KB does not belong on
  // the loop task's stack, and web_ui only ever runs from loop().
  static LayoutFrameBuffer frame;
  frame.reset();
  buildFrame(frame, topic, blob); // raw-embed: blob is a JSON object, not a quoted string
  if (frame.overflowed()) {
    Log.warning(F("SSE layout frame overflow, dropping frame" CR));
    return;
  }
  broadcastFrame(topic, SIGNAL_SUB_TABLE + ALIAS_SLOTS, frame);
}

void broadcastLocation(const char* blob) {
  char topic[SIGNAL_KEY_MAX];
  int  n = snprintf(topic, sizeof(topic), "%s/$location", signal_store::source());
  if (n < 0 || (size_t)n >= sizeof(topic)) {
    return;
  }
  FrameBuffer frame;
  buildFrame(frame, topic, blob); // raw-embed: blob is a JSON object, not a quoted string
  if (frame.overflowed()) {
    Log.warning(F("SSE location frame overflow, dropping frame" CR));
    return;
  }
  broadcastFrame(topic, SIGNAL_SUB_TABLE + ALIAS_SLOTS + 1, frame);
}

void broadcastUnits(const char* blob) {
  char topic[SIGNAL_KEY_MAX];
  int  n = snprintf(topic, sizeof(topic), "%s/$units", signal_store::source());
  if (n < 0 || (size_t)n >= sizeof(topic)) {
    return;
  }
  FrameBuffer frame;
  buildFrame(frame, topic, blob); // raw-embed: blob is a JSON object, not a quoted string
  if (frame.overflowed()) {
    Log.warning(F("SSE units frame overflow, dropping frame" CR));
    return;
  }
  broadcastFrame(topic, SIGNAL_SUB_TABLE + ALIAS_SLOTS + 3, frame);
}

void broadcastTz(int16_t minutes) {
  char payload[8];
  int  pn = snprintf(payload, sizeof(payload), "%d", minutes);
  if (pn < 0 || (size_t)pn >= sizeof(payload)) {
    return;
  }
  char topic[SIGNAL_KEY_MAX];
  int  n = snprintf(topic, sizeof(topic), "%s/$tz", signal_store::source());
  if (n < 0 || (size_t)n >= sizeof(topic)) {
    return;
  }
  FrameBuffer frame;
  buildFrame(frame, topic, payload); // raw-embed: payload is a JSON number
  if (frame.overflowed()) {
    Log.warning(F("SSE tz frame overflow, dropping frame" CR));
    return;
  }
  broadcastFrame(topic, SIGNAL_SUB_TABLE + ALIAS_SLOTS + 2, frame);
}

} // namespace web_ui
