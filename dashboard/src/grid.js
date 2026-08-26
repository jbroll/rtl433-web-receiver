import { moveCard, moveValue, setCardSize, grid as gridSize } from './store.js'
import { el } from './units.js'
import { signal } from '@preact/signals'

const $ = (id) => document.getElementById(id)

let cell = 150

export const cellSignal = signal(cell)

// The width below which a cell stops being legible: at 110px a 390px phone
// gets 3 columns rather than the 6 the saved desktop layout asks for.
const MIN_CELL = 110

let viewColsN = 6

export function viewCols() { return viewColsN }

export const viewColsSignal = signal(viewColsN)

// Call counts a test can read to confirm the effects that invoke these
// aren't re-running when nothing they depend on changed.
let measureGridCalls = 0
let fitValuesCalls = 0
export function measureGridCallCount() { return measureGridCalls }
export function fitValuesCallCount() { return fitValuesCalls }

export function measureGrid() {
  measureGridCalls++
  const grid = $("cards")
  if (!grid || grid.clientWidth <= 0) return
  const g = gridSize()
  const cs = getComputedStyle(grid)
  const colGap = parseFloat(cs.columnGap) || 0
  const rowGap = parseFloat(cs.rowGap) || 0
  const width = grid.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
  // rect.top is viewport-relative, so scroll position would shift the fit.
  const top = grid.getBoundingClientRect().top + window.scrollY
  const height = window.innerHeight - top
                 - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)
  const widthCols = Math.max(1, Math.min(Math.floor((width + colGap) / (MIN_CELL + colGap)), g.cols))
  // A short window fits fewer rows at MIN_CELL than needed, so raise cols,
  // up to what's saved, to keep the card count's rows within the height.
  const cardCount = grid.children.length
  const maxRowsForHeight = Math.max(1, Math.floor((height + rowGap) / (MIN_CELL + rowGap)))
  const heightCols = cardCount > 0 ? Math.min(g.cols, Math.ceil(cardCount / maxRowsForHeight)) : 1
  const cols = Math.max(widthCols, heightCols)
  viewColsN = cols
  viewColsSignal.value = cols
  const usableWidth = width - (cols - 1) * colGap
  const usableHeight = height - (g.rows - 1) * rowGap
  if (cols < g.cols) {
    // Fewer columns means more rows than the screen holds. Fitting them all is
    // what produced the unreadable cell; the page scrolls instead.
    cell = usableWidth / cols
  } else {
    // The 20px floor is a legibility minimum, not a guarantee: honoring it when
    // the viewport can't fit g.cols at 20px would overflow the page sideways.
    const fit = Math.min(usableWidth / cols, usableHeight / g.rows)
    cell = usableWidth / cols >= 20 ? Math.max(20, fit) : fit
  }
  cellSignal.value = cell
  grid.style.setProperty("--cell", cell + "px")
  grid.style.gridTemplateColumns = "repeat(" + cols + ",var(--cell))"
  grid.style.gridTemplateRows = cols < g.cols ? "" : "repeat(" + g.rows + ",var(--cell))"
}

const FONT_MIN = 11
const FONT_MAX = 200
export { FONT_MIN }

// See docs/architecture.md's "Value fit" for why 0.6.
const PAGE_FLOOR_RATIO = 0.6

let fitting = new Map()

let textProbe = null
// A tracked .fv node carries the real letter-spacing and font-feature
// settings; probing document.body would miss a change scoped to .fv.
function probeNode() {
  const tracked = fitting.values().next().value
  // fitValues() purges an unmounted node from `fitting` as it iterates, but a
  // call outside that loop (every renderer's textWidthEm()) can land between a
  // card unmounting and the next fitValues() run. getComputedStyle on a
  // detached node returns all-empty strings, so fall back rather than measure
  // against nothing: cs.font becomes a no-op assignment and fontSizePx defaults
  // to 100, giving an em far too small.
  if (tracked && tracked.node.isConnected) return tracked.node
  return document.querySelector(".card .fv")
}

// Sets textProbe's font/letter-spacing/etc. from the probe node's computed
// style and returns the values measureEm() needs. Split from textWidthEm()
// so fitValues() can call this once per run instead of once per node.
function primeTextProbe() {
  if (!textProbe) textProbe = document.createElement("canvas").getContext("2d")
  const cs = getComputedStyle(probeNode() || document.body)
  // cs.font (the shorthand) serializes to "" once a Level 3 font-variant
  // longhand like tabular-nums is non-initial, so build it from parts.
  textProbe.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
  const hasCtxSpacing = "letterSpacing" in textProbe
  if (hasCtxSpacing) textProbe.letterSpacing = cs.letterSpacing
  if ("fontStretch" in textProbe) textProbe.fontStretch = cs.fontStretch
  if ("fontFeatureSettings" in textProbe) textProbe.fontFeatureSettings = cs.fontFeatureSettings
  return {
    extraPerChar: hasCtxSpacing ? 0 : (parseFloat(cs.letterSpacing) || 0),
    fontSizePx: parseFloat(cs.fontSize) || 100,
  }
}

