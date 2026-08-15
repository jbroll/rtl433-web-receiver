import { moveCard, moveValue, setCardSize, grid as gridSize } from './store.js'
import { displayName } from './alias.js'
import { splitUnit, el } from './units.js'
import { requestRender } from './render.js'

const $ = (id) => document.getElementById(id)

let cell = 150

export function cellSide() { return cell }

// Square cells sized to fit the whole grid on screen, so the shorter of the two
// divisions wins and the other axis letterboxes.
export function measureGrid() {
  const grid = $("cards");
  if (!grid || grid.clientWidth <= 0) return;
  const g = gridSize();
  const cs = getComputedStyle(grid);
  const width = grid.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const height = window.innerHeight - grid.getBoundingClientRect().top
                 - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  cell = Math.max(20, Math.min(width / g.cols, height / g.rows));
  grid.style.setProperty("--cell", cell + "px");
  grid.style.gridTemplateColumns = "repeat(" + g.cols + ",var(--cell))";
  grid.style.gridTemplateRows = "repeat(" + g.rows + ",var(--cell))";
}

const FONT_MIN = 11, FONT_MAX = 64;

export function fontPx(h, cellPx, rows) {
  const px = Math.round(0.42 * h * cellPx / Math.max(1, rows));
  return Math.min(FONT_MAX, Math.max(FONT_MIN, px)) + "px";
}

export function valueFont(h, rows) { return fontPx(h, cell, rows) }

