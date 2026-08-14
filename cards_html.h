#pragma once

#include <Arduino.h>

static const char CARDS_HTML[] PROGMEM = R"rawliteral(
<section id="view-cards" hidden>
  <button id="edit-cards" title="Edit layout">&#9998;</button>
  <button id="forget-cards" title="Forget saved layouts">Forget layouts</button>
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
.card .lbl { position:absolute; top:-.65em; right:.7rem; max-width:calc(100% - 1.4rem);
             padding:0 .4rem; background:Canvas; font-size:.75rem;
             display:flex; align-items:baseline; overflow:hidden; }
.card .lbl .nm { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0;
                 flex:1 1 auto; }
.card .lbl .rs { opacity:.6; margin-left:.35rem; flex:0 0 auto; white-space:nowrap;
                 font-variant-numeric:tabular-nums; }
.card .age { position:absolute; right:.5rem; bottom:.25rem; font-size:.65rem; opacity:.5;
             font-variant-numeric:tabular-nums; }
.card .body { display:grid; grid-auto-rows:minmax(0,1fr); align-items:stretch; gap:.2rem .9rem;
              height:100%; overflow:hidden; }
.card .val { line-height:1.05; min-width:0; align-self:center; }
.card .fn { font-size:.6rem; text-transform:uppercase; letter-spacing:.05em; opacity:.6; }
.card .fv { font-variant-numeric:tabular-nums; white-space:nowrap; overflow:hidden;
            text-overflow:ellipsis; display:block; }
.card .fv .u { font-size:.5em; opacity:.65; margin-left:.12em; }
@media (max-width:520px) {
  #cards { grid-template-columns:repeat(auto-fill,minmax(140px,1fr)); }
}
@media (max-width:400px) {
  #cards { grid-template-columns:1fr; }
  .card.h, .card.wide { grid-column:span 1; }
}
#edit-cards { position:fixed; right:1rem; bottom:1rem; z-index:2; font:inherit;
              width:2.4rem; height:2.4rem; border-radius:50%; cursor:pointer;
              border:1px solid var(--line); background:Canvas; color:inherit; }
#view-cards.editing #edit-cards { background:#8883; }
#forget-cards { position:fixed; right:4.2rem; bottom:1rem; z-index:2; font:inherit;
                font-size:.75rem; padding:.4rem .7rem; border-radius:1.2rem; cursor:pointer;
                border:1px solid var(--line); background:Canvas; color:inherit; display:none; }
#view-cards.editing #forget-cards { display:block; }
#view-cards.editing .card { cursor:grab; touch-action:none; }
#view-cards.editing .val { cursor:pointer; }
.card.ghost, .val.ghost { opacity:.35; }
.card .cx, .card .ca { position:absolute; top:.25rem; z-index:1; font:inherit; font-size:.7rem;
                       line-height:1; padding:.15rem .3rem; background:Canvas; color:inherit;
                       border:1px solid var(--line); border-radius:.3rem; cursor:pointer;
                       display:none; }
.card .cx { left:.3rem; }
.card .ca { left:2rem; }
#view-cards.editing .card .cx, #view-cards.editing .card .ca { display:block; }
.card .lbl input { font:inherit; font-size:.75rem; width:9rem; background:Canvas; color:inherit;
                   border:1px solid var(--line); }
.ghostcard { position:fixed; z-index:5; pointer-events:none; opacity:.75;
             border:1px solid var(--line); border-radius:.7rem; background:Canvas;
             padding:.3rem .6rem; font-size:.8rem; }
.card.lifting { opacity:.35; }
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

// Column count that best matches the card's own width:height ratio, so the
// value grid fills the card on both axes instead of just the top-left.
function bodyCols(aspect, count) {
  const ratio = aspect === "h" ? 2.2 : aspect === "v" ? 0.5 : aspect === "wide" ? 1.1 : 1;
  return Math.max(1, Math.min(count, Math.round(Math.sqrt(count * ratio))));
}

function valueFont(cells, visibleCount) {
  const raw = 1.9 * Math.sqrt(cells / Math.max(1, visibleCount));
  return Math.min(2.6, Math.max(0.7, Math.round(raw * 1000) / 1000)) + "rem";
}

