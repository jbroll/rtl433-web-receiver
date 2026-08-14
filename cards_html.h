#pragma once

#include <Arduino.h>

static const char CARDS_HTML[] PROGMEM = R"rawliteral(
<section id="view-cards" hidden>
  <button id="edit-cards" title="Edit layout">&#9998;</button>
  <button id="forget-cards" title="Forget saved layouts">Forget layouts</button>
  <span id="grid-size" title="Grid columns and rows">
    <input id="grid-cols" type="number" min="1" max="24" aria-label="Grid columns">
    <span>&times;</span>
    <input id="grid-rows" type="number" min="1" max="24" aria-label="Grid rows">
  </span>
  <div id="cards"></div>
</section>
<style>
#cards { display:grid; grid-auto-flow:dense; grid-auto-rows:var(--cell,150px);
         justify-content:start; align-content:start; padding:1.6rem 1rem 1rem; }
.card { position:relative; margin:.35rem; border:1px solid var(--line); border-radius:.7rem;
        padding:.5rem .45rem .6rem; overflow:hidden; }
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
.card .body { display:grid; align-items:stretch; gap:.2rem .6rem; height:100%; overflow:hidden; }
.card .val { display:flex; flex-direction:column; justify-content:center; line-height:1.05;
             min-width:0; min-height:0; align-self:stretch; overflow:hidden; }
.card .fn { font-size:.6rem; text-transform:uppercase; letter-spacing:.05em; opacity:.6;
            overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.card .fv { font-variant-numeric:tabular-nums; white-space:nowrap; overflow:hidden;
            text-overflow:ellipsis; display:block; }
.card .fv .u { font-size:.5em; opacity:.65; margin-left:.12em; }
#edit-cards { position:fixed; right:1rem; bottom:1rem; z-index:2; font:inherit;
              width:2.4rem; height:2.4rem; border-radius:50%; cursor:pointer;
              border:1px solid var(--line); background:Canvas; color:inherit; }
#view-cards.editing #edit-cards { background:#8883; }
#forget-cards { position:fixed; right:4.2rem; bottom:1rem; z-index:2; font:inherit;
                font-size:.75rem; padding:.4rem .7rem; border-radius:1.2rem; cursor:pointer;
                border:1px solid var(--line); background:Canvas; color:inherit; display:none; }
#view-cards.editing #forget-cards { display:block; }
#grid-size { position:fixed; right:12rem; bottom:1rem; z-index:2; font-size:.75rem;
             display:none; align-items:center; gap:.25rem; }
#view-cards.editing #grid-size { display:flex; }
#grid-size input { font:inherit; font-size:.75rem; width:3.2rem; padding:.3rem .35rem;
                   border-radius:1.2rem; border:1px solid var(--line); background:Canvas;
                   color:inherit; text-align:center; }
#view-cards.editing .card { cursor:grab; touch-action:none; }
#view-cards.editing .val { cursor:pointer; }
.card.ghost, .val.ghost { opacity:.35; }
.card .cx { position:absolute; top:.25rem; left:.3rem; z-index:1; font:inherit; font-size:.7rem;
            line-height:1; padding:.15rem .3rem; background:Canvas; color:inherit;
            border:1px solid var(--line); border-radius:.3rem; cursor:pointer;
            display:none; }
#view-cards.editing .card .cx { display:block; }
.card .rz { position:absolute; right:0; bottom:0; width:1.2rem; height:1.2rem; z-index:1;
            padding:0; border:none; background:none; color:inherit; cursor:nwse-resize;
            touch-action:none; display:none; }
.card .rz::after { content:""; position:absolute; right:.25rem; bottom:.25rem;
                   width:.5rem; height:.5rem; opacity:.55;
                   border-right:2px solid currentColor; border-bottom:2px solid currentColor; }
#view-cards.editing .card .rz { display:block; }
#view-cards.editing .card .age { right:1.4rem; }
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

const GRID_MIN = 1, GRID_MAX = 24;

// Null prototype: a stored "__proto__" key must not become a prototype link.
function blankState() {
  return { grid: { cols: 6, rows: 4 }, order: [], hidden: [], cards: Object.create(null) };
}

function gridNum(v, fallback) {
  return Number.isInteger(v) && v >= GRID_MIN && v <= GRID_MAX ? v : fallback;
}

function defaultSize(count) {
  const v = Math.max(1, count);
  const w = Math.ceil(Math.sqrt(v));
  return { w: w, h: Math.ceil(v / w) };
}

// Entries written before the grid carry an aspect instead of a size. One with
// neither returns empty and ensureCard() sizes it from its value count.
function migrateSize(c) {
  const w = gridNum(c.w, 0), h = gridNum(c.h, 0);
  if (w && h) return { w: w, h: h };
  if (c.aspect === "h") return { w: 2, h: 1 };
  if (c.aspect === "v") return { w: 1, h: 2 };
  if (c.aspect === "sq") return { w: 1, h: 1 };
  return {};
}

