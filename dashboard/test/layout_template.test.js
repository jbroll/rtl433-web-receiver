globalThis.DEVICE_MAX = 24

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { cardState, loadCardState, saveCardState, ensureCard, setGrid } from '../src/store.js'
import { devices, upsert } from '../src/devices.js'
import * as src from '../src/sources.js'
import {
  layouts, deriveTemplate, applyTemplate, applyLayoutFrame, postLayout,
  autoApply, disableAutoApply, resetAutoApply,
} from '../src/layout_template.js'

const BASE = 'http://a'
const KEY = `${BASE} src/Acurite-5n1/396`
const FEED_KEY = 'local feed/Clock'

function fakeStorage() {
  const map = new Map()
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  }
  return map
}

function addDevice(key, model, id) {
  upsert({
    key, obj: id === undefined ? { model } : { model, id }, raw: '{}', rssi: -50, count: 1, seenAt: 1, at: 1,
    merged: { temperature_C: 21 },
  })
}

beforeEach(() => {
  fakeStorage()
  globalThis.location = { origin: BASE }
  src.loadSources()
  src.addSource(BASE)
  devices.value = new Map()
  loadCardState()
  layouts.value = new Map()
  resetAutoApply()
})

test('deriveTemplate groups cards by model, skipping modelless devices', () => {
  const MODELLESS = `${BASE} src/nothing`
  addDevice(KEY, 'Acurite-5n1')
  addDevice(MODELLESS, undefined)
  ensureCard(KEY, { temperature_C: 21, humidity: 40 })
  ensureCard(MODELLESS, { time: '12:00' })
  saveCardState()

  const t = deriveTemplate()
  assert.deepEqual(t.order, ['Acurite-5n1/0'])
  assert.ok(t.models['Acurite-5n1/0'])
  assert.equal(t.models['Acurite-5n1/0'].valueOrder.includes('temperature_C'), true)
  // ensureCard hides a newly created card by default (hideNewCards), so a
  // freshly-created card's model entry records hidden: true.
  assert.equal(t.models['Acurite-5n1/0'].hidden, true)
  assert.equal(Object.keys(t.models).includes(undefined), false)
})

test('deriveTemplate leaves hidden off a shown device, which reads back as shown', () => {
  addDevice(KEY, 'Acurite-5n1')
  ensureCard(KEY, { temperature_C: 21 })
  cardState.value = { ...cardState.value, hidden: cardState.value.hidden.filter(k => k !== KEY) }
  saveCardState()

  const t = deriveTemplate()
  assert.equal('hidden' in t.models['Acurite-5n1/0'], false)

  cardState.value = { ...cardState.value, hidden: [KEY] }
  applyTemplate(t)
  assert.equal(cardState.value.hidden.includes(KEY), false)
})

test('deriveTemplate keeps grid dimensions', () => {
  cardState.value = { ...cardState.value, grid: { cols: 8, rows: 5 } }
  const t = deriveTemplate()
  assert.deepEqual(t.grid, { cols: 8, rows: 5 })
})

test('applyTemplate matches a currently-known device by model', () => {
  addDevice(KEY, 'Acurite-5n1')
  const template = {
    grid: { cols: 8, rows: 5 },
    order: ['Acurite-5n1/0'],
    models: {
      'Acurite-5n1/0': {
        w: 2, h: 2, valueOrder: ['humidity', 'temperature_C'], hiddenValues: [], bottomValues: [],
      },
    },
  }
  applyTemplate(template)
  assert.deepEqual(cardState.value.grid, { cols: 8, rows: 5 })
  const c = cardState.value.cards[KEY]
  assert.equal(c.w, 2)
  assert.equal(c.h, 2)
  assert.deepEqual(c.valueOrder, ['humidity', 'temperature_C'])
})

test('applyTemplate rebuilds order: matched devices in template order, then unmatched', () => {
  const OTHER_KEY = `${BASE} src/BMP280/1`
  addDevice(KEY, 'Acurite-5n1')
  addDevice(OTHER_KEY, 'BMP280')
  cardState.value = { ...cardState.value, order: [OTHER_KEY, KEY] }
  const template = {
    grid: { cols: 6, rows: 4 },
    order: ['Acurite-5n1/0', 'BMP280/0'],
    models: {
      'Acurite-5n1/0': { w: 1, h: 1, valueOrder: [], hiddenValues: [], bottomValues: [] },
      'BMP280/0': { w: 1, h: 1, valueOrder: [], hiddenValues: [], bottomValues: [] },
    },
  }
  applyTemplate(template)
  assert.deepEqual(cardState.value.order, [KEY, OTHER_KEY])
})

