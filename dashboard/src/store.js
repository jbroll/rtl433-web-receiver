import { devices } from './devices.js'
import { aliases, isSelf } from './alias.js'
import { STATUS_FIELDS } from './units.js'
import { requestRender } from './render.js'

const CARDS_KEY = 'rtl433.dashboard.v1'

let cardState = blankState()
let storageBroken = false

// A decode from a protocol nobody owns still makes a device, so a new one gets
// no card until the device table's checkbox asks for one. The receiver's own
// telemetry is the one device that cannot be noise, so it starts shown.
let hideNewCards = true

const GRID_MIN = 1, GRID_MAX = 24

// Null prototype: a stored "__proto__" key must not become a prototype link.
function blankState() {
  return { grid: { cols: 6, rows: 4 }, order: [], hidden: [], cards: Object.create(null) }
}

function gridNum(v, fallback) {
  return Number.isInteger(v) && v >= GRID_MIN && v <= GRID_MAX ? v : fallback
}

function defaultSize(count) {
  const v = Math.max(1, count)
  const w = Math.ceil(Math.sqrt(v))
  return { w: w, h: Math.ceil(v / w) }
}

export function loadCardState() {
  cardState = blankState()
  let raw
  try {
    raw = localStorage.getItem(CARDS_KEY)
  } catch (e) { storageBroken = true; return }
  if (!raw) return
  let s
  try { s = JSON.parse(raw) } catch (e) { return }
  if (!s || typeof s !== 'object') return
  const g = s.grid && typeof s.grid === 'object' ? s.grid : {}
  cardState = {
    grid: { cols: gridNum(g.cols, 6), rows: gridNum(g.rows, 4) },
    order: Array.isArray(s.order) ? s.order.filter(k => typeof k === 'string') : [],
    hidden: Array.isArray(s.hidden) ? s.hidden.filter(k => typeof k === 'string') : [],
    cards: Object.create(null),
  }
  const cards = s.cards && typeof s.cards === 'object' ? s.cards : {}
  for (const k of Object.keys(cards)) {
    const c = cards[k]
    if (!c || typeof c !== 'object') continue
    cardState.cards[k] = {
      w: gridNum(c.w, 0), h: gridNum(c.h, 0),
      valueOrder: Array.isArray(c.valueOrder) ? c.valueOrder.filter(f => typeof f === 'string') : [],
      hiddenValues: Array.isArray(c.hiddenValues) ? c.hiddenValues.filter(f => typeof f === 'string') : [],
      bottomValues: Array.isArray(c.bottomValues) ? c.bottomValues.filter(f => typeof f === 'string') : [],
    }
  }
}

// Every key ever decoded seeds a card, and a 433 band yields one-off noise for
// as long as it is listened to, so without this order/hidden/cards grow until
// localStorage refuses the write. An entry the user acted on is kept whether or
// not its device is still around; one they never showed goes with the device.
function pruneCardState() {
  const keep = new Set(cardState.order.filter(
    k => devices.has(k) || !cardHidden(k) || aliases.has(k)))
  cardState.order = cardState.order.filter(k => keep.has(k))
  cardState.hidden = cardState.hidden.filter(k => keep.has(k))
  for (const k of Object.keys(cardState.cards)) if (!keep.has(k)) delete cardState.cards[k]
}

export function saveCardState() {
  if (storageBroken) return
  pruneCardState()
  try { localStorage.setItem(CARDS_KEY, JSON.stringify(cardState)) }
  catch (e) { storageBroken = true }
}

export function ensureCard(key, merged) {
  let c = cardState.cards[key]
  const fields = Object.keys(merged || {})
  if (!c) {
    c = {
      valueOrder: fields.slice(),
      hiddenValues: [],
      bottomValues: fields.filter(f => STATUS_FIELDS.has(f)),
    }
    cardState.cards[key] = c
    if (hideNewCards && !isSelf(key) && cardState.hidden.indexOf(key) < 0) {
      cardState.hidden.push(key)
    }
  } else {
    if (!c.bottomValues) c.bottomValues = []
    for (const f of fields) {
      if (c.valueOrder.indexOf(f) >= 0) continue
      c.valueOrder.push(f)
      if (STATUS_FIELDS.has(f)) c.bottomValues.push(f)
    }
  }
  if (!c.w || !c.h) {
    const size = defaultSize(visibleValues(key, merged).length)
    c.w = size.w
    c.h = size.h
  }
  if (cardState.order.indexOf(key) < 0) cardState.order.push(key)
  return c
}

