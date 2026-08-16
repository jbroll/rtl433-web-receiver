import { moveCard, moveValue, setCardSize, grid as gridSize } from './store.js'
import { displayName } from './alias.js'
import { splitUnit } from './units.js'
import { signal } from '@preact/signals'

const $ = (id) => document.getElementById(id)

let cell = 150

export function cellSide() { return cell }

export const cellSignal = signal(cell)

export function measureGrid() {
  const grid = $("cards")
  if (!grid || grid.clientWidth <= 0) return
  const g = gridSize()
  const cs = getComputedStyle(grid)
  const width = grid.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
  const height = window.innerHeight - grid.getBoundingClientRect().top
                 - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)
  cell = Math.max(20, Math.min(width / g.cols, height / g.rows))
  cellSignal.value = cell
  grid.style.setProperty("--cell", cell + "px")
  grid.style.gridTemplateColumns = "repeat(" + g.cols + ",var(--cell))"
  grid.style.gridTemplateRows = "repeat(" + g.rows + ",var(--cell))"
  computeUniformFontSize()
}

const FONT_MIN = 11
export { FONT_MIN }

function fontPxBase(cellPx) {
  const px = Math.round(0.42 * cellPx)
  return Math.max(FONT_MIN, px) + "px"
}

let uniformFontSize = ""

export function computeUniformFontSize() {
  uniformFontSize = fontPxBase(cellSignal.value)
}

export function valueFont() {
  return uniformFontSize
}

let textProbe = null, probeFont = ""
export function textWidthEm(num, unit) {
  if (!textProbe) {
    textProbe = document.createElement("canvas").getContext("2d")
    probeFont = getComputedStyle(document.body).fontFamily
  }
  textProbe.font = "100px " + probeFont
  let w = textProbe.measureText(num).width
  if (unit) {
    textProbe.font = "50px " + probeFont
    w += textProbe.measureText(unit).width + 5
  }
  return w / 100
}

let fitting = []

export function trackFit(node, card, em, rowHeight) {
  fitting.push({ node: node, card: card, em: em, rowHeight: rowHeight })
}

export function resetFit() {
  fitting = []
}

export function fitValues() {
  const boxes = fitting.map(f => f.node.parentNode.clientWidth)
  let globalCap = Infinity
  fitting.forEach((f, i) => {
    if (!boxes[i]) return
    const cap = Math.floor(boxes[i] / f.em)
    if (cap < globalCap) globalCap = cap
  })
  if (!isFinite(globalCap)) globalCap = 200
  for (const f of fitting) {
    const rowH = f.rowHeight || f.node.parentNode.clientHeight
    const fnH = 18
    const availH = Math.max(FONT_MIN, rowH - fnH)
    const newSize = Math.max(FONT_MIN, Math.min(globalCap, availH, 200))
    f.node.style.fontSize = newSize + "px"
  }
  fitting = []
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

function dropSlot(nodes, from, x, y) {
  let best = from, far = Infinity
  nodes.forEach((n, i) => {
    const r = n.getBoundingClientRect()
    const d = Math.hypot(x - r.left - r.width / 2, y - r.top - r.height / 2)
    if (d < far) { far = d; best = i }
  })
  return nodes[best > from ? best + 1 : best] || null
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
  r.w = Math.max(1, Math.min(g.cols, r.w0 + Math.round((ev.clientX - r.x0) / cell)))
  r.h = Math.max(1, Math.min(g.rows, r.h0 + Math.round((ev.clientY - r.y0) / cell)))
  r.card.style.gridColumn = "span " + r.w
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
    d.ghost = document.createElement("div")
    d.ghost.className = "ghostcard"
    d.ghost.textContent = d.field ? splitUnit(d.field).name : displayName(d.key)
    document.body.append(d.ghost)
    d.node.classList.add("lifting")
  }
  d.ghost.style.left = ev.clientX + 12 + "px"
  d.ghost.style.top = ev.clientY + 12 + "px"
}

function endDrag(ev) {
  const d = dragging.value
  if (!d || ev.pointerId !== d.pointerId) return
  dragging.value = null
  if (d.card.cancelPress) d.card.cancelPress()
  if (d.ghost) d.ghost.remove()
  d.node.classList.remove("lifting")
  if (!d.moved) return
  const nodes = d.field ? [...d.card.querySelectorAll(".val")]
                        : [...document.querySelectorAll("#cards .card")]
  const before = dropSlot(nodes, nodes.indexOf(d.node), ev.clientX, ev.clientY)
  if (before !== d.node) {
    if (d.field) moveValue(d.key, d.field, before ? before.dataset.f : null)
    else moveCard(d.key, before ? before.dataset.key : null)
  }
}

let installed = false

export function installGestures() {
  if (installed) return
  installed = true
  document.addEventListener("pointermove", ev => { dragMove(ev); resizeMove(ev) })
  document.addEventListener("pointerup", ev => { endDrag(ev); endResize(ev) })
  document.addEventListener("pointercancel", ev => { endDrag(ev); endResize(ev) })
}