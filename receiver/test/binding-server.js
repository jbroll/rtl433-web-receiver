const http = require("http");

const SOURCE = "rtl433-test";
const ALIAS_SUFFIX = "/$alias";
const ALIAS_NAME_MAX = 32;
const LAYOUT_SUFFIX = "/$layout";
const LOCATION_SUFFIX = "/$location";
const UNITS_SUFFIX = "/$units";

function validTopic(topic) {
  if (!topic) return false;
  if (/[+#\s]/.test(topic)) return false;
  return topic.split("/").every(s => s.length > 0);
}

function validFilter(filter) {
  if (!filter || /\s/.test(filter)) return false;
  const segments = filter.split("/");
  return segments.every((segment, i) => {
    if (segment.length === 0) return false;
    if (segment === "#") return i === segments.length - 1;
    if (segment === "+") return true;
    return !segment.includes("#") && !segment.includes("+");
  });
}

function matchFilter(filter, topic) {
  const f = filter.split("/");
  const t = topic.split("/");
  for (let i = 0; i < f.length; i++) {
    if (f[i] === "#") return true;
    if (i >= t.length) return false;
    if (f[i] !== "+" && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}

function startServer(opts = {}) {
  const source = opts.source || SOURCE;
  let build = opts.build || "test";
  // topic -> Map(msgType -> { json, seq })
  const retained = new Map();
  let globalSeq = 0;
  let tzOffset = -240;
  const rainBaselines = new Map();  // topic -> { baseline, day }
  const rainModels = new Set(["Acurite-5n1"]);

  function localDay() {
    const t = Date.now() / 1000;
    if (t < 1700000000) return 0;
    return Math.floor((t + tzOffset * 60) / 86400);
  }

  function applyRainHook(topic, payload) {
    if (!rainModels.has(payload.model)) return;
    if (typeof payload.rain_mm !== "number") return;
    const mm = payload.rain_mm;

    const day = localDay();
    let entry = rainBaselines.get(topic);
    if (!entry || entry.day !== day || mm < entry.baseline) {
      entry = { baseline: mm, day };
      rainBaselines.set(topic, entry);
    }
    payload.rain_today_mm = Math.round((mm - entry.baseline) * 10) / 10;
  }
  const counts = new Map();
  const streams = new Set();

  function topicOf(payload) {
    const id = payload.id !== undefined ? payload.id
             : payload.channel !== undefined ? payload.channel : 0;
    return source + "/" + payload.model + "/" + id;
  }

  function publish(topic, json) {
    let subs = retained.get(topic);
    if (!subs) {
      subs = new Map();
      retained.set(topic, subs);
    }
    const payload = JSON.parse(json);
    const msgType = payload.message_type !== undefined ? String(payload.message_type) : "";
    subs.set(msgType, { json, seq: ++globalSeq });
    const frame = "data: {\"topic\":" + JSON.stringify(topic) + ",\"payload\":" + json + "}\n\n";
    for (const s of streams) {
      if (s.filters.some(f => matchFilter(f, topic))) s.res.write(frame);
    }
  }

  function put(payload, meta = {}) {
    const topic = topicOf(payload);
    const count = meta.count !== undefined ? meta.count : (counts.get(topic) || 0) + 1;
    counts.set(topic, count);
    const stamped = Object.assign({}, payload, {
      time: meta.time !== undefined ? meta.time : new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      rssi: meta.rssi !== undefined ? meta.rssi : -72,
      count: count,
    });
    if (stamped.model === "Receiver") stamped.build = meta.build !== undefined ? meta.build : build;
    applyRainHook(topic, stamped);
    publish(topic, JSON.stringify(stamped));
    return topic;
  }

  publish(source + "/$tz", JSON.stringify(tzOffset));

  for (const p of opts.devices || []) put(p);

  function readBody(req) {
    return new Promise(resolve => {
      let body = "";
      req.on("data", c => { body += c; });
      req.on("end", () => resolve(body));
    });
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "600",
      });
      res.end();
      return;
    }
    const [rawPath, query] = req.url.split("?");
    const path = decodeURIComponent(rawPath);
    if (path === "/" && req.method === "GET") {
      if (!opts.html) {
        res.writeHead(404, { "Content-Type": "text/plain" }).end("no page here");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      res.end(opts.html);
      return;
    }
    if (path === "/events" && req.method === "GET") {
      const params = new URLSearchParams(query || "");
      const filters = params.getAll("f");
      if (filters.length > 4 || filters.some(f => f.length >= 65 || !validFilter(f))) {
        res.writeHead(400).end("bad filter");
        return;
      }
      if (filters.length === 0) filters.push("#");
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      });
      res.write("retry: 15000\n\n");
      const entry = { res: res, filters: filters };
      streams.add(entry);
      req.on("close", () => streams.delete(entry));
      for (const [topic, subs] of retained) {
        if (!filters.some(f => matchFilter(f, topic))) continue;
        const entries = [...subs.values()].sort((a, b) => a.seq - b.seq);
        for (const e of entries) {
          res.write("data: {\"topic\":" + JSON.stringify(topic) + ",\"payload\":" + e.json + "}\n\n");
        }
      }
      return;
    }
    const topic = path.replace(/^\//, "");
    if (!validTopic(topic)) {
      res.writeHead(400).end("malformed topic");
      return;
    }
    if (req.method === "POST") {
      const origin = req.headers.origin;
      if (origin && origin.replace(/^[a-z]+:\/\//, "") !== req.headers.host) {
        res.writeHead(403).end("off-origin");
        return;
      }
      const isLayout = topic.endsWith(LAYOUT_SUFFIX) || topic === "$layout";
      if (isLayout) {
        if (!topic.startsWith(source + "/") && topic !== "$layout") {
          res.writeHead(405).end("not allowed");
          return;
        }
        const body = await readBody(req);
        let value;
        try { value = JSON.parse(body); } catch (e) { value = undefined; }
        if (value === undefined || typeof value !== "object" || value === null || Array.isArray(value)) {
          res.writeHead(400).end("body must be a JSON object");
          return;
        }
        publish(source + LAYOUT_SUFFIX, JSON.stringify(value));
        res.writeHead(204).end();
        return;
      }
      const isLocation = topic.endsWith(LOCATION_SUFFIX) || topic === "$location";
      if (isLocation) {
        if (!topic.startsWith(source + "/") && topic !== "$location") {
          res.writeHead(405).end("not allowed");
          return;
        }
        const body = await readBody(req);
        let value;
        try { value = JSON.parse(body); } catch (e) { value = undefined; }
        if (value === undefined || typeof value !== "object" || value === null || Array.isArray(value)) {
          res.writeHead(400).end("body must be a JSON object");
          return;
        }
        publish(source + LOCATION_SUFFIX, JSON.stringify(value));
        res.writeHead(204).end();
        return;
      }
      const isUnits = topic.endsWith(UNITS_SUFFIX) || topic === "$units";
      if (isUnits) {
        if (!topic.startsWith(source + "/") && topic !== "$units") {
          res.writeHead(405).end("not allowed");
          return;
        }
        const body = await readBody(req);
        let value;
        try { value = JSON.parse(body); } catch (e) { value = undefined; }
        if (value === undefined || typeof value !== "object" || value === null || Array.isArray(value)) {
          res.writeHead(400).end("body must be a JSON object");
          return;
        }
        publish(source + UNITS_SUFFIX, JSON.stringify(value));
        res.writeHead(204).end();
        return;
      }
      const isTz = topic.endsWith("/$tz") || topic === "$tz";
      if (isTz) {
        if (!topic.startsWith(source + "/") && topic !== "$tz") {
          res.writeHead(405).end("not allowed");
          return;
        }
        const body = await readBody(req);
        let value;
        try { value = JSON.parse(body); } catch (e) { value = undefined; }
        if (typeof value !== "number" || !Number.isFinite(value)) {
          res.writeHead(400).end("body must be a JSON number");
          return;
        }
        tzOffset = Math.round(value);
        publish(source + "/$tz", JSON.stringify(tzOffset));
        res.writeHead(204).end();
        return;
      }
      const isAlias = topic.endsWith(ALIAS_SUFFIX);
      if (!isAlias || !topic.startsWith(source + "/")) {
        res.writeHead(405).end("not allowed");
        return;
      }
      const body = await readBody(req);
      let value;
      if (body.length === 0) {
        value = "";
      } else {
        try { value = JSON.parse(body); } catch (e) { value = undefined; }
      }
      if (typeof value !== "string") {
        res.writeHead(400).end("body must be a JSON string");
        return;
      }
      if (value.length >= ALIAS_NAME_MAX) {
        res.writeHead(400).end("alias name too long");
        return;
      }
      publish(topic, JSON.stringify(value));
      if (value === "") retained.delete(topic);
      res.writeHead(204).end();
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405).end("not allowed");
      return;
    }
    const subs = retained.get(topic);
    let json;
    if (subs) {
      let latest = null;
      for (const e of subs.values()) {
        if (!latest || e.seq > latest.seq) latest = e;
      }
      json = latest ? latest.json : undefined;
    }
    if (json === undefined) {
      res.writeHead(404).end("no message");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(json);
  });

  const sockets = new Set();
  server.on("connection", s => { sockets.add(s); s.on("close", () => sockets.delete(s)); });

  function request(method, topic, body) {
    return new Promise(resolve => {
      const req = http.request({
        host: "127.0.0.1", port: server.address().port,
        path: "/" + topic.split("/").map(encodeURIComponent).join("/"), method: method,
        headers: body === undefined ? {} : { "Content-Type": "application/json" },
      }, res => {
        let out = "";
        res.setEncoding("utf8");
        res.on("data", c => { out += c; });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: out }));
      });
      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  return new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        url: "http://127.0.0.1:" + server.address().port + "/",
        source: source,
        emit(payload, meta) { return put(payload, meta); },
        emitAlias(deviceTopic, name) { publish(deviceTopic + ALIAS_SUFFIX, JSON.stringify(name)); },
        emitLayout(template) { publish(source + LAYOUT_SUFFIX, JSON.stringify(template)); },
        emitLocation(loc) { publish(source + LOCATION_SUFFIX, JSON.stringify(loc)); },
        get(topic) { return request("GET", topic); },
        post(topic, body) { return request("POST", topic, body === undefined ? "" : body); },
        options(topic) { return request("OPTIONS", topic); },
        setBuild(id) { build = id; },
        tzOffset() { return tzOffset; },
        close() {
          for (const s of streams) s.res.end();
          // close() waits out every idle keep-alive socket, and the page's
          // EventSource keeps reconnecting into that wait.
          for (const s of sockets) s.destroy();
          return new Promise(done => server.close(done));
        },
      });
    });
  });
}

module.exports = { startServer, matchFilter, validFilter, validTopic };
