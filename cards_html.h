#pragma once

#include <Arduino.h>

static const char CARDS_HTML[] PROGMEM = R"rawliteral(
<section id="view-cards" hidden>
  <div id="cards"></div>
</section>
<style>
#cards { display:grid; grid-template-columns:repeat(auto-fill,minmax(170px,1fr));
         grid-auto-rows:150px; grid-auto-flow:dense; gap:1.4rem 1rem; padding:1.6rem 1rem 1rem; }
.card { position:relative; border:1px solid var(--line); border-radius:.7rem;
        padding:.7rem .6rem .9rem; overflow:hidden; }
.card.h { grid-column:span 2; }
.card.v { grid-row:span 2; }
.card.wide { grid-column:span 2; grid-row:span 2; }
.card.flash { animation:flash 1s ease-out; }
.card .lbl { position:absolute; top:-.65em; right:.7rem; padding:0 .4rem;
             background:Canvas; font-size:.75rem; white-space:nowrap; }
.card .lbl .rs { opacity:.6; margin-left:.35rem; font-variant-numeric:tabular-nums; }
.card .age { position:absolute; right:.5rem; bottom:.25rem; font-size:.65rem; opacity:.5;
             font-variant-numeric:tabular-nums; }
.card .body { display:flex; flex-wrap:wrap; align-content:flex-start; gap:.2rem .9rem;
              height:100%; overflow:hidden; }
.card .val { line-height:1.05; }
.card .fn { font-size:.6rem; text-transform:uppercase; letter-spacing:.05em; opacity:.6; }
.card .fv { font-variant-numeric:tabular-nums; white-space:nowrap; }
.card .fv .u { font-size:.5em; opacity:.65; margin-left:.12em; }
@media (max-width:520px) {
  #cards { grid-template-columns:repeat(auto-fill,minmax(140px,1fr)); }
}
@media (max-width:400px) {
  #cards { grid-template-columns:1fr; }
  .card.h, .card.wide { grid-column:span 1; }
}
</style>
<script>
const CARDS_KEY = "rtl433.cards.v1";

// rtl_433 flags rather than readings: useful, but not what a card is for.
const STATUS_FIELDS = new Set(["battery_ok", "battery", "battery_low", "test", "tamper",
                               "status", "integrity", "alarm", "learn", "unknown"]);

let cardState = blankState();
let storageBroken = false;

// Null prototype: a stored "__proto__" key must not become a prototype link.
function blankState() { return { order: [], hidden: [], cards: Object.create(null) }; }

function loadCardState() {
  cardState = blankState();
  let raw;
  try { raw = localStorage.getItem(CARDS_KEY); } catch (e) { storageBroken = true; return; }
  if (!raw) return;
  let s;
  try { s = JSON.parse(raw); } catch (e) { return; }
  if (!s || typeof s !== "object") return;
  cardState = {
    order: Array.isArray(s.order) ? s.order.filter(k => typeof k === "string") : [],
    hidden: Array.isArray(s.hidden) ? s.hidden.filter(k => typeof k === "string") : [],
    cards: Object.create(null),
  };
  const cards = s.cards && typeof s.cards === "object" ? s.cards : {};
  for (const k of Object.keys(cards)) {
    const c = cards[k];
    if (!c || typeof c !== "object") continue;
    cardState.cards[k] = {
      name: typeof c.name === "string" ? c.name : undefined,
      aspect: c.aspect === "h" || c.aspect === "v" ? c.aspect : "sq",
      valueOrder: Array.isArray(c.valueOrder) ? c.valueOrder.filter(f => typeof f === "string") : [],
      hiddenValues: Array.isArray(c.hiddenValues) ? c.hiddenValues.filter(f => typeof f === "string") : [],
    };
  }
}

function saveCardState() {
  if (storageBroken) return;
  try { localStorage.setItem(CARDS_KEY, JSON.stringify(cardState)); }
  catch (e) { storageBroken = true; }
}