export function cardEntry(key) { return cardState.cards[key] }

// A value is shown in the body, shown small along the bottom edge, or not at
// all. Anything a card stored before bottom values existed reads as shown.
export function valueMode(key, field) {
  const c = cardState.cards[key]
  if (!c) return 'shown'
  if (c.hiddenValues.indexOf(field) >= 0) return 'hidden'
  if (c.bottomValues && c.bottomValues.indexOf(field) >= 0) return 'bottom'
  return 'shown'
}

export function setValueMode(key, field, mode) {
  const c = cardState.cards[key]
  if (!c) return
  if (!c.bottomValues) c.bottomValues = []
  for (const list of [c.hiddenValues, c.bottomValues]) {
    const i = list.indexOf(field)
    if (i >= 0) list.splice(i, 1)
  }
  if (mode === 'hidden') c.hiddenValues.push(field)
  else if (mode === 'bottom') c.bottomValues.push(field)
  saveCardState()
  requestRender()
}

export function visibleValues(key, merged) {
  const c = cardState.cards[key]
  if (!c) return []
  return c.valueOrder.filter(f => merged[f] !== undefined && valueMode(key, f) === 'shown')
}

export function bottomFields(key, merged) {
  const c = cardState.cards[key]
  if (!c) return []
  return c.valueOrder.filter(f => merged[f] !== undefined && valueMode(key, f) === 'bottom')
}

export function cardFields(key, merged) {
  const c = cardState.cards[key]
  return c ? c.valueOrder.filter(f => merged[f] !== undefined) : Object.keys(merged)
}

export function cardHidden(key) { return cardState.hidden.indexOf(key) >= 0 }

export function setCardHidden(key, hidden) {
  const i = cardState.hidden.indexOf(key)
  if (hidden === (i >= 0)) return
  if (hidden) cardState.hidden.push(key); else cardState.hidden.splice(i, 1)
  saveCardState()
  requestRender()
}

export function orderedKeys() { return cardState.order.filter(k => devices.has(k)) }

export function moveCard(key, beforeKey) {
  const order = cardState.order
  const from = order.indexOf(key)
  if (from < 0) return
  order.splice(from, 1)
  const to = beforeKey === null ? order.length : order.indexOf(beforeKey)
  order.splice(to < 0 ? order.length : to, 0, key)
  saveCardState()
  requestRender()
}

export function moveValue(key, field, beforeField) {
  const c = cardState.cards[key]
  if (!c) return
  const order = c.valueOrder
  const from = order.indexOf(field)
  if (from < 0) return
  order.splice(from, 1)
  const to = beforeField === null ? order.length : order.indexOf(beforeField)
  order.splice(to < 0 ? order.length : to, 0, field)
  saveCardState()
  requestRender()
}

export function setCardSize(key, w, h) {
  const c = cardState.cards[key]
  if (c) { c.w = w; c.h = h; saveCardState() }
}

export function grid() { return cardState.grid }

export function setGrid(axis, n) {
  const v = gridNum(n, 0)
  if (v) {
    cardState.grid[axis] = v
    saveCardState()
  }
}

export function forgetLayouts() {
  try { localStorage.removeItem(CARDS_KEY) } catch (e) { storageBroken = true }
  cardState = blankState()
  // The devices on screen were opted into once already, so re-seed them shown.
  // Under the hide-new rule this would blank the dashboard rather than reset it.
  const hideNew = hideNewCards
  hideNewCards = false
  requestRender()
  hideNewCards = hideNew
}

export function setHideNewCards(v) { hideNewCards = v }
