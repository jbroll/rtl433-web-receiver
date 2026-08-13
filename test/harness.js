const fs = require("fs");
const http = require("http");
const path = require("path");

const ROOT = path.join(__dirname, "..");

// The firmware serves these arrays verbatim, so the tests must read the same
// source rather than a copy that can drift.
function progmem(file, name) {
  const full = path.join(ROOT, file);
  if (!fs.existsSync(full)) return "";
  const src = fs.readFileSync(full, "utf8");
  const re = new RegExp(name + "\\[\\]\\s*PROGMEM\\s*=\\s*R\"rawliteral\\(([\\s\\S]*?)\\)rawliteral\";");
  const m = src.match(re);
  if (!m) throw new Error("no " + name + " literal in " + file);
  return m[1];
}

function page() {
  return progmem("index_html.h", "INDEX_HTML") + progmem("cards_html.h", "CARDS_HTML");
}

function startServer(opts = {}) {
  const started = Date.now();
  const now = () => Date.now() - started;
  const devices = new Map();
  const events = [];
  const streams = new Set();

  function put(payload, meta = {}) {
    const key = payload.model + "/" + (payload.id !== undefined ? payload.id : payload.channel);
    const prev = devices.get(key);
    const rec = {
      key: key,
      model: payload.model,
      rssi: meta.rssi !== undefined ? meta.rssi : -72,
      lastSeen: now(),
      count: meta.count !== undefined ? meta.count : (prev ? prev.count + 1 : 1),
      payload: JSON.stringify(payload),
    };
    devices.set(key, rec);
    events.unshift({ at: rec.lastSeen, payload: rec.payload });
    if (events.length > 40) events.length = 40;
    return rec;
  }

  for (const p of opts.devices || []) put(p);

  const server = http.createServer((req, res) => {
    const url = req.url.split("?")[0];
    if (url === "/") {
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      res.end(page());
      return;
    }
    if (url === "/api/state") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({
        now: now(), total: events.length, dropped: 0,
        devices: [...devices.values()], events: events,
      }));
      return;
    }
    if (url === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      });
      res.write("retry: 3000\n\n");
      streams.add(res);
      req.on("close", () => streams.delete(res));
      return;
    }
    res.writeHead(404).end("not found");
  });

  return new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        url: "http://127.0.0.1:" + server.address().port + "/",
        emit(payload, meta) {
          const rec = put(payload, meta);
          const frame = "event: signal\ndata: " + JSON.stringify({
            at: rec.lastSeen, now: now(), key: rec.key,
            rssi: rec.rssi, count: rec.count, payload: rec.payload,
          }) + "\n\n";
          for (const s of streams) s.write(frame);
        },
        close() {
          for (const s of streams) s.end();
          return new Promise(done => server.close(done));
        },
      });
    });
  });
}

module.exports = { startServer, page };