// Width of a value at a 1px font, the unit's .5em and .12em margin included.
// Measured on a canvas rather than in the document: fitting every value by
// reflow would cost a layout each, and the numbers are tabular either way.
let textProbe = null, probeFont = "";
export function textWidthEm(num, unit) {
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
// would ellipsize in a box tall enough to hold it twice over. A card takes one
// size, the widest reading's, rather than letting its values size raggedly.
// Every box is read before any font is written, to keep this to one layout.
let fitting = [];

export function trackFit(node, card, em) {
  fitting.push({ node: node, card: card, em: em });
}

// Cleared before the rebuild too, not just at fitValues()'s tail: if buildCard
// throws mid-render, entries from the aborted pass would carry over with nodes
// no longer in the document, poisoning the next fit's per-card cap.
export function resetFit() {
  fitting = [];
}

export function fitValues() {
  const boxes = fitting.map(f => f.node.parentNode.clientWidth);
  const caps = new Map();
  fitting.forEach((f, i) => {
    if (!boxes[i]) return;
    const cap = Math.floor(boxes[i] / f.em);
    if (!caps.has(f.card) || cap < caps.get(f.card)) caps.set(f.card, cap);
  });
  for (const f of fitting) {
    const cap = caps.get(f.card);
    if (cap < parseFloat(f.node.style.fontSize)) {
      f.node.style.fontSize = Math.max(FONT_MIN, cap) + "px";
    }
  }
  fitting = [];
}

let editingCards = false;
let renaming = false;

export function setEditing(v) { editingCards = v }

export function editing() { return editingCards }

export function setRenaming(v) { renaming = v }

export function gestureInFlight() { return !!(dragging || resizing || renaming) }

const CLICK_SLOP = 6;
let dragging = null;

export function currentDrag() { return dragging }

// A press held still long enough is a rename, so the card drops the drag it started.
export function cancelDrag(key) {
  if (dragging && dragging.key === key) dragging = null;
}

function makeZone(layer, left, top, width, height, before) {
  const z = el('div', 'drop-zone')
  z.style.position = 'absolute'
  z.style.left = left + 'px'
  z.style.top = top + 'px'
  z.style.width = Math.max(0, width) + 'px'
  z.style.height = Math.max(0, height) + 'px'
  z.dataset.before = before
  layer.append(z)
  return z
}

function createDropLayer(container, kind) {
  const layer = el('div', 'drop-layer ' + kind + '-layer')
  layer.style.position = 'fixed'
  layer.style.left = '0px'
  layer.style.top = '0px'
  layer.style.width = '100vw'
  layer.style.height = '100vh'
  layer.style.pointerEvents = 'none'
  layer.style.zIndex = '4'
  document.body.append(layer)
  return layer
}

function clearDropZones() {
  document.querySelectorAll('.drop-layer').forEach(n => n.remove())
}

function cardDropZones(layer) {
  const cards = [...document.querySelectorAll('#cards .card')]
  if (!cards.length) return []
  const gridRect = document.getElementById('cards').getBoundingClientRect()

  // Group cards by visual row.
  const rows = []
  for (const card of cards) {
    const r = card.getBoundingClientRect()
    const row = rows.find(row => Math.abs(row.top - r.top) < 5)
    if (row) row.cards.push({ card, rect: r })
    else rows.push({ top: r.top, cards: [{ card, rect: r }] })
  }
  rows.sort((a, b) => a.top - b.top)
  for (const row of rows) row.cards.sort((a, b) => a.rect.left - b.rect.left)

  const zones = []
  for (let ri = 0; ri < rows.length; ri++) {
    const row = rows[ri]
    const rowTop = Math.min(...row.cards.map(c => c.rect.top))
    const rowBottom = Math.max(...row.cards.map(c => c.rect.bottom))
    const prevBottom = ri > 0 ? Math.max(...rows[ri - 1].cards.map(c => c.rect.bottom)) : gridRect.top
    const nextTop = ri < rows.length - 1 ? Math.min(...rows[ri + 1].cards.map(c => c.rect.top)) : gridRect.bottom
    const y = (prevBottom + rowTop) / 2
    const y2 = (rowBottom + nextTop) / 2

    for (let i = 0; i < row.cards.length; i++) {
      const left = i === 0 ? gridRect.left : row.cards[i].rect.left
      const right = i === row.cards.length - 1 ? gridRect.right : row.cards[i + 1].rect.left
      const before = i === row.cards.length - 1 ? '' : row.cards[i + 1].card.dataset.key
      zones.push(makeZone(layer, left, y, right - left, y2 - y, before))
    }
  }

  return zones
}

function valueDropZones(card, layer) {
  const values = [...card.querySelectorAll('.val')]
  if (!values.length) return []
  const bodyRect = card.querySelector('.body').getBoundingClientRect()

  // Values are in a CSS grid. Adjacent cells share an edge.
  const cells = values.map(v => ({ v, r: v.getBoundingClientRect() }))
  const zones = []

  // Before first value: a strip at the body edge. Use the first cell's edge.
  const first = cells[0].r
  zones.push(makeZone(layer, bodyRect.left, bodyRect.top, first.left - bodyRect.left, bodyRect.height, values[0].dataset.f))

  // After last value.
  const last = cells[cells.length - 1].r
  zones.push(makeZone(layer, last.right, bodyRect.top, bodyRect.right - last.right, bodyRect.height, ''))

  // Between horizontally adjacent values.
  for (let i = 0; i < cells.length; i++) {
    for (let j = i + 1; j < cells.length; j++) {
      const a = cells[i].r
      const b = cells[j].r
      if (Math.abs(a.right - b.left) < 3 && a.top === b.top) {
        zones.push(makeZone(layer, a.right, a.top, b.left - a.right, a.height, b.v.dataset.f))
      }
    }
  }

  // Between vertically adjacent values.
  for (let i = 0; i < cells.length; i++) {
    for (let j = i + 1; j < cells.length; j++) {
      const a = cells[i].r
      const b = cells[j].r
      if (Math.abs(a.bottom - b.top) < 3 && a.left === b.left) {
        zones.push(makeZone(layer, a.left, a.bottom, a.width, b.top - a.bottom, b.v.dataset.f))
      }
    }
  }

  return zones
}

export function beginDrag(ev, card, val) {
  dragging = {
    key: card.dataset.key, field: val ? val.dataset.f : null,
    x0: ev.clientX, y0: ev.clientY, moved: false, node: val || card,
    ghost: null, pointerId: ev.pointerId, card: card,
  };
}

let resizing = null;

export function currentResize() { return resizing }

export function beginResize(ev, card, w, h) {
  resizing = { key: card.dataset.key, card: card, x0: ev.clientX, y0: ev.clientY,
               w0: w, h0: h, w: w, h: h, pointerId: ev.pointerId };
  card.setPointerCapture(ev.pointerId);
}

function resizeMove(ev) {
  const r = resizing;
  if (!r || ev.pointerId !== r.pointerId) return;
  const g = gridSize();
  r.w = Math.max(1, Math.min(g.cols, r.w0 + Math.round((ev.clientX - r.x0) / cell)));
  r.h = Math.max(1, Math.min(g.rows, r.h0 + Math.round((ev.clientY - r.y0) / cell)));
  r.card.style.gridColumn = "span " + r.w;
  r.card.style.gridRow = "span " + r.h;
}

function endResize(ev) {
  const r = resizing;
  if (!r || ev.pointerId !== r.pointerId) return;
  resizing = null;
  // A gesture that ends at the size it started from expressed no intent to
  // resize, so it must not overwrite a stored size the current grid clamps.
  if (r.w !== r.w0 || r.h !== r.h0) setCardSize(r.key, r.w, r.h);
  requestRender();
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
    d.ghost = el("div", "ghostcard", d.field ? splitUnit(d.field).name : displayName(d.key));
    document.body.append(d.ghost);
    d.node.classList.add("lifting");
    d.zones = d.field
      ? valueDropZones(d.card, createDropLayer(d.card.querySelector('.body'), 'value'))
      : cardDropZones(createDropLayer(document.getElementById('cards'), 'card'))
  }
  d.ghost.style.left = ev.clientX + 12 + "px";
  d.ghost.style.top = ev.clientY + 12 + "px";

  let active = null
  for (const z of d.zones || []) {
    const r = z.getBoundingClientRect()
    if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) {
      active = z
      break
    }
  }
  // Fall back to nearest center if no zone contains the pointer.
  if (!active) {
    let best = Infinity
    for (const z of d.zones || []) {
      const r = z.getBoundingClientRect()
      const cx = r.left + r.width / 2
      const cy = r.top + r.height / 2
      const dist = Math.hypot(ev.clientX - cx, ev.clientY - cy)
      if (dist < best) { best = dist; active = z }
    }
  }
  for (const z of d.zones || []) z.classList.toggle('active', z === active)
}

function endDrag(ev) {
  const d = dragging;
  if (!d || ev.pointerId !== d.pointerId) return;
  dragging = null;
  d.card.cancelPress();
  if (d.ghost) d.ghost.remove();
  d.node.classList.remove('lifting');
  if (!d.moved) return;

  if (d.zones) {
    const active = d.zones.find(z => z.classList.contains('active'));
    if (active) {
      const before = active.dataset.before || null;
      if (d.field) moveValue(d.key, d.field, before)
      else moveCard(d.key, before)
    }
  }
  clearDropZones()
  requestRender()
}

let installed = false;

// On the document, not the card: capture is only taken once the gesture crosses
// the slop, so before that a pointer leaving the card would strand the drag and
// rendering would stay suppressed forever. Registered once, since a render
// replaces every card element on every tick.
export function installGestures() {
  if (installed) return;
  installed = true;
  document.addEventListener("pointermove", ev => { dragMove(ev); resizeMove(ev); });
  document.addEventListener("pointerup", ev => { endDrag(ev); endResize(ev); });
  document.addEventListener("pointercancel", ev => { endDrag(ev); endResize(ev); });
}
