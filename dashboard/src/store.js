import { signal } from '@preact/signals'
import { devices } from './devices.js'
import { aliases, isSelf, isFeed, sourceOf } from './alias.js'
import { STATUS_FIELDS } from './units.js'

const CARDS_KEY = 'rtl433.dashboard.v1'

export const cardState = signal(blankState())
let storageBroken = false
let hideNewCards = true

const GRID_MIN = 1, GRID_MAX = 24

// layout_template.js registers here rather than store.js importing it, which
// would close an import cycle. A visitor's own edit ends the site default's
// claim on the arrangement; a card merely appearing is not an edit.
let onEdit = () => {}
export function setEditHook(fn) { onEdit = fn }

function blankState() {
  return { grid: { cols: 6, rows: 4 }, order: [], hidden: [], cards: Object.create(null) }
}

export function gridNum(v, fallback) {
  return Number.isInteger(v) && v >= GRID_MIN && v <= GRID_MAX ? v : fallback
}

function clampGrid(v, fallback) {
  return Number.isInteger(v) ? Math.min(GRID_MAX, Math.max(GRID_MIN, v)) : fallback
}

function bump(s) {
  s = s || cardState.value
  cardState.value = {
    grid: { ...s.grid },
    order: [...s.order],
    hidden: [...s.hidden],
    cards: Object.assign(Object.create(null), s.cards),
  }
}

export function defaultSize(count) {
  const v = Math.max(1, count)
  const w = Math.ceil(Math.sqrt(v))
  return { w: w, h: Math.ceil(v / w) }
}

export function loadCardState() {
  cardState.value = blankState()
  let raw
  try {
    raw = localStorage.getItem(CARDS_KEY)
  } catch (e) { storageBroken = true; return }
  if (!raw) return
  let s
  try { s = JSON.parse(raw) } catch (e) { return }
  if (!s || typeof s !== 'object') return
  const g = s.grid && typeof s.grid === 'object' ? s.grid : {}
  const loaded = {
    grid: { cols: gridNum(g.cols, 6), rows: gridNum(g.rows, 4) },
    order: Array.isArray(s.order) ? s.order.filter(k => typeof k === 'string') : [],
    hidden: Array.isArray(s.hidden) ? s.hidden.filter(k => typeof k === 'string') : [],
    cards: Object.create(null),
  }
  const cards = s.cards && typeof s.cards === 'object' ? s.cards : {}
  for (const k of Object.keys(cards)) {
    const c = cards[k]
    if (!c || typeof c !== 'object') continue
    loaded.cards[k] = {
      w: clampGrid(c.w, 0), h: clampGrid(c.h, 0),
      valueOrder: Array.isArray(c.valueOrder) ? c.valueOrder.filter(f => typeof f === 'string') : [],
      hiddenValues: Array.isArray(c.hiddenValues) ? c.hiddenValues.filter(f => typeof f === 'string') : [],
      bottomValues: Array.isArray(c.bottomValues) ? c.bottomValues.filter(f => typeof f === 'string') : [],
    }
  }
  loaded.order = loaded.order.filter(k => loaded.cards[k])
  loaded.hidden = loaded.hidden.filter(k => loaded.cards[k])
  cardState.value = loaded
}

function pruneCardState(s) {
  // Only a source that has already delivered something can say one of its
  // devices is gone. At boot devices.value is empty, and primeFeeds() saves
  // before any stream has opened, so pruning against it there threw away every
  // hidden card's saved size and left the Receiver card -- the one card
  // ensureCard() never re-hides -- showing again on every page load.
  const spoken = new Set()
  for (const k of devices.value.keys()) spoken.add(sourceOf(k))
  // A feed with no location set has no device record yet; dropping it here
  // would discard its saved size and value layout before it ever runs.
  const keep = new Set(s.order.filter(
    k => devices.value.has(k) || isFeed(k) || !cardHidden(k) || aliases.value.has(k) ||
      !spoken.has(sourceOf(k))))
  const cards = Object.create(null)
  for (const k of Object.keys(s.cards)) if (keep.has(k)) cards[k] = s.cards[k]
  return {
    grid: s.grid,
    order: s.order.filter(k => keep.has(k)),
    hidden: s.hidden.filter(k => keep.has(k)),
    cards,
  }
}

export function saveCardState() {
  if (storageBroken) return
  const pruned = pruneCardState(cardState.value)
  try { localStorage.setItem(CARDS_KEY, JSON.stringify(pruned)) }
  catch (e) { storageBroken = true }
  bump(pruned)
}

