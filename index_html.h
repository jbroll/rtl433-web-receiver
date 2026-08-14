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
.flash { animation:flash 1s ease-out; }
@keyframes flash { from { background:rgba(255,215,0,.16); } to { background:transparent; } }
#devices input, #devices select, #grid-size input, #edit-cards, #forget-cards,
.card .lbl input, .card .cx { font:inherit; background:Canvas; color:inherit;
                              border:1px solid var(--line); }
#devices input[type=text] { font-size:.85rem; width:8rem; padding:.1rem .3rem; }
#devices select { font-size:.8rem; }
tr.vrow td { border-bottom:none; padding:.1rem .6rem; font-size:.85rem; opacity:.75; }
tr.vrow td:first-child { padding-left:2rem; }
tr.vrow + tr:not(.vrow) td { border-top:1px solid var(--line); }
#log { font-family:ui-monospace,monospace; font-size:.8rem; }
#log .nw { white-space:nowrap; }
#log td { white-space:pre-wrap; word-break:break-all; }
section[hidden] { display:none; }
</style>
</head>
<body>
<header>
  <h1>rtl_433</h1>
  <nav>
    <button id="tab-devices" aria-selected="false">Devices</button>
    <button id="tab-log" aria-selected="false">Log</button>
    <button id="tab-cards" aria-selected="true">Cards</button>
  </nav>
  <span id="status">connecting</span>
</header>
<section id="view-devices" hidden><table>
<thead><tr><th>Model</th><th>ID</th><th>Reading</th><th class="num">RSSI</th><th class="num">Msgs</th><th class="num">Age</th><th>Alias</th><th>Card</th></tr></thead>
<tbody id="devices"></tbody>
</table></section>
<section id="view-log" hidden><table id="log"><tbody id="logrows"></tbody></table></section>
<script>
// Everything rtl_433 and the binding add around the actual sensor readings.
const META = new Set(["model", "id", "channel", "protocol", "rssi", "duration",
                      "mic", "message_type", "sequence_num", "time", "count",
                      "build"]);
const LOG_MAX = 200;
const DEVICE_MAX = 24;
const ALIAS_SUFFIX = "/$alias";
const devices = new Map();
const aliases = new Map();
let logRows = [];
let build = null;
// CARDS_HTML is streamed after this script and reassigns these.
let renderCards = () => {};
let cardVisible = () => true;
let setCardVisible = () => {};
let cardAlias = () => "";
let setCardAlias = () => {};
let cardFields = (key, merged) => Object.keys(merged);
let valueModeOf = () => "shown";
let setFieldMode = () => {};

const $ = id => document.getElementById(id);

// Shared with the cards script, which is parsed after this one.
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

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
  // Cards first: seeding a card is what gives the device table the display
  // modes it lists, so the other order shows a new device's values as shown.
  renderCards();
  renderDevices();
}

function renderDevices() {
  if ($("view-devices").hidden) return;
  const tbody = $("devices");
  // A rebuild takes an open control out from under whoever is using it. Only
  // the ones that hold a value need that; a checkbox keeps focus after a click
  // and would otherwise freeze the table for good.
  const held = document.activeElement;
  if (tbody.contains(held) && (held.tagName === "SELECT" || held.type === "text")) return;
  const out = [];
  for (const r of [...devices.values()].sort((a, b) => b.seenAt - a.seenAt)) {
    out.push(deviceRow(r));
    for (const f of cardFields(r.key, r.merged)) out.push(valueRow(r.key, f, r.merged[f]));
  }
  tbody.replaceChildren(...out);
}

function deviceRow(r) {
  const obj = r.obj;
  const name = obj && obj.model ? obj.model : shortKey(r.key);
  const tr = el("tr", r.flashUntil > Date.now() ? "flash" : "");
  tr.dataset.key = r.key;
  const cells = [
    name,
    obj && obj.id !== undefined ? obj.id : (obj && obj.channel !== undefined ? "ch" + obj.channel : ""),
    reading(r),
    r.rssi === undefined ? "" : r.rssi,
    r.count === undefined ? "" : r.count,
    ageText(Date.now() - r.seenAt)
  ];
  cells.forEach((v, i) => tr.append(el("td", i >= 3 ? "num" : "", v)));

  const alias = el("input");
  alias.type = "text";
  alias.value = cardAlias(r.key);
  alias.placeholder = name;
  alias.title = "Name shown on this device's card";
  alias.onchange = () => setCardAlias(r.key, alias.value);

  const show = el("input");
  show.type = "checkbox";
  show.checked = cardVisible(r.key);
  show.title = "Show a card for this device";
  show.onchange = () => setCardVisible(r.key, show.checked);

  const aliasTd = el("td"), showTd = el("td");
  aliasTd.append(alias);
  showTd.append(show);
  tr.append(aliasTd, showTd);
  return tr;
}

