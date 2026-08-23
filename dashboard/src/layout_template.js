import { signal, effect } from '@preact/signals'
import { cardState, gridNum, saveCardState, cardHidden, setEditHook } from './store.js'
import { devices } from './devices.js'
import { isFeed, topicOf } from './alias.js'
import { showToast } from './toast.js'

export const LAYOUT_SUFFIX = '/$layout'
export const layouts = signal(new Map())

// One-way latch for the lifetime of the page load -- never re-enabled once
// disabled. A stored local arrangement disables it at boot, and so does the
// visitor's first edit.
let auto = { on: true, template: null, matched: 0, stop: null }

// Watching devices costs a subscriber on every reading, and a browser that
// will never auto-apply must not pay it: the watch starts only once a site
// default has actually arrived, and is torn down the moment it cannot fire
// again.
function watchCards() {
  if (auto.stop) return
  auto.stop = effect(() => { devices.value; runAutoApply() })
}

function unwatchCards() {
  if (!auto.stop) return
  auto.stop()
  auto.stop = null
}

export function disableAutoApply() {
  auto.on = false
  unwatchCards()
}

// Tests only: the latch and the pending template outlive a loadCardState().
export function resetAutoApply() {
  unwatchCards()
  auto = { on: true, template: null, matched: 0, stop: null }
}

setEditHook(disableAutoApply)

// model/id, using the same id/channel/0 tie-break signal_store::buildKey uses
// to key a topic -- a real field the reading itself carries, not something
// the browser made up, and applied uniformly: even the Receiver's own
// pseudo-device, which always reports id 0, gets the slot "Receiver/0".
function slotOf(key) {
  const rec = devices.value.get(key)
  const obj = rec && rec.obj.value
  if (!obj || typeof obj.model !== 'string' || !obj.model) return null
  const id = obj.id !== undefined ? obj.id : (obj.channel !== undefined ? obj.channel : 0)
  return `${obj.model}/${id}`
}

// A feed's key is the same in every browser reading the same receiver -- the
// receiver stores the location and time zone the feeds are computed from -- so
// a feed card belongs in the site default like any other. Its slot is its own
// topic, "feed/Weather", which no model/id slot can collide with.
function cardSlots() {
  const slots = new Map()
  for (const rec of devices.value.values()) {
    const slot = isFeed(rec.key) ? topicOf(rec.key) : slotOf(rec.key)
    if (slot) slots.set(rec.key, slot)
  }
  return slots
}

export function deriveTemplate() {
  const s = cardState.value
  const slotOf = cardSlots()
  const models = Object.create(null)
  const order = []
  for (const key of s.order) {
    const slot = slotOf.get(key)
    if (!slot) continue
    const c = s.cards[key]
    if (!c) continue
    // An empty list and hidden: false are what applyTemplate() already assumes
    // for a missing field, and the blob has to fit LAYOUT_STORE_MAX on the
    // receiver, so omitting them buys about 50 bytes a card.
    const spec = { w: c.w, h: c.h, valueOrder: c.valueOrder.slice() }
    if (c.hiddenValues.length) spec.hiddenValues = c.hiddenValues.slice()
    if (c.bottomValues && c.bottomValues.length) spec.bottomValues = c.bottomValues.slice()
    if (cardHidden(key)) spec.hidden = true
    models[slot] = spec
    order.push(slot)
  }
  return { grid: { cols: s.grid.cols, rows: s.grid.rows }, order, models }
}