test('applyTemplate leaves an unmatched device in the position it already held', () => {
  const UNMATCHED_KEY = `${BASE} src/Other/9`
  addDevice(KEY, 'Acurite-5n1')
  addDevice(UNMATCHED_KEY, 'SomeOtherModel')
  cardState.value = { ...cardState.value, order: [UNMATCHED_KEY, KEY] }
  const template = {
    grid: { cols: 6, rows: 4 },
    order: ['Acurite-5n1/0'],
    models: { 'Acurite-5n1/0': { w: 1, h: 1, valueOrder: [], hiddenValues: [], bottomValues: [] } },
  }
  applyTemplate(template)
  assert.deepEqual(cardState.value.order, [UNMATCHED_KEY, KEY])
})

test('applyTemplate clamps grid dimensions and rejects malformed arrays', () => {
  addDevice(KEY, 'Acurite-5n1')
  const template = {
    grid: { cols: 999, rows: 'bad' },
    order: ['Acurite-5n1/0'],
    models: {
      'Acurite-5n1/0': { w: 1, h: 1, valueOrder: ['a', 5, null], hiddenValues: 'nope', bottomValues: [] },
    },
  }
  applyTemplate(template)
  assert.equal(cardState.value.grid.cols, 6)
  assert.equal(cardState.value.grid.rows, 4)
  assert.deepEqual(cardState.value.cards[KEY].valueOrder, ['a'])
  assert.deepEqual(cardState.value.cards[KEY].hiddenValues, [])
})

test('applyTemplate un-hides a matched device whose template entry says hidden: false', () => {
  addDevice(KEY, 'Acurite-5n1')
  cardState.value = { ...cardState.value, hidden: [KEY] }
  const template = {
    grid: { cols: 6, rows: 4 },
    order: ['Acurite-5n1/0'],
    models: {
      'Acurite-5n1/0': {
        w: 1, h: 1, valueOrder: [], hiddenValues: [], bottomValues: [], hidden: false,
      },
    },
  }
  applyTemplate(template)
  assert.equal(cardState.value.hidden.includes(KEY), false)
})

test('applyTemplate hides a matched device whose template entry says hidden: true', () => {
  addDevice(KEY, 'Acurite-5n1')
  const template = {
    grid: { cols: 6, rows: 4 },
    order: ['Acurite-5n1/0'],
    models: {
      'Acurite-5n1/0': {
        w: 1, h: 1, valueOrder: [], hiddenValues: [], bottomValues: [], hidden: true,
      },
    },
  }
  applyTemplate(template)
  assert.equal(cardState.value.hidden.includes(KEY), true)
})

test('applyTemplate leaves an unmatched device\'s hidden state untouched', () => {
  const UNMATCHED_KEY = `${BASE} src/Other/9`
  addDevice(KEY, 'Acurite-5n1')
  addDevice(UNMATCHED_KEY, 'SomeOtherModel')
  cardState.value = {
    ...cardState.value,
    order: [UNMATCHED_KEY, KEY],
    hidden: [UNMATCHED_KEY],
  }
  const template = {
    grid: { cols: 6, rows: 4 },
    order: ['Acurite-5n1/0'],
    models: { 'Acurite-5n1/0': { w: 1, h: 1, valueOrder: [], hiddenValues: [], bottomValues: [] } },
  }
  applyTemplate(template)
  assert.equal(cardState.value.hidden.includes(UNMATCHED_KEY), true)
})

test('applyTemplate treats a missing hidden field as shown, for backward compatibility', () => {
  addDevice(KEY, 'Acurite-5n1')
  cardState.value = { ...cardState.value, hidden: [KEY] }
  const template = {
    grid: { cols: 6, rows: 4 },
    order: ['Acurite-5n1/0'],
    models: { 'Acurite-5n1/0': { w: 1, h: 1, valueOrder: [], hiddenValues: [], bottomValues: [] } },
  }
  applyTemplate(template)
  assert.equal(cardState.value.hidden.includes(KEY), false)
})

test('applyTemplate on a malformed (non-object) template is a no-op', () => {
  const before = JSON.stringify(cardState.value)
  applyTemplate('not an object')
  applyTemplate(null)
  assert.equal(JSON.stringify(cardState.value), before)
})