// Built once and cloned: a busy table is a couple of hundred of these a second.
const MODES = el("select");
for (const m of ["shown", "bottom", "hidden"]) {
  const opt = el("option", "", m);
  opt.value = m;
  MODES.append(opt);
}

// One row per reading, under its device: what the card does with that value.
function valueRow(key, field, value) {
  const tr = el("tr", "vrow");
  tr.dataset.key = key;
  tr.dataset.f = field;
  const name = el("td", "", field), val = el("td", "num", value), mode = el("td");
  name.colSpan = 3;
  val.colSpan = 3;
  mode.colSpan = 2;
  const pick = MODES.cloneNode(true);
  pick.value = valueModeOf(key, field);
  pick.onchange = () => setFieldMode(key, field, pick.value);
  mode.append(pick);
  tr.append(name, val, mode);
  return tr;
}

function addLog(at, raw) {
  logRows.unshift({ at: at, raw: raw });
  if (logRows.length > LOG_MAX) logRows.length = LOG_MAX;
  renderLog();
}

function renderLog() {
  if ($("view-log").hidden) return;
  $("logrows").replaceChildren(...logRows.map(e => {
    const tr = el("tr");
    const t = el("td", "nw", new Date(e.at).toLocaleTimeString());
    tr.append(t, el("td", "", e.raw));
    return tr;
  }));
}

function isSelf(topic) { return topic.split("/")[1] === "Receiver"; }

function shortKey(topic) { return topic.split("/").slice(1).join("/"); }

function aliasOf(topic) { return aliases.get(topic) || ""; }

// Task 9 posts the alias asynchronously; the render must not wait on that.
function postAlias(topic, name) { renderCards(); renderDevices(); }

function applyAlias(topic, payload) {
  const key = topic.slice(0, -ALIAS_SUFFIX.length);
  if (typeof payload === "string" && payload !== "") aliases.set(key, payload);
  else aliases.delete(key);
  renderCards();
  renderDevices();
}

function applyMessage(topic, obj) {
  if (!obj || typeof obj !== "object") return;
  // A message stamped before the device's clock was set has no time, so it ages
  // from its arrival instead.
  const stamped = obj.time ? Date.parse(obj.time) : NaN;
  const at = Number.isFinite(stamped) ? stamped : Date.now();
  // A reflashed device reboots, the stream reconnects, and its telemetry names
  // the new build: the page it served is the old firmware's, so reload it.
  if (isSelf(topic) && typeof obj.build === "string") {
    if (build === null) build = obj.build;
    else if (obj.build !== build) { location.reload(); return; }
  }
  const raw = JSON.stringify(obj);
  upsert({ key: topic, obj: obj, raw: raw, rssi: obj.rssi, count: obj.count,
           seenAt: at, at: at }, true);
  if (!isSelf(topic)) addLog(at, raw);
}

function connect() {
  const es = new EventSource("/events");
  es.onopen = () => { $("status").textContent = "live"; };
  es.onerror = () => {
    $("status").textContent = "reconnecting";
    // A non-200 (every slot busy) closes the stream for good, so retry by hand.
    if (es.readyState === EventSource.CLOSED) setTimeout(connect, 5000);
  };
  es.onmessage = ev => {
    const msg = parse(ev.data);
    if (!msg || typeof msg.topic !== "string") return;
    if (msg.topic.endsWith(ALIAS_SUFFIX)) applyAlias(msg.topic, msg.payload);
    else applyMessage(msg.topic, msg.payload);
  };
}

const TABS = ["devices", "log", "cards"];
for (const n of TABS) $("tab-" + n).onclick = () => showTab(n);
function showTab(name) {
  for (const n of TABS) {
    $("tab-" + n).setAttribute("aria-selected", String(n === name));
    $("view-" + n).hidden = n !== name;
  }
  // The section it reveals has not been drawn since it was last hidden.
  renderCards();
  renderDevices();
  renderLog();
}

setInterval(() => { renderCards(); renderDevices(); }, 1000);
connect();
</script>
)rawliteral";
