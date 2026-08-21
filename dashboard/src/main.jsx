import { render } from 'preact'
import { effect } from '@preact/signals'
import { App, tab } from './app.jsx'
import { tick } from './tick.js'
import { devices, upsert, clearSource } from './devices.js'
import { makeKey, applyAliasFrame, isSelf, aliases, loadAliases } from './alias.js'
import { applyLayoutFrame, applyTemplate, layouts } from './layout_template.js'
import { mergeReadings, fmtValue } from './units.js'
import * as store from './store.js'
import { sources, sourceState, loadSources, setSourcesChanged, storageState, addSource,
         setSourceState } from './sources.js'
import { loadSettings, settings, setLocation, clearLocation } from './settings.js'
import { measureGrid, installGestures, cellSignal, fitValues, dragging, resizing, gestureInFlight } from './grid.js'
import { addLog } from './log.jsx'
import { openSource } from './stream.js'
import { loadSort } from './devicesort.js'
import './renderers.jsx'
import { registerFeed, primeFeeds, pump, expireFeeds } from './feeds/feed.js'
import clock from './feeds/clock.js'
import sun from './feeds/sun.js'
import moon from './feeds/moon.js'
import weather from './feeds/nws.js'

let build = null

function onMessage(base, topic, obj) {
  if (!obj || typeof obj !== 'object') return
  const key = makeKey(base, topic)
  const stamped = obj.time ? Date.parse(obj.time) : NaN
  const at = Number.isFinite(stamped) ? stamped : Date.now()
  if (isSelf(key) && typeof obj.build === 'string' && base === location.origin) {
    if (build === null) build = obj.build
    else if (obj.build !== build) { location.reload(); return }
  }
  const prev = devices.value.get(key)
  const raw = JSON.stringify(obj)
  const merged = mergeReadings(prev && prev.merged.value, obj)
  upsert({
    key, obj, raw, rssi: obj.rssi, count: obj.count, seenAt: at, at,
    merged,
    flashUntil: Date.now() + 1000,
  })
  store.ensureCard(key, merged)
  if (!isSelf(key)) addLog(at, raw)
}

function onAlias(base, topic, payload) {
  applyAliasFrame(makeKey(base, topic), payload)
}

let autoAppliedLayout = false

function onLayout(base, topic, payload) {
  applyLayoutFrame(base, payload)
  if (autoAppliedLayout) return
  if (base !== location.origin) return
  if (store.cardState.value.order.length !== 0) return
  autoAppliedLayout = true
  applyTemplate(payload)
}

function onState(base, state) {
  setSourceState(base, state)
}

const open = new Map()
let probe = null

function dropSource(base, stream) {
  stream.close()
  open.delete(base)
  const nextState = new Map(sourceState.value)
  nextState.delete(base)
  sourceState.value = nextState
  clearSource(base)
  const nextAliases = new Map(aliases.value)
  for (const key of nextAliases.keys()) if (key.startsWith(`${base} `)) nextAliases.delete(key)
  aliases.value = nextAliases
  const nextLayouts = new Map(layouts.value)
  nextLayouts.delete(base)
  layouts.value = nextLayouts
}

function probeOrigin() {
  const base = location.origin
  const stream = openSource(base, { onMessage, onAlias, onLayout, onState: onProbeState })
  open.set(base, stream)
  probe = { base, stream, timer: setTimeout(abortProbe, 1500) }
}

function onProbeState(base, state) {
  onState(base, state)
  if (!probe || base !== probe.base) return
  if (state === 'live') adoptProbe()
  else if (state === 'reconnecting') abortProbe()
}

function adoptProbe() {
  const base = probe.base
  clearTimeout(probe.timer)
  probe = null
  addSource(base)
  tab.value = 'cards'
}

function abortProbe() {
  const { base, stream } = probe
  clearTimeout(probe.timer)
  probe = null
  dropSource(base, stream)
  tab.value = 'sources'
}

function syncSources() {
  const want = sources.value
  for (const base of want) {
    if (open.has(base)) continue
    open.set(base, openSource(base, { onMessage, onAlias, onLayout, onState }))
  }
  for (const [base, stream] of open) {
    if (want.indexOf(base) >= 0) continue
    if (probe && base === probe.base) continue
    dropSource(base, stream)
  }
  const next = new Map(sourceState.value)
  for (const base of next.keys()) {
    if (want.indexOf(base) >= 0) continue
    if (probe && base === probe.base) continue
    next.delete(base)
  }
  sourceState.value = next
}

setSourcesChanged(syncSources)

function wrapRec(rec) {
  return {
    get key() { return rec.key },
    get rssi() { return rec.rssi.value },
    get count() { return rec.count.value },
    get seenAt() { return rec.seenAt.value },
    get flashUntil() { return rec.flashUntil.value },
    get obj() { return rec.obj.value },
    get raw() { return rec.raw.value },
    get merged() { return rec.merged.value },
  }
}

function exposeForTests() {
  const deviceProxy = {
    get size() { return devices.value.size },
    get(key) { const rec = devices.value.get(key); return rec ? wrapRec(rec) : undefined },
    clear() { devices.value = new Map() },
    has(key) { return devices.value.has(key) },
    values() { return [...devices.value.values()].map(wrapRec) },
    keys() { return devices.value.keys() },
    entries() { return [...devices.value.entries()].map(([k, r]) => [k, wrapRec(r)]) },
    forEach(fn) { devices.value.forEach((r, k) => fn(wrapRec(r), k, deviceProxy)) },
    [Symbol.iterator]() { return this.entries()[Symbol.iterator]() },
  }

  Object.assign(window, {
    devices: deviceProxy,
    upsert,
    measureGrid, fmtValue, fitValues,
    ensureCard: store.ensureCard, visibleValues: store.visibleValues,
    saveCardState: store.saveCardState, defaultSize: store.defaultSize,
    setGrid: store.setGrid, setCardSize: store.setCardSize, setHideNewCards: store.setHideNewCards,
    setLocation, clearLocation, expireFeeds, setValueMode: store.setValueMode,
  })
  Object.defineProperties(window, {
    cardState: { get: store.getCardState, set: store.setCardState },
    cellSide: { get: () => cellSignal.value },
    dragging: { get: () => dragging.value },
    resizing: { get: () => resizing.value },
    gestureInFlight: { get: () => gestureInFlight() },
    hideNewCards: { set: store.setHideNewCards },
  })
}

render(<App />, document.body)

exposeForTests()
store.loadCardState()
loadAliases()
loadSort()
loadSources()
loadSettings()
installGestures()

for (const feed of [weather, sun, moon, clock]) registerFeed(feed)
primeFeeds()
// tick is the app's only timer, so the feed scheduler rides it rather than
// starting one of its own. Reading settings restarts the feeds on a move.
effect(() => { tick.value; settings.value; pump() })

const stored = storageState()
if (stored === 'absent') probeOrigin()
else tab.value = stored === 'empty' ? 'sources' : 'cards'

syncSources()