test('applyLayoutFrame records a template keyed by base without touching cardState', () => {
  const before = JSON.stringify(cardState.value)
  applyLayoutFrame(BASE, { grid: { cols: 6, rows: 4 }, order: [], models: {} })
  assert.equal(layouts.value.has(BASE), true)
  assert.equal(JSON.stringify(cardState.value), before)
})

test('applyLayoutFrame with a non-object payload clears the entry', () => {
  applyLayoutFrame(BASE, { grid: { cols: 6, rows: 4 }, order: [], models: {} })
  applyLayoutFrame(BASE, null)
  assert.equal(layouts.value.has(BASE), false)
})

test('two devices sharing a model each keep their own slot, keyed on id', () => {
  const KEY2 = `${BASE} src/Acurite-5n1/500`
  addDevice(KEY, 'Acurite-5n1', 396)
  addDevice(KEY2, 'Acurite-5n1', 500)
  ensureCard(KEY, { temperature_C: 21 })
  ensureCard(KEY2, { temperature_C: 22 })
  cardState.value.cards[KEY].w = 3
  cardState.value.cards[KEY].h = 1
  cardState.value.cards[KEY2].w = 1
  cardState.value.cards[KEY2].h = 2
  saveCardState()

  const t = deriveTemplate()
  assert.deepEqual(t.order.sort(), ['Acurite-5n1/396', 'Acurite-5n1/500'])
  assert.equal(t.models['Acurite-5n1/396'].w, 3)
  assert.equal(t.models['Acurite-5n1/500'].w, 1)

  cardState.value.cards[KEY].w = 9
  cardState.value.cards[KEY2].w = 9
  applyTemplate(t)
  assert.equal(cardState.value.cards[KEY].w, 3)
  assert.equal(cardState.value.cards[KEY2].w, 1)
})