function ensureCard(key, merged) {
  let c = cardState.cards[key];
  const fields = Object.keys(merged || {});
  if (!c) {
    const visible = fields.filter(f => !STATUS_FIELDS.has(f));
    c = {
      aspect: visible.length > 3 ? "h" : "sq",
      valueOrder: fields.slice(),
      hiddenValues: fields.filter(f => STATUS_FIELDS.has(f)),
    };
    cardState.cards[key] = c;
  } else {
    for (const f of fields) {
      if (c.valueOrder.indexOf(f) >= 0) continue;
      c.valueOrder.push(f);
      if (STATUS_FIELDS.has(f)) c.hiddenValues.push(f);
    }
  }
  if (cardState.order.indexOf(key) < 0) cardState.order.push(key);
  return c;
}

function visibleValues(key, merged) {
  const c = cardState.cards[key];
  if (!c) return [];
  return c.valueOrder.filter(f => merged[f] !== undefined && c.hiddenValues.indexOf(f) < 0);
}

function cardHidden(key) { return cardState.hidden.indexOf(key) >= 0; }

function orderedKeys() { return cardState.order.filter(k => devices.has(k)); }

loadCardState();

// rtl_433 puts the unit in the field name, so the name and the unit come apart
// here rather than from a table of every sensor.
const UNITS = [["_mi_h", "mi/h"], ["_km_h", "km/h"], ["_m_s", "m/s"], ["_hPa", "hPa"],
               ["_kPa", "kPa"], ["_in", "in"], ["_mm", "mm"], ["_F", "°F"],
               ["_C", "°C"], ["_V", "V"], ["_deg", "°"], ["_ppm", "ppm"]];

function splitUnit(field) {
  for (const [suffix, unit] of UNITS) {
    if (field.length > suffix.length && field.endsWith(suffix)) {
      return { name: field.slice(0, -suffix.length).replace(/_/g, " "), unit: unit };
    }
  }
  if (field === "humidity") return { name: "humidity", unit: "%" };
  return { name: field.replace(/_/g, " "), unit: "" };
}

function cardCells(key, visibleCount) {
  const aspect = (cardState.cards[key] || {}).aspect || "sq";
  if (aspect === "sq") return visibleCount > 6 ? 4 : 1;
  return 2;
}

function valueFont(cells, visibleCount) {
  const raw = 2.4 * Math.sqrt(cells / Math.max(1, visibleCount));
  return Math.min(2.6, Math.max(0.9, Math.round(raw * 1000) / 1000)) + "rem";
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function cardLabel(key) {
  const c = cardState.cards[key];
  return c && c.name ? c.name : key;
}

function buildCard(rec, c) {
  const key = rec.key;
  const vis = visibleValues(key, rec.merged);
  const cells = cardCells(key, vis.length);

  const card = el("div", "card " + c.aspect);
  if (c.aspect === "sq" && cells === 4) card.className = "card sq wide";
  card.dataset.key = key;
  if (rec.flashUntil > Date.now()) card.classList.add("flash");

  const lbl = el("div", "lbl");
  lbl.append(el("span", "nm", cardLabel(key)), el("span", "rs", rec.rssi === undefined ? "" : String(rec.rssi)));

  const body = el("div", "body");
  const font = valueFont(cells, vis.length);
  for (const f of vis) {
    const v = el("div", "val");
    v.dataset.f = f;
    const parts = splitUnit(f);
    v.append(el("div", "fn", parts.name));
    const fv = el("div", "fv", String(rec.merged[f]));
    fv.style.fontSize = font;
    if (parts.unit) fv.append(el("span", "u", parts.unit));
    v.append(fv);
    body.append(v);
  }

  card.append(lbl, body, el("div", "age", ageText(Date.now() - rec.seenAt)));
  return card;
}

renderCards = function () {
  const grid = document.getElementById("cards");
  if (!grid) return;
  const seeded = new Map();
  for (const rec of devices.values()) seeded.set(rec.key, ensureCard(rec.key, rec.merged));
  const cards = [];
  for (const key of orderedKeys()) {
    if (cardHidden(key)) continue;
    cards.push(buildCard(devices.get(key), seeded.get(key)));
  }
  grid.replaceChildren(...cards);
};

renderCards();
</script>
</body>
</html>
)rawliteral";