// rtl_433 sends full float precision; the card only needs enough to read at a glance.
function fmtValue(v) {
  if (typeof v !== "number") return String(v);
  return String(parseFloat(v.toFixed(Math.abs(v) >= 10 ? 1 : 2)));
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
  const shown = editing ? c.valueOrder.filter(f => rec.merged[f] !== undefined) : vis;
  const gridAspect = c.aspect === "sq" && cells === 4 ? "wide" : c.aspect;
  body.style.gridTemplateColumns = "repeat(" + bodyCols(gridAspect, shown.length) + ",minmax(0,1fr))";
  const font = valueFont(cells, vis.length);
  for (const f of shown) {
    const v = el("div", "val");
    if (c.hiddenValues.indexOf(f) >= 0) v.classList.add("ghost");
    v.dataset.f = f;
    const parts = splitUnit(f);
    v.append(el("div", "fn", parts.name));
    const fv = el("div", "fv", fmtValue(rec.merged[f]));
    fv.style.fontSize = font;
    if (parts.unit) fv.append(el("span", "u", parts.unit));
    v.append(fv);
    v.onclick = () => { if (editing && !dragMoved) toggleValue(key, f); };
    body.append(v);
  }

  if (cardHidden(key)) card.classList.add("ghost");

  const cx = el("button", "cx", "✕");
  cx.onclick = ev => { ev.stopPropagation(); toggleCardHidden(key); };
  const ca = el("button", "ca", "▭");
  ca.onclick = ev => { ev.stopPropagation(); cycleAspect(key); };

  // dblclick/pointerdown stay wired to lbl for its whole lifetime, and both
  // bubble up from the rename <input> startRename() puts inside it. Without
  // the renaming guard, interacting with the open input (double-clicking a
  // word, a long press to select text) would restart the rename and wipe it.
  lbl.ondblclick = ev => {
    if (!editing || lbl.dataset.renaming) return;
    ev.stopPropagation();
    startRename(key, lbl);
  };
  let pressTimer = 0;
  // A drag takes pointer capture, after which lbl never sees the pointerup that
  // would clear this timer, so the drag clears it instead.
  card.cancelPress = () => { clearTimeout(pressTimer); pressTimer = 0; };
  lbl.onpointerdown = () => {
    if (!editing || lbl.dataset.renaming || pressTimer) return;
    pressTimer = setTimeout(() => {
      pressTimer = 0;
      if (!editing || lbl.dataset.renaming) return;
      // A press held still this long is a rename, so drop the drag it started.
      if (dragging && dragging.key === key) dragging = null;
      startRename(key, lbl);
    }, 600);
  };
  lbl.onpointerup = lbl.onpointercancel = card.cancelPress;

  card.onpointerdown = ev => {
    if (!editing || ev.button !== 0) return;
    if (ev.target.closest("button") || ev.target.closest("input")) return;
    beginDrag(ev, card, ev.target.closest(".val"));
  };

  card.append(lbl, body, el("div", "age", ageText(Date.now() - rec.seenAt)), cx, ca);
  return card;
}

renderCards = function () {
  const grid = document.getElementById("cards");
  if (!grid) return;
  if (dragging) return;
  const seeded = new Map();
  for (const rec of devices.values()) seeded.set(rec.key, ensureCard(rec.key, rec.merged));
  const keys = orderedKeys();
  const shownKeys = keys.filter(k => !cardHidden(k));
  if (editing) shownKeys.push(...keys.filter(cardHidden));
  grid.replaceChildren(...shownKeys.map(k => buildCard(devices.get(k), seeded.get(k))));
};

let editing = false;

const ASPECTS = ["sq", "h", "v"];

function toggleValue(key, field) {
  const c = cardState.cards[key];
  if (!c) return;
  const i = c.hiddenValues.indexOf(field);
  if (i < 0) c.hiddenValues.push(field); else c.hiddenValues.splice(i, 1);
  saveCardState();
  renderCards();
}

function toggleCardHidden(key) {
  const i = cardState.hidden.indexOf(key);
  if (i < 0) cardState.hidden.push(key); else cardState.hidden.splice(i, 1);
  saveCardState();
  renderCards();
}

function cycleAspect(key) {
  const c = cardState.cards[key];
  if (!c) return;
  c.aspect = ASPECTS[(ASPECTS.indexOf(c.aspect) + 1) % ASPECTS.length];
  saveCardState();
  renderCards();
}

function renameCard(key, name) {
  const c = cardState.cards[key];
  if (!c) return;
  const trimmed = name.trim();
  if (trimmed) c.name = trimmed; else delete c.name;
  saveCardState();
  renderCards();
}

