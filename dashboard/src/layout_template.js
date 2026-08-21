import { signal } from '@preact/signals'
import { cardState, gridNum, saveCardState, cardHidden } from './store.js'
import { devices } from './devices.js'
import { isFeed } from './alias.js'

export const LAYOUT_SUFFIX = '/$layout'
export const layouts = signal(new Map())

// One-way latch for the lifetime of the page load -- never re-enabled once disabled.
export let autoApplyEligible = true

export function disableAutoApply() {
  autoApplyEligible = false
}

function modelOf(key) {
  const rec = devices.value.get(key)
  const obj = rec && rec.obj.value
  return obj && typeof obj.model === 'string' && obj.model ? obj.model : null
}

export function deriveTemplate() {
  const s = cardState.value
  const models = Object.create(null)
  const order = []
  for (const key of s.order) {
    if (isFeed(key)) continue
    const model = modelOf(key)
    if (!model || models[model]) continue
    const c = s.cards[key]
    if (!c) continue
    models[model] = {
      w: c.w,
      h: c.h,
      valueOrder: c.valueOrder.slice(),
      hiddenValues: c.hiddenValues.slice(),
      bottomValues: (c.bottomValues || []).slice(),
      hidden: cardHidden(key),
    }
    order.push(model)
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

  const deviceModel = new Map()
  for (const rec of devices.value.values()) {
    if (isFeed(rec.key)) continue
    const model = modelOf(rec.key)
    if (model) deviceModel.set(rec.key, model)
  }

  const matched = []
  const seenKeys = new Set()
  const hiddenByKey = new Map()
  for (const model of modelOrder) {
    const spec = modelsIn[model]
    if (!spec || typeof spec !== 'object') continue
    for (const [key, m] of deviceModel) {
      if (m !== model || seenKeys.has(key)) continue
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
  }
  const unmatched = s.order.filter(k => !seenKeys.has(k))

  const nextHidden = s.hidden.filter(k => !hiddenByKey.has(k))
  for (const [key, hidden] of hiddenByKey) {
    if (hidden) nextHidden.push(key)
  }

  cardState.value = {
    grid: nextGrid,
    order: matched.concat(unmatched),
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

export function postLayout() {
  const template = deriveTemplate()
  const url = `${location.origin}/$layout`
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(template),
  }).then(res => {
    if (!res.ok) console.error(`POST ${url} failed: ${res.status}`)
  }).catch(err => {
    console.error(`POST ${url} failed: ${err.message || err}`)
  })
}