function loadCardState() {
  cardState = blankState();
  let raw;
  try { raw = localStorage.getItem(CARDS_KEY); } catch (e) { storageBroken = true; return; }
  if (!raw) return;
  let s;
  try { s = JSON.parse(raw); } catch (e) { return; }
  if (!s || typeof s !== "object") return;
  const g = s.grid && typeof s.grid === "object" ? s.grid : {};
  cardState = {
    grid: { cols: gridNum(g.cols, 6), rows: gridNum(g.rows, 4) },
    order: Array.isArray(s.order) ? s.order.filter(k => typeof k === "string") : [],
    hidden: Array.isArray(s.hidden) ? s.hidden.filter(k => typeof k === "string") : [],
    cards: Object.create(null),
  };
  const cards = s.cards && typeof s.cards === "object" ? s.cards : {};
  for (const k of Object.keys(cards)) {
    const c = cards[k];
    if (!c || typeof c !== "object") continue;
    const size = migrateSize(c);
    cardState.cards[k] = {
      name: typeof c.name === "string" ? c.name : undefined,
      w: size.w, h: size.h,
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
    c = {
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
  if (!c.w || !c.h) {
    const size = defaultSize(visibleValues(key, merged).length);
    c.w = size.w;
    c.h = size.h;
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

let cellSide = 150;

// Square cells sized to fit the whole grid on screen, so the shorter of the two
// divisions wins and the other axis letterboxes.
function measureGrid() {
  const grid = document.getElementById("cards");
  if (!grid || grid.clientWidth <= 0) return;
  const g = cardState.grid;
  const cs = getComputedStyle(grid);
  const width = grid.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const height = window.innerHeight - grid.getBoundingClientRect().top
                 - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  cellSide = Math.max(20, Math.min(width / g.cols, height / g.rows));
  grid.style.setProperty("--cell", cellSide + "px");
  grid.style.gridTemplateColumns = "repeat(" + g.cols + ",var(--cell))";
  grid.style.gridTemplateRows = "repeat(" + g.rows + ",var(--cell))";
}

const FONT_MIN = 11, FONT_MAX = 64;

function valueFont(h, cell, rows) {
  const px = Math.round(0.42 * h * cell / Math.max(1, rows));
  return Math.min(FONT_MAX, Math.max(FONT_MIN, px)) + "px";
}

// Width of a value at a 1px font, the unit's .5em and .12em margin included.
// Measured on a canvas rather than in the document: fitting every value by
// reflow would cost a layout each, and the numbers are tabular either way.
let textProbe = null, probeFont = "";
function textWidthEm(num, unit) {
  if (!textProbe) {
    textProbe = document.createElement("canvas").getContext("2d");
    probeFont = getComputedStyle(document.body).fontFamily;
  }
  textProbe.font = "100px " + probeFont;
  let w = textProbe.measureText(num).width;
  if (unit) {
    textProbe.font = "50px " + probeFont;
    w += textProbe.measureText(unit).width + 12;
  }
  return w / 100;
}

// valueFont() sizes to the row height alone, so a reading as wide as 1013.3hPa
// would ellipsize in a box tall enough to hold it twice over. Every box is read
// before any font is written, to keep this to one layout for the whole grid.
let fitting = [];
function fitValues() {
  const boxes = fitting.map(f => f.node.parentNode.clientWidth);
  fitting.forEach((f, i) => {
    const cap = Math.floor(boxes[i] / f.em);
    if (cap < parseFloat(f.node.style.fontSize)) {
      f.node.style.fontSize = Math.max(FONT_MIN, cap) + "px";
    }
  });
  fitting = [];
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
  const g = cardState.grid;
  const w = Math.max(1, Math.min(c.w, g.cols));
  const h = Math.max(1, Math.min(c.h, g.rows));

  const card = el("div", "card");
  card.style.gridColumn = "span " + w;
  card.style.gridRow = "span " + h;
  card.dataset.key = key;
  if (rec.flashUntil > Date.now()) card.classList.add("flash");

  const lbl = el("div", "lbl");
  lbl.append(el("span", "nm", cardLabel(key)), el("span", "rs", rec.rssi === undefined ? "" : String(rec.rssi)));

  const body = el("div", "body");
  const shown = editing ? c.valueOrder.filter(f => rec.merged[f] !== undefined) : vis;
  const valueRows = Math.max(h, Math.ceil(shown.length / w));
  body.style.gridTemplateColumns = "repeat(" + w + ",minmax(0,1fr))";
  body.style.gridTemplateRows = "repeat(" + valueRows + ",minmax(0,1fr))";
  const font = valueFont(h, cellSide, valueRows);
  for (const f of shown) {
    const v = el("div", "val");
    if (c.hiddenValues.indexOf(f) >= 0) v.classList.add("ghost");
    v.dataset.f = f;
    const parts = splitUnit(f);
    v.append(el("div", "fn", parts.name));
    const num = fmtValue(rec.merged[f]);
    const fv = el("div", "fv", num);
    fv.style.fontSize = font;
    fitting.push({ node: fv, em: textWidthEm(num, parts.unit) });
    if (parts.unit) fv.append(el("span", "u", parts.unit));
    v.append(fv);
    v.onclick = () => { if (editing && !dragMoved) toggleValue(key, f); };
    body.append(v);
  }

  if (cardHidden(key)) card.classList.add("ghost");

  const cx = el("button", "cx", "✕");
  cx.onclick = ev => { ev.stopPropagation(); toggleCardHidden(key); };

  const rz = el("button", "rz", "");
  // Only a second touch can start one gesture during the other, and a drag
  // ending mid-resize would save layout the suppressed renderer has not drawn.
  rz.onpointerdown = ev => {
    if (!editing || ev.button !== 0 || dragging) return;
    ev.stopPropagation();
    // c.w/c.h, not the clamped w/h this card is drawn at: a resize must move
    // relative to the stored size, not destroy it by starting from a shrunk render.
    beginResize(ev, card, c.w, c.h);
  };

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
    if (!editing || ev.button !== 0 || resizing) return;
    if (ev.target.closest("button") || ev.target.closest("input")) return;
    beginDrag(ev, card, ev.target.closest(".val"));
  };

  card.append(lbl, body, el("div", "age", ageText(Date.now() - rec.seenAt)), cx, rz);
  return card;
}

renderCards = function () {
  const grid = document.getElementById("cards");
  if (!grid) return;
  if (dragging || resizing) return;
  measureGrid();
  const seeded = new Map();
  for (const rec of devices.values()) seeded.set(rec.key, ensureCard(rec.key, rec.merged));
  const keys = orderedKeys();
  const shownKeys = keys.filter(k => !cardHidden(k));
  if (editing) shownKeys.push(...keys.filter(cardHidden));
  fitting = [];
  grid.replaceChildren(...shownKeys.map(k => buildCard(devices.get(k), seeded.get(k))));
  fitValues();
};

let editing = false;

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
  syncGridInputs();
  measureGrid();
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

function syncGridInputs() {
  document.getElementById("grid-cols").value = String(cardState.grid.cols);
  document.getElementById("grid-rows").value = String(cardState.grid.rows);
}

function applyGridInput(input, key) {
  const n = gridNum(parseInt(input.value, 10), 0);
  if (n) {
    cardState.grid[key] = n;
    saveCardState();
  }
  input.value = String(cardState.grid[key]);
  measureGrid();
  renderCards();
}

document.getElementById("grid-cols").onchange = ev => applyGridInput(ev.target, "cols");
document.getElementById("grid-rows").onchange = ev => applyGridInput(ev.target, "rows");
syncGridInputs();

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

let resizing = null;

function beginResize(ev, card, w, h) {
  resizing = { key: card.dataset.key, card: card, x0: ev.clientX, y0: ev.clientY,
               w0: w, h0: h, w: w, h: h, pointerId: ev.pointerId };
  card.setPointerCapture(ev.pointerId);
}

function resizeMove(ev) {
  const r = resizing;
  if (!r || ev.pointerId !== r.pointerId) return;
  const g = cardState.grid;
  r.w = Math.max(1, Math.min(g.cols, r.w0 + Math.round((ev.clientX - r.x0) / cellSide)));
  r.h = Math.max(1, Math.min(g.rows, r.h0 + Math.round((ev.clientY - r.y0) / cellSide)));
  r.card.style.gridColumn = "span " + r.w;
  r.card.style.gridRow = "span " + r.h;
}

function endResize(ev) {
  const r = resizing;
  if (!r || ev.pointerId !== r.pointerId) return;
  resizing = null;
  // A gesture that ends at the size it started from expressed no intent to
  // resize, so it must not overwrite a stored size the current grid clamps.
  if (r.w !== r.w0 || r.h !== r.h0) {
    const c = cardState.cards[r.key];
    if (c) { c.w = r.w; c.h = r.h; saveCardState(); }
  }
  renderCards();
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
document.addEventListener("pointermove", ev => { dragMove(ev); resizeMove(ev); });
document.addEventListener("pointerup", ev => { endDrag(ev); endResize(ev); });
document.addEventListener("pointercancel", ev => { endDrag(ev); endResize(ev); });

// The section is hidden until its tab is shown, so the first real measurement
// has to wait for that click; the tab's own handler runs first and unhides it.
document.getElementById("tab-cards").addEventListener("click", () => { measureGrid(); renderCards(); });
window.addEventListener("resize", () => { measureGrid(); renderCards(); });

renderCards();
</script>
</body>
</html>
)rawliteral";
