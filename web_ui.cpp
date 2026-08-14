#include "web_ui.h"

#include <ArduinoJson.h>
#include <ArduinoLog.h>
#include <WebServer.h>
#include <WiFi.h>
#include <errno.h>
#include <lwip/sockets.h>

#include "alias_store.h"
#include "cards_html.h"
#include "index_html.h"
#include "signal_store.h"
#include "topic.h"

extern bool wifiReady();

#ifndef BUILD_ID
#  define BUILD_ID "dev"
#endif

namespace web_ui {

static WebServer _server(80);
static bool      _started = false;

#define WEB_UI_SSE_CLIENTS 4
#define SSE_KEEPALIVE_MS   15000

static WiFiClient    _sse[WEB_UI_SSE_CLIENTS];
static uint32_t      _sseAttachedAt[WEB_UI_SSE_CLIENTS] = {0};
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

static void reapClosedClients() {
  for (int i = 0; i < WEB_UI_SSE_CLIENTS; i++) {
    if (_sse[i] && peerClosed(_sse[i])) {
      _sse[i].stop();
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

// Assembles a whole SSE frame so broadcast() sends it in one call, and flags
// overflow rather than clamping, so a truncated frame is never put on the wire.
class FrameBuffer : public Print {
 public:
  size_t write(uint8_t b) override { return write(&b, 1); }

  size_t write(const uint8_t* data, size_t len) override {
    size_t n = min(len, sizeof(_buf) - 1 - _len);
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

 private:
  // Frame text including the telemetry marker, two millis() values, rssi,
  // count, and a key and payload that both double under writeJsonString's
  // escaping, plus a byte of headroom.
  // Zero-initialized so the untouched byte past the last write is always the
  // null terminator data() promises.
  char _buf[80 + 10 + 10 + (2 * (SIGNAL_KEY_MAX - 1) + 2) + 11 + 10 +
            (2 * SIGNAL_PAYLOAD_MAX + 2) + 1] = {};
  size_t _len      = 0;
  bool   _overflow = false;
};

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

static void streamProgmem(Print& out, const char* text) {
  size_t total = strlen_P(text);
  char   buf[256];
  for (size_t off = 0; off < total; off += sizeof(buf)) {
    size_t n = min(sizeof(buf), total - off);
    memcpy_P(buf, text + off, n);
    out.write(reinterpret_cast<const uint8_t*>(buf), n);
  }
}

static void handleRoot() {
  WiFiClient client = _server.client();
  _server.setContentLength(CONTENT_LENGTH_UNKNOWN);
  _server.sendHeader("Cache-Control", "no-store");
  _server.send(200, "text/html", "");

  ChunkedResponse out(_server, client);
  streamProgmem(out, INDEX_HTML);
  streamProgmem(out, CARDS_HTML);
  out.finish();
}

static void sendStatus(int code, const char* body) {
  _server.sendHeader("Cache-Control", "no-store");
  _server.send(code, "text/plain", body);
}

static void handleAliasPost(const char* path) {
  const char* src = signal_store::source();
  size_t      srcLen = strlen(src);
  bool        ownSource = strncmp(path, src, srcLen) == 0 && path[srcLen] == '/';
  if (!topic::isAlias(path) || !ownSource) {
    sendStatus(405, "not allowed");
    return;
  }
  String body = _server.arg("plain");
  JsonDocument doc;
  if (deserializeJson(doc, body) != DeserializationError::Ok || !doc.is<const char*>()) {
    sendStatus(400, "body must be a JSON string");
    return;
  }
  const char* name = doc.as<const char*>();
  if (*name == '\0') {
    alias_store::remove(path);
  } else if (!alias_store::set(path, name)) {
    sendStatus(503, "alias store full");
    return;
  }
  web_ui::broadcastAlias(path, name);
  _server.sendHeader("Cache-Control", "no-store");
  _server.send(204, "text/plain", "");
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
  if (_server.method() == HTTP_POST) {
    handleAliasPost(path);
    return;
  }
  if (_server.method() != HTTP_GET) {
    sendStatus(405, "not allowed");
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
    _server.sendHeader("Cache-Control", "no-store");
    _server.send(200, "application/json", String(json.data()));
    return;
  }
  for (uint8_t i = 0; i < SIGNAL_DEVICE_SLOTS; i++) {
    const DeviceSlot* slot = signal_store::slotAt(i);
    if (slot != NULL && strcmp(slot->key, path) == 0) {
      _server.sendHeader("Cache-Control", "no-store");
      _server.send(200, "application/json", slot->payload);
      return;
    }
  }
  sendStatus(404, "no message");
}

static void handleEvents() {
  WiFiClient client = _server.client();

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
    _sse[slot].stop();
    Log.notice(F("SSE slots full, evicted slot %d" CR), slot);
  }
  static const char header[] = "HTTP/1.1 200 OK\r\n"
                                "Content-Type: text/event-stream\r\n"
                                "Cache-Control: no-store\r\n"
                                "Connection: keep-alive\r\n"
                                "\r\n"
                                "retry: 3000\r\n\r\n";
  sendFrameOrDrop(client, header, sizeof(header) - 1);
  if (!client.connected()) {
    return;
  }
  _sse[slot] = client;
  _sseAttachedAt[slot] = ++_sseAttachCounter;
  Log.notice(F("SSE client attached to slot %d" CR), slot);
}

void begin() {
  _server.on("/", HTTP_GET, handleRoot);
  _server.on("/events", HTTP_GET, handleEvents);
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
  if (millis() - _lastKeepalive >= SSE_KEEPALIVE_MS) {
    _lastKeepalive = millis();
    reapClosedClients();
    for (int i = 0; i < WEB_UI_SSE_CLIENTS; i++) {
      if (!_sse[i]) {
        continue;
      }
      if (!socketReadyToWrite(_sse[i])) {
        _sse[i].stop();
        continue;
      }
      static const char keepalive[] = ":keepalive\n\n";
      sendFrameOrDrop(_sse[i], keepalive, sizeof(keepalive) - 1);
    }
  }
}

void broadcast(const DeviceSlot& slot, bool isDecode) {
  unsigned long now = millis();
  FrameBuffer   frame;
  frame.print("event: signal\ndata: {\"at\":");
  frame.print(slot.lastSeen);
  frame.print(",\"now\":");
  frame.print(now);
  frame.print(",\"key\":");
  writeJsonString(frame, slot.key);
  frame.print(",\"count\":");
  frame.print(slot.count);
  frame.print(",\"payload\":");
  writeJsonString(frame, slot.payload);
  if (!isDecode) {
    frame.print(",\"log\":0");
  }
  frame.print("}\n\n");

  if (frame.overflowed()) {
    Log.warning(F("SSE frame overflow, dropping frame" CR));
    return;
  }

  for (int i = 0; i < WEB_UI_SSE_CLIENTS; i++) {
    WiFiClient& c = _sse[i];
    if (!c) {
      continue;
    }
    if (!socketReadyToWrite(c)) {
      Log.warning(F("SSE slot %d not ready, dropping" CR), i);
      c.stop();
      continue;
    }
    sendFrameOrDrop(c, frame.data(), frame.length());
  }
}

void broadcastAlias(const char* topic, const char* name) {
  (void)topic;
  (void)name;
}

} // namespace web_ui
