import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { startTestBridge } from "../../bridge/test/helpers/dashboard-fixture.js";
import { POINTS, FORECAST, STATIONS, OBSERVATION } from "./fixtures-nws.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, "..", "dist", "index.html");
const SOURCE = "rtl433-test";
const ALIAS_SUFFIX = "/$alias";
const LAYOUT_SUFFIX = "/$layout";
const LOCATION_SUFFIX = "/$location";
const UNITS_SUFFIX = "/$units";

// Built once per run: every test loads the same artifact the firmware embeds.
let html = null;
export function page() {
  if (html === null) {
    execFileSync("node", [path.join(HERE, "..", "build.js")], { stdio: "inherit" });
    html = fs.readFileSync(DIST, "utf8");
  }
  return html;
}

export async function startServer(opts = {}) {
  const source = opts.source || SOURCE;
  let build = opts.build || "test";
  let tzOffsetValue = -240;
  const counts = new Map();
  const rainBaselines = new Map(); // topic -> { baseline, day }
  const rainModels = new Set(["Acurite-5n1"]);

  function localDay() {
    const t = Date.now() / 1000;
    if (t < 1700000000) return 0;
    return Math.floor((t + tzOffsetValue * 60) / 86400);
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

  function topicOf(payload) {
    const id = payload.id !== undefined ? payload.id
             : payload.channel !== undefined ? payload.channel : 0;
    return source + "/" + payload.model + "/" + id;
  }

  const fixture = await startTestBridge({ authToken: opts.authToken });

  async function emit(payload, meta = {}) {
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
    await fixture.publish(topic, JSON.stringify(stamped));
    return topic;
  }

  async function emitAlias(deviceTopic, name) {
    await fixture.publish(deviceTopic + ALIAS_SUFFIX, JSON.stringify(name));
  }

  async function emitLayout(template) {
    await fixture.publish(source + LAYOUT_SUFFIX, JSON.stringify(template));
  }

  async function emitLocation(loc) {
    await fixture.publish(source + LOCATION_SUFFIX, JSON.stringify(loc));
  }

  async function emitUnits(u) {
    await fixture.publish(source + UNITS_SUFFIX, JSON.stringify(u));
  }

  // The receiver's $tz is never unset -- it defaults to -240 and replays on
  // every connect, so the model retains one from the start too.
  await fixture.publish(source + "/$tz", JSON.stringify(tzOffsetValue));

  for (const p of opts.devices || []) await emit(p);

  const body = page();
  const outer = http.createServer(async (req, res) => {
    const pathname = req.url.split("?")[0];
    if (req.method === "GET" && pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      res.end(body);
      return;
    }
    if (req.method === "POST") {
      let topic;
      try {
        topic = decodeURIComponent(pathname.slice(1));
      } catch {
        res.writeHead(400).end("malformed topic");
        return;
      }
      const last = topic.split("/").pop();
      if (last === "$tz" || last === "$alias" || last === "$layout" || last === "$location"
          || last === "$units") {
        try {
          await postToReceiver(req, res, topic, last);
        } catch (err) {
          console.error(err);
          try {
            res.writeHead(502).end();
          } catch {
            // headers already sent or the socket is already gone
          }
        }
        return;
      }
    }
    proxyToFixture(req, res, fixture.httpPort);
  });

  // Five POST paths the firmware's own binding owns, which the bridge does
  // not implement: MQTT reserves a leading '$', so a bare "$tz", "$layout",
  // "$location", or "$units" publish never comes back on the bridge's '#'
  // subscription and its POST answers 503 — the real receiver sidesteps this
  // by always canonicalizing to <source>/$tz, <source>/$layout,
  // <source>/$location, or <source>/$units before broadcasting, regardless of
  // what path was POSTed, so this does the same before handing off to the
  // bridge; and an empty alias means delete the retained message, which the
  // bridge stores as the string it is. All five are kept here rather than in
  // the bridge because all five are what receiver/test/binding-server.js does.
  async function postToReceiver(req, res, topic, last) {
    const raw = await readBody(req);
    let value;
    try {
      value = JSON.parse(raw.toString("utf8"));
    } catch {
      value = undefined;
    }
    if (last === "$tz") {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        res.writeHead(400).end("body must be a JSON number");
        return;
      }
      tzOffsetValue = Math.round(value);
      await fixture.publish(source + "/$tz", JSON.stringify(tzOffsetValue));
      res.writeHead(204).end();
      return;
    }
    if (last === "$layout") {
      if (value === undefined || typeof value !== "object" || value === null || Array.isArray(value)) {
        res.writeHead(400).end("body must be a JSON object");
        return;
      }
      // Unlike $tz/$location/$units above, $layout's write carries a bearer
      // token (auth.spec.js drives it against a token-protected bridge), so
      // it goes through the bridge's own auth-gated POST instead of writing
      // straight to the mock broker -- a missing/wrong token must 401 here
      // the same way it does for every other topic write.
      req.url = "/" + [source, "$layout"].map(encodeURIComponent).join("/");
      proxyToFixture(req, res, fixture.httpPort, raw);
      return;
    }
    if (last === "$location" || last === "$units") {
      if (value === undefined || typeof value !== "object" || value === null || Array.isArray(value)) {
        res.writeHead(400).end("body must be a JSON object");
        return;
      }
      const suffix = last === "$units" ? UNITS_SUFFIX : LOCATION_SUFFIX;
      await fixture.publish(source + suffix, JSON.stringify(value));
      res.writeHead(204).end();
      return;
    }
    if (value !== "") {
      proxyToFixture(req, res, fixture.httpPort, raw);
      return;
    }
    // The empty frame still goes out, so a page holding the old alias drops
    // it, and the retained message is gone for the next reader.
    await fixture.publish(topic, "");
    res.writeHead(204).end();
  }

  const sockets = new Set();
  outer.on("connection", s => { sockets.add(s); s.on("close", () => sockets.delete(s)); });

  await new Promise(resolve => outer.listen(0, "127.0.0.1", resolve));
  const { port } = outer.address();

  return {
    url: "http://127.0.0.1:" + port + "/",
    source: source,
    emit(payload, meta) { return emit(payload, meta); },
    emitAlias(deviceTopic, name) { return emitAlias(deviceTopic, name); },
    emitLayout(template) { return emitLayout(template); },
    emitLocation(loc) { return emitLocation(loc); },
    emitUnits(u) { return emitUnits(u); },
    get(topic) { return fixture.get(topic); },
    setBuild(id) { build = id; },
    tzOffset() { return tzOffsetValue; },
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise(done => outer.close(done));
      await fixture.close();
    },
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// The dashboard's own origin doubles as its implicit "self source" — most
// specs page.goto(server.url) directly and expect that same origin to serve
// both the built HTML and the live data. The real bridge only speaks the
// data side, so everything but GET / is streamed through to it unbuffered
// (this is what makes /events SSE work through the proxy too). `body` is given
// only when the request was already read to decide what to do with it, and
// there is nothing left on the socket to pipe.
function proxyToFixture(req, res, targetPort, body) {
  const proxyReq = http.request(
    { host: "127.0.0.1", port: targetPort, path: req.url, method: req.method, headers: req.headers },
    proxyRes => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );
  proxyReq.on("error", () => {
    try {
      res.writeHead(502).end();
    } catch {
      // headers already sent or the socket is already gone
    }
  });
  res.on("close", () => proxyReq.destroy());
  if (body === undefined) req.pipe(proxyReq);
  else proxyReq.end(body);
}

export function nwsJson(body, status = 200) {
  return { status, contentType: "application/geo+json", body: JSON.stringify(body) };
}

// A 1x1 transparent png, so no tile request ever leaves the machine.
const TILE_PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64");

// The settings pane always renders its map (src/location.jsx), regardless of
// whether a location is set, so any test that visits it fetches real OSM
// tiles unless this is routed too.
export async function routeTiles(page) {
  await page.route("**/tile.openstreetmap.org/**", r =>
    r.fulfill({ status: 200, contentType: "image/png", body: TILE_PIXEL }));
}

// Every spec that sets a location makes the dashboard fetch api.weather.gov,
// so every one of them needs this route installed or the test hits the live
// service. Answers by path so a test can count exactly which endpoints were
// reached; `over` fulfills specific paths differently. Returns the array of
// paths seen, appended to as requests arrive.
export async function routeWeather(page, over = {}) {
  const seen = [];
  await page.route("**/api.weather.gov/**", r => {
    const path = new URL(r.request().url()).pathname;
    seen.push(path);
    if (over[path]) return r.fulfill(over[path]);
    if (path.startsWith("/points/")) return r.fulfill(nwsJson(POINTS));
    if (path.endsWith("/stations")) return r.fulfill(nwsJson(STATIONS));
    if (path.endsWith("/forecast")) return r.fulfill(nwsJson(FORECAST));
    if (path.endsWith("/observations/latest")) return r.fulfill(nwsJson(OBSERVATION));
    return r.fulfill(nwsJson({}, 404));
  });
  return seen;
}

// Serves the bundle and nothing else. A dashboard with no configured sources
// reads the origin it was served from, so this doubles as that origin's source
// when `origin` is given.
export function startPage(opts = {}) {
  const body = page();
  const server = http.createServer((req, res) => {
    if (req.url.split("?")[0] !== "/") {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    res.end(body);
  });
  const sockets = new Set();
  server.on("connection", s => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  return new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        url: "http://127.0.0.1:" + server.address().port + "/",
        close() {
          for (const s of sockets) s.destroy();
          return new Promise(done => server.close(done));
        },
      });
    });
  });
}