function measureEm(num, { extraPerChar, fontSizePx }) {
  const width = textProbe.measureText(num).width + extraPerChar * num.length
  return width / fontSizePx
}

// The unit renders in the .fn header, not beside the number, so only the
// number's width bounds the type size.
export function textWidthEm(num) {
  return measureEm(num, primeTextProbe())
}

// num, not a precomputed em: textWidthEm() runs fresh in fitValues(), so a
// CSS-only change (letter-spacing, font-feature-settings) needs no re-render.
export function trackFit(node, num) {
  fitting.set(node, { node: node, num: num })
}

export function fittingSize() { return fitting.size }

// Used only when --val-line-height is unreadable (no .val parent mounted
// yet). Must track the property's value in style.css (.card .val).
const DEFAULT_LINE_HEIGHT = 1.05

export function fitValues() {
  fitValuesCalls++
  let global = FONT_MAX
  let lineHeight = null
  let probe = null
  const boxes = []
  const fits = []
  for (const f of fitting.values()) {
    if (!f.node.isConnected) { fitting.delete(f.node); continue }
    const parent = f.node.parentNode
    if (!parent) continue
    const box = parent.clientWidth
    const rowH = parent.clientHeight
    // A hidden tab measures zero. Fitting to that would drop every value to the
    // floor, and nothing re-measures when the tab comes back.
    if (box <= 0 || rowH <= 0) continue
    // Read --val-line-height once per run; it's the same custom property everywhere.
    if (lineHeight === null) {
      lineHeight = parseFloat(getComputedStyle(parent).getPropertyValue("--val-line-height"))
        || DEFAULT_LINE_HEIGHT
    }
    // probeNode() returns the same node every iteration; prime the canvas
    // font once instead of on every measureEm() call.
    if (probe === null) probe = primeTextProbe()
    const fn = parent.querySelector(".fn")
    const availH = Math.floor((rowH - (fn ? fn.offsetHeight : 0)) / lineHeight)
    const fit = Math.min(Math.floor(box / measureEm(f.num, probe)), availH)
    fits.push(fit)
    if (fit < global) global = fit
    boxes.push(f.node)
  }
  // A single crowded box would otherwise set the size for the whole page;
  // floor it at PAGE_FLOOR_RATIO of the median so that box ellipsizes alone.
  if (fits.length) {
    const sorted = [...fits].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
    global = Math.max(global, PAGE_FLOOR_RATIO * median)
  }
  // One size for the whole page: the largest the tightest value box allows.
  const size = Math.max(FONT_MIN, global) + "px"
  for (const node of boxes) node.style.fontSize = size
}

export const editing = signal(false)
export const renaming = signal(false)
export const dragging = signal(null)
export const resizing = signal(null)

export function setEditing(v) { editing.value = v }

export function setRenaming(v) { renaming.value = v }

export function gestureInFlight() { return !!(dragging.value || resizing.value || renaming.value) }

export function currentDrag() { return dragging.value }

export function cancelDrag(key) {
  if (dragging.value && dragging.value.key === key) dragging.value = null
}

const CLICK_SLOP = 6

function makeZone(layer, left, top, width, height, before) {
  const z = el('div', 'drop-zone')
  const r = layer.getBoundingClientRect()
  z.style.position = 'absolute'
  z.style.left = (left - r.left) + 'px'
  z.style.top = (top - r.top) + 'px'
  z.style.width = Math.max(0, width) + 'px'
  z.style.height = Math.max(0, height) + 'px'
  z.dataset.before = before
  layer.append(z)
  return z
}

