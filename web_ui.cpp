#include "web_ui.h"

#include <ArduinoLog.h>
#include <WebServer.h>
#include <WiFi.h>
#include <errno.h>
#include <lwip/sockets.h>

#include "index_html.h"
#include "signal_store.h"

extern bool wifiReady();

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
  // Frame text, two millis() values, rssi, count, and a key and payload that
  // both double under writeJsonString's escaping, plus a byte of headroom.
  char _buf[71 + 10 + 10 + (2 * (SIGNAL_KEY_MAX - 1) + 2) + 11 + 10 +
            (2 * SIGNAL_PAYLOAD_MAX + 2) + 1];
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

static void handleRoot() {
  WiFiClient client = _server.client();
  _server.setContentLength(CONTENT_LENGTH_UNKNOWN);
  _server.sendHeader("Cache-Control", "no-store");
  _server.send(200, "text/html", "");

  ChunkedResponse out(_server, client);
  size_t          total = strlen_P(INDEX_HTML);
  char            buf[256];
  for (size_t off = 0; off < total; off += sizeof(buf)) {
    size_t n = min(sizeof(buf), total - off);
    memcpy_P(buf, INDEX_HTML + off, n);
    out.write(reinterpret_cast<const uint8_t*>(buf), n);
  }
  out.finish();
}

static void handleState() {
  WiFiClient client = _server.client();
  _server.setContentLength(CONTENT_LENGTH_UNKNOWN);
  _server.sendHeader("Cache-Control", "no-store");
  _server.send(200, "application/json", "");

  ChunkedResponse out(_server, client);

  char head[96];
  snprintf(head, sizeof(head), "{\"now\":%lu,\"total\":%lu,\"dropped\":%lu,\"devices\":[",
           millis(), (unsigned long)signal_store::totalRecorded(),
           (unsigned long)signal_store::droppedCount());
  out.print(head);

  uint8_t devices = signal_store::deviceCount();
  for (uint8_t i = 0; i < devices; i++) {
    const DeviceSlot& d = signal_store::device(i);
    if (i) {
      out.print(',');
    }
    out.print("{\"key\":");
    writeJsonString(out, d.key);
    out.print(",\"model\":");
    writeJsonString(out, d.model);
    char nums[80];
    snprintf(nums, sizeof(nums), ",\"rssi\":%d,\"lastSeen\":%lu,\"count\":%lu,\"payload\":",
             d.rssi, d.lastSeen, (unsigned long)d.count);
    out.print(nums);
    writeJsonString(out, d.payload);
    out.print('}');
  }

  out.print("],\"events\":[");
  uint8_t events = signal_store::eventCount();
  for (uint8_t i = 0; i < events; i++) {
    const SignalEvent& e = signal_store::event(i);
    if (i) {
      out.print(',');
    }
    char at[40];
    snprintf(at, sizeof(at), "{\"at\":%lu,\"payload\":", e.at);
    out.print(at);
    writeJsonString(out, e.payload);
    out.print('}');
  }
  out.print("]}");
  out.finish();
}

static void handleStatus() {
  if (!_server.client().connected()) {
    return;
  }
  char body[224];
  snprintf(body, sizeof(body),
           "{\"uptime\":%lu,\"heap\":%lu,\"rssi\":%d,\"ip\":\"%s\",\"total\":%lu,"
           "\"dropped\":%lu}",
           millis() / 1000, (unsigned long)ESP.getFreeHeap(),
           wifiReady() ? WiFi.RSSI() : 0,
           wifiReady() ? WiFi.localIP().toString().c_str() : "",
           (unsigned long)signal_store::totalRecorded(),
           (unsigned long)signal_store::droppedCount());
  _server.sendHeader("Cache-Control", "no-store");
  _server.send(200, "application/json", body);
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
  _server.on("/api/state", HTTP_GET, handleState);
  _server.on("/api/status", HTTP_GET, handleStatus);
  _server.on("/events", HTTP_GET, handleEvents);
  _server.onNotFound([]() { _server.send(404, "text/plain", "not found"); });
  _server.begin();
  _started = true;
  Log.notice(F("web server listening on port 80" CR));
}

void loop() {
  if (!_started || !wifiReady()) {
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

void broadcast(const DeviceSlot& slot) {
  unsigned long now = millis();
  FrameBuffer   frame;
  frame.print("event: signal\ndata: {\"at\":");
  frame.print(slot.lastSeen);
  frame.print(",\"now\":");
  frame.print(now);
  frame.print(",\"key\":");
  writeJsonString(frame, slot.key);
  frame.print(",\"rssi\":");
  frame.print(slot.rssi);
  frame.print(",\"count\":");
  frame.print(slot.count);
  frame.print(",\"payload\":");
  writeJsonString(frame, slot.payload);
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

} // namespace web_ui
