#pragma once

#include <Arduino.h>

static const char INDEX_HTML[] PROGMEM = R"rawliteral(
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>rtl_433 receiver</title>
<style>
:root { color-scheme: light dark; --line:#8883; }
body { margin:0; font:14px/1.4 system-ui,sans-serif; }
header { display:flex; gap:1rem; align-items:baseline; padding:.6rem 1rem; border-bottom:1px solid var(--line); }
h1 { font-size:1rem; margin:0; font-weight:600; }
#status { font-size:.8rem; opacity:.7; margin-left:auto; }
nav button { font:inherit; padding:.3rem .8rem; border:1px solid var(--line); background:none; color:inherit; cursor:pointer; }
nav button[aria-selected=true] { background:#8882; font-weight:600; }
table { border-collapse:collapse; width:100%; }
th,td { text-align:left; padding:.35rem .6rem; border-bottom:1px solid var(--line); vertical-align:top; }
th { font-weight:600; font-size:.8rem; opacity:.7; }
td.num { text-align:right; font-variant-numeric:tabular-nums; }
tr.flash { animation:flash 1s ease-out; }
@keyframes flash { from { background:rgba(255,215,0,.5); } to { background:transparent; } }
#log { font-family:ui-monospace,monospace; font-size:.8rem; }
#log td { white-space:pre-wrap; word-break:break-all; }
section[hidden] { display:none; }
</style>
</head>
<body>
<header>
  <h1>rtl_433</h1>
  <nav>
    <button id="tab-devices" aria-selected="true">Devices</button>
    <button id="tab-log" aria-selected="false">Log</button>
  </nav>
  <span id="status">connecting</span>
</header>
<section id="view-devices"><table>
<thead><tr><th>Model</th><th>ID</th><th>Reading</th><th class="num">RSSI</th><th class="num">Msgs</th><th class="num">Age</th></tr></thead>
<tbody id="devices"></tbody>
</table></section>
<section id="view-log" hidden><table id="log"><tbody id="logrows"></tbody></table></section>
<script>
// Everything rtl_433 adds around the actual sensor readings.
const META = new Set(["model", "id", "channel", "protocol", "rssi", "duration",
                      "mic", "message_type", "sequence_num", "time"]);
const LOG_MAX = 200;
const DEVICE_MAX = 24;
const devices = new Map();
let logRows = [];
let offset = 0;
let refreshSeq = 0;

function parse(raw) { try { return JSON.parse(raw); } catch (e) { return null; } }

function readings(obj) {
  const out = {};
  if (obj) for (const k of Object.keys(obj)) if (!META.has(k)) out[k] = obj[k];
  return out;
}

// The Acurite 5n1 splits its readings across alternating message types, so keep
// what earlier messages reported instead of showing only the latest half.
function merged(prev, obj) {
  return Object.assign({}, prev ? prev.merged : {}, readings(obj));
}

function reading(rec) {
  return Object.keys(rec.merged).map(k => k + ": " + rec.merged[k]).join("  ");
}

function ageText(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m" + (s % 60) + "s";
  return Math.floor(s / 3600) + "h" + Math.floor((s % 3600) / 60) + "m";
}

function trim() {
  if (devices.size <= DEVICE_MAX) return;
  const stale = [...devices.values()].sort((a, b) => b.seenAt - a.seenAt).slice(DEVICE_MAX);
  for (const d of stale) devices.delete(d.key);
}

function upsert(rec, flash) {
  const prev = devices.get(rec.key);
  rec.merged = merged(prev, rec.obj);
  devices.set(rec.key, rec);
  if (flash) rec.flashUntil = Date.now() + 1000;
  else if (prev) rec.flashUntil = prev.flashUntil;
  trim();
  renderDevices();
}

function renderDevices() {
  const rows = [...devices.values()].sort((a, b) => b.seenAt - a.seenAt);
  const tbody = document.getElementById("devices");
  tbody.replaceChildren(...rows.map(r => {
    const tr = document.createElement("tr");
    if (r.flashUntil > Date.now()) tr.className = "flash";
    const obj = r.obj;
    const cells = [
      obj && obj.model ? obj.model : r.key,
      obj && obj.id !== undefined ? obj.id : (obj && obj.channel !== undefined ? "ch" + obj.channel : ""),
      reading(r),
      r.rssi === undefined ? "" : r.rssi,
      r.count === undefined ? "" : r.count,
      ageText(Date.now() - r.seenAt)
    ];
    cells.forEach((v, i) => {
      const td = document.createElement("td");
      if (i >= 3) td.className = "num";
      td.textContent = v;
      tr.appendChild(td);
    });
    return tr;
  }));
}

function addLog(at, raw) {
  logRows.unshift({ at: at, raw: raw });
  if (logRows.length > LOG_MAX) logRows.length = LOG_MAX;
  renderLog();
}

function renderLog() {
  const tbody = document.getElementById("logrows");
  tbody.replaceChildren(...logRows.map(e => {
    const tr = document.createElement("tr");
    const t = document.createElement("td");
    t.textContent = new Date(e.at + offset).toLocaleTimeString();
    t.style.whiteSpace = "nowrap";
    const p = document.createElement("td");
    p.textContent = e.raw;
    tr.append(t, p);
    return tr;
  }));
}

async function refresh() {
  const seq = ++refreshSeq;
  let state;
  try {
    state = await (await fetch("/api/state", { cache: "no-store" })).json();
  } catch (e) {
    // The device aborts a response it cannot write immediately; without a retry
    // one failed fetch would leave the page blank until the next reconnect.
    setTimeout(() => { if (seq === refreshSeq) refresh(); }, 3000);
    return;
  }
  if (seq !== refreshSeq) return; // a newer refresh started meanwhile; this response is stale
  offset = Date.now() - state.now;
  const seen = new Set();
  for (const d of state.devices) {
    seen.add(d.key);
    const obj = parse(d.payload);
    const snap = { key: d.key, obj: obj, raw: d.payload, rssi: d.rssi,
                   count: d.count, seenAt: d.lastSeen + offset, at: d.lastSeen };
    const prev = devices.get(d.key);
    snap.merged = merged(prev, obj);
    // Compare device millis(), not seenAt: offset is recomputed per fetch, so
    // a slow response can skew it past an already-applied live update.
    if (!prev || prev.at <= snap.at) devices.set(d.key, snap);
  }
  // An entry the snapshot omits may be a decode that landed after the server
  // serialized it, so only drop entries the server could already have seen.
  for (const [key, prev] of [...devices]) {
    if (!seen.has(key) && prev.at <= state.now) devices.delete(key);
  }
  trim();
  logRows = state.events.map(e => ({ at: e.at, raw: e.payload }));
  if (logRows.length > LOG_MAX) logRows.length = LOG_MAX;
  renderDevices();
  renderLog();
}

function connect() {
  let opened = false;
  const es = new EventSource("/events");
  es.onopen = () => {
    document.getElementById("status").textContent = "live";
    if (opened) refresh(); // a reconnect may have missed events
    opened = true;
  };
  es.onerror = () => {
    document.getElementById("status").textContent = "reconnecting";
    // A non-200 (both slots busy) closes the stream for good, so retry by hand.
    if (es.readyState === EventSource.CLOSED) setTimeout(connect, 5000);
  };
  es.addEventListener("signal", ev => {
    const msg = parse(ev.data);
    if (!msg) return;
    offset = Date.now() - msg.now;
    const obj = parse(msg.payload);
    upsert({ key: msg.key, obj: obj, raw: msg.payload,
             rssi: msg.rssi, count: msg.count,
             seenAt: msg.at + offset, at: msg.at }, true);
    addLog(msg.at, msg.payload);
  });
}

document.getElementById("tab-devices").onclick = () => showTab("devices");
document.getElementById("tab-log").onclick = () => showTab("log");
function showTab(name) {
  for (const n of ["devices", "log"]) {
    document.getElementById("tab-" + n).setAttribute("aria-selected", String(n === name));
    document.getElementById("view-" + n).hidden = n !== name;
  }
}

setInterval(renderDevices, 1000);
refresh();
connect();
</script>
</body>
</html>
)rawliteral";
