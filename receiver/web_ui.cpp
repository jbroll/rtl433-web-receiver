#include "web_ui.h"

#include <ArduinoJson.h>
#include <ArduinoLog.h>
#include <WebServer.h>
#include <WiFi.h>
#include <errno.h>
#include <lwip/sockets.h>

#include "alias_store.h"
#include "dashboard_html.h"
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

  void reset() {
    _len = 0;
    _overflow = false;
    _buf[0] = '\0';
  }

 private:
  // "data: {"topic":"","payload":}\n\n" plus a key, plus a payload that is
  // embedded raw for a device and escaped for an alias, where escaping can
  // double it.
  // Zero-initialized so the untouched byte past the last write is always the
  // null terminator data() promises.
  char _buf[64 + SIGNAL_KEY_MAX + (2 * SIGNAL_PAYLOAD_MAX + 2) + 1] = {};
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
static void buildFrame(FrameBuffer& frame, const char* topic, const char* payload) {
  frame.print("data: {\"topic\":");
  writeJsonString(frame, topic);
  frame.print(",\"payload\":");
  frame.print(payload);
  frame.print("}\n\n");
}

// alias frame: payload is a quoted string (escaped inline)
static void buildAliasFrame(FrameBuffer& frame, const char* topic, const char* name) {
  frame.print("data: {\"topic\":");
  writeJsonString(frame, topic);
  frame.print(",\"payload\":");
  writeJsonString(frame, name);
  frame.print("}\n\n");
}

static void sendTo(int i, const FrameBuffer& frame) {
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

// The dashboard is served from a different origin than any receiver it reads,
// and there is no authentication here for an origin check to protect.
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
  sendCors();
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
  if (_server.method() == HTTP_OPTIONS) {
    sendCors();
    _server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    _server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
    _server.sendHeader("Access-Control-Max-Age", "600");
    _server.send(204, "text/plain", "");
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
static void drainReplay(int i, FrameBuffer& frame) {
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
  {
    FrameBuffer replayFrame;
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

// index is the topic's raw flat index (a sub-table index, or SIGNAL_DEVICE_SLOTS
// + alias slot), or -1 when it has none (an alias that was just removed).
static void broadcastFrame(const char* topic, int index, const FrameBuffer& frame) {
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

} // namespace web_ui