test('postLayout updates layouts synchronously on success, without waiting for the $layout echo', async () => {
  addDevice(KEY, 'Acurite-5n1')
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, status: 204 })
  try {
    postLayout()
    // postLayout's fetch and its .then() are both microtasks; letting one
    // microtask turn pass is enough without an echo ever arriving.
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(layouts.value.has(BASE), true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('applyTemplate leaves a feed card where it already sits', () => {
  addDevice(KEY, 'Acurite-5n1', 396)
  const KEY2 = `${BASE} src/Nexus-TH/2`
  addDevice(KEY2, 'Nexus-TH', 2)
  addDevice(FEED_KEY, undefined)
  ensureCard(FEED_KEY, { time: '12:00' }, { autoShow: true })
  ensureCard(KEY, { temperature_C: 21 })
  ensureCard(KEY2, { temperature_C: 22 })
  cardState.value = { ...cardState.value, order: [FEED_KEY, KEY, KEY2] }
  saveCardState()

  applyTemplate(deriveTemplate())
  assert.deepEqual(cardState.value.order, [FEED_KEY, KEY, KEY2])
})

test('applyTemplate leaves a card whose device has gone quiet where it sits', () => {
  const QUIET = `${BASE} src/LaCrosse-TX141THBv2/178`
  addDevice(KEY, 'Acurite-5n1', 396)
  ensureCard(KEY, { temperature_C: 21 })
  cardState.value.cards[QUIET] = { w: 2, h: 1, valueOrder: [], hiddenValues: [], bottomValues: [] }
  cardState.value = { ...cardState.value, order: [QUIET, KEY] }
  saveCardState()

  applyTemplate(deriveTemplate())
  assert.deepEqual(cardState.value.order, [QUIET, KEY])
})

test('applyTemplate reorders the cards the template does name', () => {
  const KEY2 = `${BASE} src/Nexus-TH/2`
  addDevice(KEY, 'Acurite-5n1', 396)
  addDevice(KEY2, 'Nexus-TH', 2)
  addDevice(FEED_KEY, undefined)
  ensureCard(FEED_KEY, { time: '12:00' }, { autoShow: true })
  ensureCard(KEY, { temperature_C: 21 })
  ensureCard(KEY2, { temperature_C: 22 })
  cardState.value = { ...cardState.value, order: [KEY, FEED_KEY, KEY2] }
  saveCardState()

  const t = deriveTemplate()
  t.order = ['Nexus-TH/2', 'Acurite-5n1/396']
  applyTemplate(t)
  assert.deepEqual(cardState.value.order, [KEY2, FEED_KEY, KEY])
})

test('deriveTemplate omits empty lists and a shown card, to spend fewer stored bytes', () => {
  addDevice(KEY, 'Acurite-5n1', 396)
  ensureCard(KEY, { temperature_C: 21 })
  cardState.value = { ...cardState.value, hidden: [] }
  saveCardState()

  const spec = deriveTemplate().models['Acurite-5n1/396']
  assert.equal('hiddenValues' in spec, false)
  assert.equal('bottomValues' in spec, false)
  assert.equal('hidden' in spec, false)
})

test('a feed card travels in the template, keyed on its own topic', () => {
  const WEATHER = 'local feed/Weather'
  addDevice(KEY, 'Acurite-5n1', 396)
  addDevice(WEATHER, undefined)
  ensureCard(KEY, { temperature_C: 21 })
  ensureCard(WEATHER, { temperature_F: 70 }, { autoShow: true })
  cardState.value = { ...cardState.value, order: [WEATHER, KEY] }
  cardState.value.cards[WEATHER].w = 4
  cardState.value.cards[WEATHER].h = 2
  saveCardState()

  const t = deriveTemplate()
  assert.deepEqual(t.order, ['feed/Weather', 'Acurite-5n1/396'])
  assert.equal(t.models['feed/Weather'].w, 4)
  assert.equal(t.models['feed/Weather'].h, 2)

  cardState.value.cards[WEATHER].w = 1
  applyTemplate(t)
  assert.equal(cardState.value.cards[WEATHER].w, 4)
  assert.deepEqual(cardState.value.order, [WEATHER, KEY])
})

test('a feed card the template names is hidden and shown like any other', () => {
  const WEATHER = 'local feed/Weather'
  addDevice(WEATHER, undefined)
  ensureCard(WEATHER, { temperature_F: 70 }, { autoShow: true })
  saveCardState()
  assert.equal('hidden' in deriveTemplate().models['feed/Weather'], false)

  cardState.value = { ...cardState.value, hidden: [WEATHER] }
  saveCardState()
  const t = deriveTemplate()
  assert.equal(t.models['feed/Weather'].hidden, true)

  cardState.value = { ...cardState.value, hidden: [] }
  applyTemplate(t)
  assert.equal(cardState.value.hidden.includes(WEATHER), true)
})

test('autoApply places a card the template names that turns up after the frame', () => {
  const WEATHER = 'local feed/Weather'
  const t = {
    grid: { cols: 6, rows: 4 },
    order: ['Acurite-5n1/396', 'feed/Weather'],
    models: {
      'Acurite-5n1/396': { w: 5, h: 1, valueOrder: ['temperature_C'] },
      'feed/Weather': { w: 4, h: 3, valueOrder: ['now'] },
    },
  }

  addDevice(KEY, 'Acurite-5n1', 396)
  ensureCard(KEY, { temperature_C: 21 })
  saveCardState()
  autoApply(t)
  assert.equal(cardState.value.cards[KEY].w, 5)

  addDevice(WEATHER, undefined)
  ensureCard(WEATHER, { now: 'clear' }, { autoShow: true })
  assert.equal(cardState.value.cards[WEATHER].w, 4)
  assert.equal(cardState.value.cards[WEATHER].h, 3)
})

test('autoApply stops re-applying once the visitor edits a card', () => {
  const WEATHER = 'local feed/Weather'
  const t = {
    grid: { cols: 6, rows: 4 },
    order: ['feed/Weather'],
    models: { 'feed/Weather': { w: 4, h: 3, valueOrder: ['now'] } },
  }

  autoApply(t)
  setGrid('cols', 8)

  addDevice(WEATHER, undefined)
  ensureCard(WEATHER, { now: 'clear' }, { autoShow: true })
  assert.notEqual(cardState.value.cards[WEATHER].w, 4)
  assert.equal(cardState.value.grid.cols, 8)
})

test('autoApply does nothing once auto-apply is off', () => {
  addDevice(KEY, 'Acurite-5n1', 396)
  ensureCard(KEY, { temperature_C: 21 })
  cardState.value.cards[KEY].w = 1
  saveCardState()

  disableAutoApply()
  autoApply({
    grid: { cols: 6, rows: 4 },
    order: ['Acurite-5n1/396'],
    models: { 'Acurite-5n1/396': { w: 5, h: 1, valueOrder: ['temperature_C'] } },
  })
  assert.equal(cardState.value.cards[KEY].w, 1)
})
