import { setRender } from './render.js'
import { devices, upsert } from './devices.js'
import { makeKey, applyAliasFrame, isSelf } from './alias.js'
import { mergeReadings, fmtValue } from './units.js'
import * as store from './store.js'
import { measureGrid, installGestures, setEditing, editing, gestureInFlight, fitValues,
         cellSide, fontPx, currentDrag, resetFit } from './grid.js'
import { buildCard } from './card.js'
import { renderDevices, addLog, renderLog } from './table.js'
import { openSource } from './stream.js'

const $ = (id) => document.getElementById(id)

let build = null

function renderCards() {
  const grid = $('cards')
  if (!grid) return
  // A rebuild takes the rename input out from under whoever is typing in it, and
  // its own blur then commits half a name. A flag rather than a focus test: the
  // ✕ and resize buttons hold focus after a click and would freeze the grid.
  if (gestureInFlight()) return
  for (const rec of devices.values()) store.ensureCard(rec.key, rec.merged)
  // Seeding is what gives the device table its modes, so it runs every tick;
  // building cards for a section nobody is looking at does not.
  if ($('view-cards').hidden) return
  measureGrid()
  const keys = store.orderedKeys()
  const shown = keys.filter((k) => !store.cardHidden(k))
  if (editing()) shown.push(...keys.filter(store.cardHidden))
  resetFit()
  grid.replaceChildren(...shown.map((k) => buildCard(devices.get(k))))
  fitValues()
}

function render() {
  renderCards()
  renderDevices()
}

setRender(render)

function onMessage(base, topic, obj) {
  if (!obj || typeof obj !== 'object') return
  const key = makeKey(base, topic)
  // A message stamped before the source's clock was set has no time, so it ages
  // from its arrival instead.
  const stamped = obj.time ? Date.parse(obj.time) : NaN
  const at = Number.isFinite(stamped) ? stamped : Date.now()
  // A reflashed receiver reboots, the stream reconnects, and its telemetry names
  // the new build: the page it served is the old firmware's, so reload it.
  if (isSelf(key) && typeof obj.build === 'string' && base === location.origin) {
    if (build === null) build = obj.build
    else if (obj.build !== build) { location.reload(); return }
  }
  const prev = devices.get(key)
  const raw = JSON.stringify(obj)
  upsert({
    key, obj, raw, rssi: obj.rssi, count: obj.count, seenAt: at, at,
    merged: mergeReadings(prev && prev.merged, obj),
    flashUntil: Date.now() + 1000,
  })
  // Cards first: seeding a card is what gives the device table the display modes
  // it lists, so the other order shows a new device's values as shown.
  render()
  if (!isSelf(key)) addLog(at, raw)
}

function onAlias(base, topic, payload) { applyAliasFrame(makeKey(base, topic), payload) }

function onState(base, state) {
  $('status').textContent = state === 'live' ? 'live' : state
}

const TABS = ['devices', 'log', 'cards']
for (const n of TABS) $('tab-' + n).onclick = () => showTab(n)

function showTab(name) {
  for (const n of TABS) {
    $('tab-' + n).setAttribute('aria-selected', String(n === name))
    $('view-' + n).hidden = n !== name
  }
  // The section it reveals has not been drawn since it was last hidden.
  render()
  renderLog()
}

function syncGridInputs() {
  $('grid-cols').value = String(store.grid().cols)
  $('grid-rows').value = String(store.grid().rows)
}

function applyGridInput(input, axis) {
  store.setGrid(axis, parseInt(input.value, 10))
  input.value = String(store.grid()[axis])
  render()
}

$('grid-cols').onchange = (ev) => applyGridInput(ev.target, 'cols')
$('grid-rows').onchange = (ev) => applyGridInput(ev.target, 'rows')

$('edit-cards').onclick = () => {
  setEditing(!editing())
  $('view-cards').classList.toggle('editing', editing())
  render()
}

$('forget-cards').onclick = () => {
  if (confirm('Forget every saved card layout in this browser?')) {
    store.forgetLayouts()
    syncGridInputs()
  }
}

// The browser suite drives the page through the names it had before the bundle
// closed over them.
function exposeForTests() {
  Object.assign(window, {
    devices, renderCards, measureGrid, fmtValue, valueFont: fontPx,
    ensureCard: store.ensureCard, visibleValues: store.visibleValues,
    saveCardState: store.saveCardState, defaultSize: store.defaultSize,
  })
  Object.defineProperties(window, {
    cardState: { get: store.getCardState, set: store.setCardState },
    cellSide: { get: cellSide },
    dragging: { get: currentDrag },
    hideNewCards: { set: store.setHideNewCards },
  })
}

exposeForTests()
store.loadCardState()
syncGridInputs()
installGestures()
window.addEventListener('resize', render)
setInterval(render, 1000)
openSource(location.origin, { onMessage, onAlias, onState })
render()