export function applyTemplate(template) {
  if (!template || typeof template !== 'object') return
  const s = cardState.value
  const g = template.grid && typeof template.grid === 'object' ? template.grid : {}
  const modelsIn = template.models && typeof template.models === 'object' ? template.models : {}
  const modelOrder = Array.isArray(template.order)
    ? template.order.filter(m => typeof m === 'string')
    : []

  const nextGrid = { cols: gridNum(g.cols, s.grid.cols), rows: gridNum(g.rows, s.grid.rows) }
  const nextCards = Object.assign(Object.create(null), s.cards)

  const keyForSlot = new Map()
  for (const [key, slot] of cardSlots()) keyForSlot.set(slot, key)

  const matched = []
  const seenKeys = new Set()
  const hiddenByKey = new Map()
  for (const slot of modelOrder) {
    const spec = modelsIn[slot]
    if (!spec || typeof spec !== 'object') continue
    const key = keyForSlot.get(slot)
    if (!key || seenKeys.has(key)) continue
    seenKeys.add(key)
    matched.push(key)
    const existing = nextCards[key]
    nextCards[key] = {
      w: gridNum(spec.w, (existing && existing.w) || 1),
      h: gridNum(spec.h, (existing && existing.h) || 1),
      valueOrder: Array.isArray(spec.valueOrder)
        ? spec.valueOrder.filter(f => typeof f === 'string') : [],
      hiddenValues: Array.isArray(spec.hiddenValues)
        ? spec.hiddenValues.filter(f => typeof f === 'string') : [],
      bottomValues: Array.isArray(spec.bottomValues)
        ? spec.bottomValues.filter(f => typeof f === 'string') : [],
    }
    hiddenByKey.set(key, spec.hidden === true)
  }
  // A card the template does not name -- a device that has gone quiet, or one
  // saved before feed cards were carried -- keeps the position it already
  // holds, and the template's own order is dealt back into the positions the
  // rest left. Appending them instead moved every such card to the end of the
  // grid on each Load.
  const queue = matched.slice()
  const nextOrder = []
  for (const key of s.order) {
    if (!seenKeys.has(key)) { nextOrder.push(key); continue }
    const next = queue.shift()
    if (next !== undefined) nextOrder.push(next)
  }
  for (const key of queue) nextOrder.push(key)

  const nextHidden = s.hidden.filter(k => !hiddenByKey.has(k))
  for (const [key, hidden] of hiddenByKey) {
    if (hidden) nextHidden.push(key)
  }

  cardState.value = {
    grid: nextGrid,
    order: nextOrder,
    hidden: nextHidden,
    cards: nextCards,
  }
  saveCardState()
}

// Load has no write, so it carries none of Save's same-origin trust boundary --
// any connected source's stored template is fair game. Picks the first
// configured source (in sources.value order) that has one.
export function layoutForSources(layoutsMap, srcs) {
  for (const base of srcs) {
    const t = layoutsMap.get(base)
    if (t) return t
  }
  return null
}

export function applyLayoutFrame(base, payload) {
  const next = new Map(layouts.value)
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) next.set(base, payload)
  else next.delete(base)
  layouts.value = next
}

// The receiver replays $layout ahead of $location, and a feed card cannot
// exist until a location resolves, so the first frame never names every card
// the site default covers. Re-apply as each named card turns up rather than
// applying once and leaving the rest at their defaults.
export function autoApply(template) {
  if (!auto.on) return
  if (!template || typeof template !== 'object' || Array.isArray(template)) return
  auto.template = template
  runAutoApply()
  watchCards()
}

function namedSlotsPresent(template) {
  const named = Array.isArray(template.order)
    ? new Set(template.order.filter(s => typeof s === 'string')) : new Set()
  let n = 0
  for (const slot of cardSlots().values()) if (named.has(slot)) n++
  return n
}

function runAutoApply() {
  if (!auto.on || !auto.template) return
  const n = namedSlotsPresent(auto.template)
  if (n <= auto.matched) return
  auto.matched = n
  applyTemplate(auto.template)
}

export function postLayout() {
  const template = deriveTemplate()
  const url = `${location.origin}/$layout`
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(template),
  }).then(res => {
    if (!res.ok) { console.error(`POST ${url} failed: ${res.status}`); return }
    // Don't wait on the $layout frame echoing back over MQTT to know what we
    // just saved -- that round trip races a user hitting Load right after
    // the toast, handing them back whatever the echo hadn't yet overwritten.
    applyLayoutFrame(location.origin, template)
    showToast('Saved as default layout')
  }).catch(err => {
    console.error(`POST ${url} failed: ${err.message || err}`)
  })
}