function createDropLayer(container, kind) {
  const layer = el('div', 'drop-layer ' + kind + '-layer')
  const r = container.getBoundingClientRect()
  layer.style.position = 'fixed'
  layer.style.left = r.left + 'px'
  layer.style.top = r.top + 'px'
  layer.style.width = r.width + 'px'
  layer.style.height = r.height + 'px'
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
  const first = rows[0].cards[0].rect
  zones.push(makeZone(layer, gridRect.left, first.top, first.left - gridRect.left, first.height, rows[0].cards[0].card.dataset.key))

  const lastRow = rows[rows.length - 1]
  const last = lastRow.cards[lastRow.cards.length - 1]
  zones.push(makeZone(layer, last.rect.right, last.rect.top, gridRect.right - last.rect.right, last.rect.height, ''))

  for (const row of rows) {
    for (let i = 0; i < row.cards.length - 1; i++) {
      const a = row.cards[i].rect
      const b = row.cards[i + 1]
      zones.push(makeZone(layer, a.right, a.top, b.rect.left - a.right, a.height, b.card.dataset.key))
    }
  }

  for (let i = 0; i < rows.length - 1; i++) {
    const tops = rows[i].cards.map(c => c.rect.bottom)
    const bottoms = rows[i + 1].cards.map(c => c.rect.top)
    const y = Math.max(...tops)
    const y2 = Math.min(...bottoms)
    // Rows can interleave when a tall card spans both, leaving no gap.
    if (y2 - y <= 0) continue
    zones.push(makeZone(layer, gridRect.left, y, gridRect.width, y2 - y, rows[i + 1].cards[0].card.dataset.key))
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

function makeGhost(node) {
  const g = node.cloneNode(true)
  g.classList.add('ghostcard')
  const r = node.getBoundingClientRect()
  g.style.width = r.width + 'px'
  g.style.height = r.height + 'px'
  return g
}

export function beginDrag(ev, card, val) {
  dragging.value = {
    key: card.dataset.key, field: val ? val.dataset.f : null,
    x0: ev.clientX, y0: ev.clientY, moved: false, node: val || card,
    ghost: null, pointerId: ev.pointerId, card: card,
  }
}

export function currentResize() { return resizing.value }

export function beginResize(ev, card, w, h) {
  resizing.value = { key: card.dataset.key, card: card, x0: ev.clientX, y0: ev.clientY,
                     w0: w, h0: h, w: w, h: h, pointerId: ev.pointerId }
  card.setPointerCapture(ev.pointerId)
}

function resizeMove(ev) {
  const r = resizing.value
  if (!r || ev.pointerId !== r.pointerId) return
  const g = gridSize()
  // A card cannot be dragged wider than the grid on screen, but one already
  // stored wider keeps that width unless the drag itself narrows it.
  r.w = Math.max(1, Math.min(Math.max(viewCols(), r.w0), r.w0 + Math.round((ev.clientX - r.x0) / cell)))
  r.h = Math.max(1, Math.min(g.rows, r.h0 + Math.round((ev.clientY - r.y0) / cell)))
  r.card.style.gridColumn = "span " + Math.min(r.w, viewCols())
  r.card.style.gridRow = "span " + r.h
}

function endResize(ev) {
  const r = resizing.value
  if (!r || ev.pointerId !== r.pointerId) return
  resizing.value = null
  if (r.w !== r.w0 || r.h !== r.h0) setCardSize(r.key, r.w, r.h)
}

function dragMove(ev) {
  const d = dragging.value
  if (!d || ev.pointerId !== d.pointerId) return
  if (!d.moved) {
    if (Math.hypot(ev.clientX - d.x0, ev.clientY - d.y0) < CLICK_SLOP) return
    d.moved = true
    d.card.setPointerCapture(d.pointerId)
    if (d.card.cancelPress) d.card.cancelPress()
    const ghostNode = d.field ? d.node : d.card
    const gRect = ghostNode.getBoundingClientRect()
    d.gdx = gRect.left - d.x0
    d.gdy = gRect.top - d.y0
    d.ghost = makeGhost(ghostNode)
    d.ghost.classList.add(d.field ? 'value-ghost' : 'card-ghost')
    for (const n of d.ghost.querySelectorAll('.cx, .rz')) n.remove()
    document.body.append(d.ghost)
    d.node.classList.add("lifting")

    d.zones = d.field
      ? valueDropZones(d.card, createDropLayer(d.card.querySelector('.body'), 'value'))
      : cardDropZones(createDropLayer(document.getElementById('cards'), 'card'))
  }
  d.ghost.style.left = (ev.clientX + d.gdx) + "px"
  d.ghost.style.top = (ev.clientY + d.gdy) + "px"

  let active = null
  let best = Infinity
  for (const z of d.zones || []) {
    const r = z.getBoundingClientRect()
    // Distance to the zone rect, not its center: a drop inside a big zone must
    // not be stolen by a neighbouring strip whose center happens to be nearer.
    const dx = Math.max(r.left - ev.clientX, 0, ev.clientX - r.right)
    const dy = Math.max(r.top - ev.clientY, 0, ev.clientY - r.bottom)
    const dist = Math.hypot(dx, dy)
    if (dist < best) { best = dist; active = z }
  }
  for (const z of d.zones || []) z.classList.toggle('active', z === active)
}

function endDrag(ev) {
  const d = dragging.value
  if (!d || ev.pointerId !== d.pointerId) return
  dragging.value = null
  if (d.card.cancelPress) d.card.cancelPress()
  if (d.ghost) d.ghost.remove()
  d.node.classList.remove('lifting')

  if (d.moved && d.zones) {
    const active = d.zones.find(z => z.classList.contains('active'))
    if (active) {
      const before = active.dataset.before || null
      if (d.field) moveValue(d.key, d.field, before)
      else moveCard(d.key, before)
    }
  }
  clearDropZones()
}

let installed = false

export function installGestures() {
  if (installed) return
  installed = true
  document.addEventListener("pointermove", ev => { dragMove(ev); resizeMove(ev) })
  document.addEventListener("pointerup", ev => { endDrag(ev); endResize(ev) })
  document.addEventListener("pointercancel", ev => { endDrag(ev); endResize(ev) })
}