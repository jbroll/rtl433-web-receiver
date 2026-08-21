globalThis.DEVICE_MAX = 24

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { cardState, loadCardState, saveCardState, ensureCard } from '../src/store.js'
import { devices, upsert } from '../src/devices.js'
import * as src from '../src/sources.js'
import {
  layouts, deriveTemplate, applyTemplate, applyLayoutFrame,
} from '../src/layout_template.js'

const BASE = 'http://a'
const KEY = `${BASE} src/Acurite-5n1/396`
const FEED_KEY = 'local clock'

function fakeStorage() {
  const map = new Map()
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  }
  return map
}

function addDevice(key, model, merged) {
  upsert({
    key, obj: { model }, raw: '{}', rssi: -50, count: 1, seenAt: 1, at: 1,
    merged: merged || { temperature_C: 21 }, flashUntil: 0,
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
})

test('deriveTemplate groups cards by model, skipping feeds and modelless devices', () => {
  addDevice(KEY, 'Acurite-5n1')
  addDevice(FEED_KEY, undefined)
  ensureCard(KEY, { temperature_C: 21, humidity: 40 })
  ensureCard(FEED_KEY, { time: '12:00' })
  saveCardState()

  const t = deriveTemplate()
  assert.deepEqual(t.order, ['Acurite-5n1'])
  assert.ok(t.models['Acurite-5n1'])
  assert.equal(t.models['Acurite-5n1'].valueOrder.includes('temperature_C'), true)
  // ensureCard hides a newly created card by default (hideNewCards), so a
  // freshly-created card's model entry records hidden: true.
  assert.equal(t.models['Acurite-5n1'].hidden, true)
  assert.equal(Object.keys(t.models).includes(undefined), false)
})

test('deriveTemplate records a shown device as hidden: false', () => {
  addDevice(KEY, 'Acurite-5n1')
  ensureCard(KEY, { temperature_C: 21 })
  cardState.value = { ...cardState.value, hidden: cardState.value.hidden.filter(k => k !== KEY) }
  saveCardState()

  const t = deriveTemplate()
  assert.equal(t.models['Acurite-5n1'].hidden, false)
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
    order: ['Acurite-5n1'],
    models: {
      'Acurite-5n1': {
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
    order: ['Acurite-5n1', 'BMP280'],
    models: {
      'Acurite-5n1': { w: 1, h: 1, valueOrder: [], hiddenValues: [], bottomValues: [] },
      'BMP280': { w: 1, h: 1, valueOrder: [], hiddenValues: [], bottomValues: [] },
    },
  }
  applyTemplate(template)
  assert.deepEqual(cardState.value.order, [KEY, OTHER_KEY])
})

test('applyTemplate appends an unmatched device after every matched one, in its prior relative order', () => {
  const UNMATCHED_KEY = `${BASE} src/Other/9`
  addDevice(KEY, 'Acurite-5n1')
  addDevice(UNMATCHED_KEY, 'SomeOtherModel')
  cardState.value = { ...cardState.value, order: [UNMATCHED_KEY, KEY] }
  const template = {
    grid: { cols: 6, rows: 4 },
    order: ['Acurite-5n1'],
    models: { 'Acurite-5n1': { w: 1, h: 1, valueOrder: [], hiddenValues: [], bottomValues: [] } },
  }
  applyTemplate(template)
  assert.deepEqual(cardState.value.order, [KEY, UNMATCHED_KEY])
})

test('applyTemplate clamps grid dimensions and rejects malformed arrays', () => {
  addDevice(KEY, 'Acurite-5n1')
  const template = {
    grid: { cols: 999, rows: 'bad' },
    order: ['Acurite-5n1'],
    models: {
      'Acurite-5n1': { w: 1, h: 1, valueOrder: ['a', 5, null], hiddenValues: 'nope', bottomValues: [] },
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
    order: ['Acurite-5n1'],
    models: {
      'Acurite-5n1': {
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
    order: ['Acurite-5n1'],
    models: {
      'Acurite-5n1': {
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
    order: ['Acurite-5n1'],
    models: { 'Acurite-5n1': { w: 1, h: 1, valueOrder: [], hiddenValues: [], bottomValues: [] } },
  }
  applyTemplate(template)
  assert.equal(cardState.value.hidden.includes(UNMATCHED_KEY), true)
})

test('applyTemplate treats a missing hidden field as shown, for backward compatibility', () => {
  addDevice(KEY, 'Acurite-5n1')
  cardState.value = { ...cardState.value, hidden: [KEY] }
  const template = {
    grid: { cols: 6, rows: 4 },
    order: ['Acurite-5n1'],
    models: { 'Acurite-5n1': { w: 1, h: 1, valueOrder: [], hiddenValues: [], bottomValues: [] } },
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