function startRename(key, lbl) {
  lbl.dataset.renaming = "1";
  const input = document.createElement("input");
  input.value = cardState.cards[key] && cardState.cards[key].name ? cardState.cards[key].name : "";
  lbl.replaceChildren(input);
  input.focus();
  input.select();
  let done = false;
  const finish = commit => {
    if (done) return;
    done = true;
    delete lbl.dataset.renaming;
    if (commit) renameCard(key, input.value); else renderCards();
  };
  input.onkeydown = ev => {
    if (ev.key === "Enter") finish(true);
    else if (ev.key === "Escape") finish(false);
  };
  input.onblur = () => finish(true);
}

function forgetLayouts() {
  try { localStorage.removeItem(CARDS_KEY); } catch (e) { storageBroken = true; }
  cardState = blankState();
  renderCards();
}

document.getElementById("edit-cards").onclick = () => {
  editing = !editing;
  document.getElementById("view-cards").classList.toggle("editing", editing);
  renderCards();
};

document.getElementById("forget-cards").onclick = () => {
  if (confirm("Forget every saved card layout in this browser?")) forgetLayouts();
};

const CLICK_SLOP = 6;
let dragging = null;
let dragMoved = false;

function moveCard(key, beforeKey) {
  const order = cardState.order;
  const from = order.indexOf(key);
  if (from < 0) return;
  order.splice(from, 1);
  const to = beforeKey === null ? order.length : order.indexOf(beforeKey);
  order.splice(to < 0 ? order.length : to, 0, key);
  saveCardState();
}

function moveValue(key, field, beforeField) {
  const c = cardState.cards[key];
  if (!c) return;
  const order = c.valueOrder;
  const from = order.indexOf(field);
  if (from < 0) return;
  order.splice(from, 1);
  const to = beforeField === null ? order.length : order.indexOf(beforeField);
  order.splice(to < 0 ? order.length : to, 0, field);
  saveCardState();
}

// The drop takes the slot of the sibling whose midpoint is nearest the pointer,
// so one dragged from before that sibling lands after it. Returns the node to
// insert before, null to append, or the dragged node itself for no move.
function dropSlot(nodes, from, x, y) {
  let best = from, far = Infinity;
  nodes.forEach((n, i) => {
    const r = n.getBoundingClientRect();
    const d = Math.hypot(x - r.left - r.width / 2, y - r.top - r.height / 2);
    if (d < far) { far = d; best = i; }
  });
  return nodes[best > from ? best + 1 : best] || null;
}

function beginDrag(ev, card, val) {
  dragMoved = false;
  dragging = {
    key: card.dataset.key, field: val ? val.dataset.f : null,
    x0: ev.clientX, y0: ev.clientY, moved: false, node: val || card,
    ghost: null, pointerId: ev.pointerId, card: card,
  };
}

function dragMove(ev) {
  const d = dragging;
  if (!d || ev.pointerId !== d.pointerId) return;
  if (!d.moved) {
    if (Math.hypot(ev.clientX - d.x0, ev.clientY - d.y0) < CLICK_SLOP) return;
    d.moved = true;
    // Capture only once it is a real drag: a captured pointer sends the click
    // to the card, and a value's click is how it toggles.
    d.card.setPointerCapture(d.pointerId);
    d.card.cancelPress();
    d.ghost = el("div", "ghostcard", d.field ? splitUnit(d.field).name : cardLabel(d.key));
    document.body.append(d.ghost);
    d.node.classList.add("lifting");
  }
  d.ghost.style.left = ev.clientX + 12 + "px";
  d.ghost.style.top = ev.clientY + 12 + "px";
}

function endDrag(ev) {
  const d = dragging;
  if (!d || ev.pointerId !== d.pointerId) return;
  dragging = null;
  d.card.cancelPress();
  dragMoved = d.moved;
  if (d.ghost) d.ghost.remove();
  d.node.classList.remove("lifting");
  if (!d.moved) return;
  const nodes = d.field ? [...d.card.querySelectorAll(".val")]
                        : [...document.querySelectorAll("#cards .card")];
  const before = dropSlot(nodes, nodes.indexOf(d.node), ev.clientX, ev.clientY);
  if (before !== d.node) {
    if (d.field) moveValue(d.key, d.field, before ? before.dataset.f : null);
    else moveCard(d.key, before ? before.dataset.key : null);
  }
  renderCards();
}

// On the document, not the card: capture is only taken once the gesture crosses
// the slop, so before that a pointer leaving the card would strand the drag and
// renderCards() would stay suppressed forever. Registered once, since
// renderCards() replaces every card element on every tick.
document.addEventListener("pointermove", dragMove);
document.addEventListener("pointerup", endDrag);
document.addEventListener("pointercancel", endDrag);

renderCards();
</script>
</body>
</html>
)rawliteral";
