import { moveCard, moveValue, setCardSize, grid as gridSize } from './store.js'
import { el } from './units.js'
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
  // rect.top is viewport-relative, so scroll position would shift the fit.
  const top = grid.getBoundingClientRect().top + window.scrollY
  const height = window.innerHeight - top
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

let fitting = new Map()

export function trackFit(node, card, em, rowHeight) {
  fitting.set(node, { node: node, card: card, em: em, rowHeight: rowHeight })
}

export function resetFit() {
  fitting = new Map()
}

export function fitValues() {
  let globalCap = Infinity
  for (const f of fitting.values()) {
    const parent = f.node.parentNode
    if (!parent || !parent.isConnected) continue
    const box = parent.clientWidth
    if (!box) continue
    const cap = Math.floor(box / f.em)
    if (cap < globalCap) globalCap = cap
  }
  if (!isFinite(globalCap)) globalCap = 200
  for (const f of fitting.values()) {
    if (!f.node.isConnected) continue
    const parent = f.node.parentNode
    const rowH = parent ? parent.clientHeight : f.rowHeight
    const fnH = 18
    const availH = Math.max(FONT_MIN, rowH - fnH)
    const newSize = Math.max(FONT_MIN, Math.min(globalCap, availH, 200))
    f.node.style.fontSize = newSize + "px"
  }
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