export function ensureCard(key, merged, opts) {
  const s = cardState.value
  let c = s.cards[key]
  const fields = Object.keys(merged || {})
  let changed = false
  if (!c) {
    // A feed may nominate values that exist but are not what the card is for,
    // such as the times a composite value already draws. They stay one click
    // away in the devices table.
    const startHidden = (opts && opts.hiddenValues) || []
    c = {
      valueOrder: fields.slice(),
      hiddenValues: fields.filter(f => startHidden.indexOf(f) >= 0),
      bottomValues: fields.filter(f => STATUS_FIELDS.has(f)),
    }
    s.cards[key] = c
    changed = true
    // autoShow only applies to a card being created. Applying it on every
    // call would undo a later user hide every time the card refreshed.
    const autoShow = opts && opts.autoShow
    if (hideNewCards && !autoShow && !isSelf(key) && s.hidden.indexOf(key) < 0) {
      s.hidden.push(key)
    }
  } else {
    if (!c.bottomValues) { c.bottomValues = []; changed = true }
    for (const f of fields) {
      if (c.valueOrder.indexOf(f) >= 0) continue
      c.valueOrder.push(f)
      if (STATUS_FIELDS.has(f)) c.bottomValues.push(f)
      changed = true
    }
  }
  if (!c.w || !c.h) {
    // Compute visible values directly from c to avoid prototype pollution issues
    const vis = c.valueOrder.filter(f =>
      merged[f] !== undefined &&
      (c.hiddenValues || []).indexOf(f) < 0 &&
      (c.bottomValues || []).indexOf(f) < 0
    )
    const size = defaultSize(vis.length)
    c.w = size.w
    c.h = size.h
    changed = true
  }
  if (s.order.indexOf(key) < 0) { s.order.push(key); changed = true }
  const save = !opts || opts.save !== false
  if (changed && save) saveCardState()
  return c
}

export function cardEntry(key) { return cardState.value.cards[key] }

export function getCardState() { return cardState.value }

export function setCardState(s) { cardState.value = s }

export function valueMode(key, field) {
  const c = cardState.value.cards[key]
  if (!c) return 'shown'
  if (c.hiddenValues.indexOf(field) >= 0) return 'hidden'
  if (c.bottomValues && c.bottomValues.indexOf(field) >= 0) return 'bottom'
  return 'shown'
}

export function setValueMode(key, field, mode) {
  const c = cardState.value.cards[key]
  if (!c) return
  if (!c.bottomValues) c.bottomValues = []
  for (const list of [c.hiddenValues, c.bottomValues]) {
    const i = list.indexOf(field)
    if (i >= 0) list.splice(i, 1)
  }
  if (mode === 'hidden') c.hiddenValues.push(field)
  else if (mode === 'bottom') c.bottomValues.push(field)
  onEdit()
  saveCardState()
}

export function visibleValues(key, merged) {
  const c = cardState.value.cards[key]
  if (!c) return []
  return c.valueOrder.filter(f => merged[f] !== undefined && valueMode(key, f) === 'shown')
}

export function bottomFields(key, merged) {
  const c = cardState.value.cards[key]
  if (!c) return []
  return c.valueOrder.filter(f => merged[f] !== undefined && valueMode(key, f) === 'bottom')
}

export function cardFields(key, merged) {
  const c = cardState.value.cards[key]
  return c ? c.valueOrder.filter(f => merged[f] !== undefined) : Object.keys(merged)
}

export function cardHidden(key) { return cardState.value.hidden.indexOf(key) >= 0 }

export function setCardHidden(key, hidden) {
  const s = cardState.value
  const i = s.hidden.indexOf(key)
  if (hidden === (i >= 0)) return
  if (hidden) s.hidden.push(key); else s.hidden.splice(i, 1)
  onEdit()
  saveCardState()
}

export function orderedKeys() { return cardState.value.order.filter(k => devices.value.has(k)) }

export function moveCard(key, beforeKey) {
  const s = cardState.value
  const order = s.order
  const from = order.indexOf(key)
  if (from < 0 || beforeKey === key) return
  order.splice(from, 1)
  const to = beforeKey === null ? order.length : order.indexOf(beforeKey)
  order.splice(to < 0 ? order.length : to, 0, key)
  onEdit()
  saveCardState()
}

export function moveValue(key, field, beforeField) {
  const c = cardState.value.cards[key]
  if (!c) return
  const order = c.valueOrder
  const from = order.indexOf(field)
  if (from < 0 || beforeField === field) return
  order.splice(from, 1)
  const to = beforeField === null ? order.length : order.indexOf(beforeField)
  order.splice(to < 0 ? order.length : to, 0, field)
  onEdit()
  saveCardState()
}

export function setCardSize(key, w, h) {
  const s = cardState.value
  let c = s.cards[key]
  if (!c) {
    c = { valueOrder: [], hiddenValues: [], bottomValues: [] }
    s.cards[key] = c
  }
  c.w = w
  c.h = h
  onEdit()
  saveCardState()
}

export function grid() { return cardState.value.grid }

export function setGrid(axis, n) {
  const v = gridNum(n, 0)
  if (v) {
    cardState.value = {
      ...cardState.value,
      grid: { ...cardState.value.grid, [axis]: v },
    }
    onEdit()
    saveCardState()
  }
}

export function forgetLayouts() {
  try { localStorage.removeItem(CARDS_KEY) } catch (e) { storageBroken = true }
  const hideNew = hideNewCards
  hideNewCards = false
  try {
    cardState.value = blankState()
    // ensureCard's own save would immediately re-write the storage this just
    // cleared, so each call opts out and bump() below installs the result once.
    for (const rec of devices.value.values()) ensureCard(rec.key, rec.merged.value, { save: false })
    bump()
  } finally {
    hideNewCards = hideNew
  }
}

export function setHideNewCards(v) { hideNewCards = v }
