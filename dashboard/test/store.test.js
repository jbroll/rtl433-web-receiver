globalThis.DEVICE_MAX = 24

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { effect } from '@preact/signals'

import { devices } from '../src/devices.js'
import * as store from '../src/store.js'

const BASE = 'http://a'
const K = `${BASE} src/Acurite-5n1/396`
const READ = { temperature_F: 71.2, humidity: 38, battery_ok: 1 }

function fakeStorage() {
  const map = new Map()
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  }
  return map
}

beforeEach(() => {
  fakeStorage()
  devices.value = new Map()
  store.setHideNewCards(true)
  store.loadCardState()
})

test('a new card appends, hides, and puts status fields at the bottom', () => {
  store.ensureCard(K, READ)
  devices.value.set(K, { key: K, merged: READ })
  assert.equal(store.cardHidden(K), true)
  assert.deepEqual(store.visibleValues(K, READ), ['temperature_F', 'humidity'])
  assert.deepEqual(store.bottomFields(K, READ), ['battery_ok'])
})

test('a field seen later appends without disturbing stored order', () => {
  store.ensureCard(K, READ)
  store.ensureCard(K, { ...READ, wind_avg_mi_h: 4.6 })
  assert.deepEqual(store.cardFields(K, { ...READ, wind_avg_mi_h: 4.6 }),
                   ['temperature_F', 'humidity', 'battery_ok', 'wind_avg_mi_h'])
})

test('a card with no stored size is sized from its value count', () => {
  store.ensureCard(K, READ)
  assert.deepEqual(store.cardEntry(K), { ...store.cardEntry(K), w: 2, h: 1 })
})

test('corrupt storage is discarded and defaults rebuild', () => {
  localStorage.setItem('rtl433.dashboard.v1', '{"grid":')
  store.loadCardState()
  assert.deepEqual(store.grid(), { cols: 6, rows: 4 })
})

test('a __proto__ key in stored cards cannot taint an untouched device', () => {
  localStorage.setItem('rtl433.dashboard.v1', JSON.stringify({
    cards: { __proto__: { hiddenValues: ['temperature_F'] } },
  }))
  store.loadCardState()
  store.ensureCard(K, READ)
  assert.equal(store.valueMode(K, 'temperature_F'), 'shown')
})

test('a device nobody showed is dropped from storage once it is gone', () => {
  store.ensureCard(K, READ)
  store.setCardHidden(K, false)
  const junk = `${BASE} src/Noise/1`
  store.ensureCard(junk, { humidity: 154 })
  const live = `${BASE} src/Nexus-TH/2`
  devices.value.set(live, { key: live, merged: READ })
  store.saveCardState()
  assert.deepEqual(JSON.parse(localStorage.getItem('rtl433.dashboard.v1')).order, [K])
})

test('forgetting layouts clears storage and reseeds the devices on screen', () => {
  store.ensureCard(K, READ)
  store.setCardHidden(K, false)
  store.saveCardState()
  devices.value.set(K, { key: K, merged: READ })
  store.forgetLayouts()
  assert.equal(store.cardHidden(K), false)
  assert.deepEqual(store.grid(), { cols: 6, rows: 4 })
})

test('a grid axis outside 1-24 is refused and the stored value kept', () => {
  store.setGrid('cols', 8)
  store.setGrid('cols', 99)
  assert.equal(store.grid().cols, 8)
})

const FEED = 'local feed/Sun'
const SUN = { sunrise: '05:42', sunset: '20:11' }

test('autoShow leaves a new card visible even when new cards hide', () => {
  store.ensureCard(FEED, SUN, { autoShow: true })
  assert.equal(store.cardHidden(FEED), false)
})

test('autoShow does not undo a later user hide', () => {
  store.ensureCard(FEED, SUN, { autoShow: true })
  store.setCardHidden(FEED, true)
  store.ensureCard(FEED, SUN, { autoShow: true })
  assert.equal(store.cardHidden(FEED), true)
})

test('a hidden feed keeps its layout across a save', () => {
  store.ensureCard(FEED, SUN, { autoShow: true })
  store.setCardSize(FEED, 3, 2)
  store.setCardHidden(FEED, true)
  store.saveCardState()

  assert.ok(store.cardEntry(FEED), 'feed layout was pruned away')
  assert.equal(store.cardEntry(FEED).w, 3)
  assert.equal(store.cardEntry(FEED).h, 2)
})

test('a hidden radio device with no record is pruned once its source has spoken', () => {
  const OTHER = `${BASE} src/Nexus-TH/2`
  store.ensureCard(K, READ)
  store.setCardHidden(K, true)
  devices.value.set(OTHER, { key: OTHER, merged: READ })
  store.saveCardState()

  assert.equal(store.cardEntry(K), undefined)
})

test('a hidden radio device survives a save made before its source has spoken', () => {
  store.ensureCard(K, READ)
  store.setCardSize(K, 4, 3)
  store.setCardHidden(K, true)
  devices.value = new Map()
  store.saveCardState()

  assert.ok(store.cardEntry(K), 'card was pruned before its source replayed')
  assert.equal(store.cardEntry(K).w, 4)
  assert.equal(store.cardHidden(K), true)
})

test('a hidden radio device survives a save while another source is live', () => {
  const OTHER = 'http://b src/Nexus-TH/2'
  store.ensureCard(K, READ)
  store.setCardHidden(K, true)
  devices.value.set(OTHER, { key: OTHER, merged: READ })
  store.saveCardState()

  assert.ok(store.cardEntry(K), 'another source spoke for this one')
})

test('a feed can start some values hidden, without dropping them', () => {
  store.ensureCard(FEED, { ...SUN, extra: 1 }, { autoShow: true, hiddenValues: ['sunset', 'nothing'] })
  const c = store.cardEntry(FEED)

  assert.deepEqual(c.hiddenValues, ['sunset'], 'a name that is not a field must not be stored')
  assert.deepEqual(store.visibleValues(FEED, { ...SUN, extra: 1 }), ['sunrise', 'extra'])
  assert.ok(c.valueOrder.includes('sunset'), 'a hidden value must stay reachable')
})

test('a value hidden by default can be shown, and stays shown', () => {
  store.ensureCard(FEED, SUN, { autoShow: true, hiddenValues: ['sunset'] })
  store.setValueMode(FEED, 'sunset', 'shown')
  store.ensureCard(FEED, SUN, { autoShow: true, hiddenValues: ['sunset'] })

  assert.deepEqual(store.cardEntry(FEED).hiddenValues, [])
})

test('ensureCard for a new key persists and notifies subscribers exactly once', () => {
  let fired = 0
  const stop = effect(() => { store.cardState.value; fired++ })
  fired = 0
  store.ensureCard(K, READ)
  stop()
  assert.equal(fired, 1)
  assert.ok(JSON.parse(localStorage.getItem('rtl433.dashboard.v1')).cards[K])
})

test('saveCardState notifies subscribers exactly once, even when pruning changes something', () => {
  store.ensureCard(K, READ)
  store.setCardHidden(K, true)
  const junk = `${BASE} src/Noise/1`
  store.ensureCard(junk, { humidity: 154 })
  let fired = 0
  const stop = effect(() => { store.cardState.value; fired++ })
  fired = 0
  const live = `${BASE} src/Nexus-TH/2`
  devices.value.set(live, { key: live, merged: READ })
  store.saveCardState()
  stop()
  assert.equal(fired, 1)
})

test('a second ensureCard for an existing key does not save or notify', () => {
  store.ensureCard(K, READ)
  localStorage.removeItem('rtl433.dashboard.v1')
  let fired = 0
  const stop = effect(() => { store.cardState.value; fired++ })
  fired = 0
  store.ensureCard(K, READ)
  stop()
  assert.equal(fired, 0)
  assert.equal(localStorage.getItem('rtl433.dashboard.v1'), null)
})

test('pruning does not mutate an earlier snapshot\'s order', () => {
  store.ensureCard(K, READ)
  store.setCardHidden(K, true)
  const snapshot = store.cardState.value
  const snapshotOrder = snapshot.order
  const other = `${BASE} src/Other/9`
  devices.value.set(other, { key: other, merged: READ })
  store.saveCardState()
  assert.deepEqual(snapshotOrder, [K])
})

// forgetLayouts() rebuilds order/hidden with a series of in-place pushes on its
// own blankState() array, ahead of the one save at the end (see forgetLayouts).
// A subscriber that captures that array from the reset, ahead of the reseed,
// must not see it grow again once a later, unrelated call pushes onto whatever
// array is live by then -- which is only true if bump() copies rather than
// carries the array forward by reference.
test('a snapshot taken during forgetLayouts\'s reset is not mutated by a later ensureCard call', () => {
  const other = `${BASE} src/Other/9`
  let fire = 0
  let snapshotOrder
  const stop = effect(() => {
    const order = store.cardState.value.order
    if (fire === 1) snapshotOrder = order
    fire++
  })
  devices.value.set(K, { key: K, merged: READ })
  store.forgetLayouts()
  stop()
  devices.value.set(other, { key: other, merged: READ })
  store.ensureCard(other, READ, { autoShow: true })
  assert.deepEqual(snapshotOrder, [K])
  assert.deepEqual(store.cardState.value.order, [K, other])
})

test('a snapshot taken during forgetLayouts\'s reset is not mutated by a later hide', () => {
  let fire = 0
  let snapshotHidden
  const stop = effect(() => {
    const hidden = store.cardState.value.hidden
    if (fire === 1) snapshotHidden = hidden
    fire++
  })
  devices.value.set(K, { key: K, merged: READ })
  store.forgetLayouts()
  stop()
  store.setCardHidden(K, true)
  assert.deepEqual(snapshotHidden, [])
  assert.deepEqual(store.cardState.value.hidden, [K])
})

test('a stored width or height outside 1-24 is clamped rather than discarded', () => {
  localStorage.setItem('rtl433.dashboard.v1', JSON.stringify({
    order: [K], hidden: [], cards: { [K]: { w: 99, h: 99, valueOrder: [], hiddenValues: [] } },
  }))
  store.loadCardState()
  assert.equal(store.cardEntry(K).w, 24)
  assert.equal(store.cardEntry(K).h, 24)
})

test('an order entry naming a key absent from cards is dropped on load', () => {
  localStorage.setItem('rtl433.dashboard.v1', JSON.stringify({
    order: [K, 'ghost'], hidden: ['ghost'], cards: { [K]: { w: 2, h: 2, valueOrder: [], hiddenValues: [] } },
  }))
  store.loadCardState()
  assert.deepEqual(store.getCardState().order, [K])
  assert.deepEqual(store.getCardState().hidden, [])
})

// I6: once storage is broken, saveCardState's early return used to skip
// bump() along with the write, and every setter here mutates cardState.value
// in place -- so with nothing left to give the mutation a new identity, a
// subscriber never heard about it even though the toggle actually happened.
test('a setter still notifies subscribers once storage is broken', () => {
  store.ensureCard(K, READ)
  store.setCardHidden(K, false) // hideNewCards' default start-hidden, undone before storage breaks
  localStorage.setItem = () => { throw new Error('quota') }
  store.setCardHidden(K, true)
  assert.equal(store.isStorageBroken(), true)

  let fired = 0
  const stop = effect(() => { store.cardState.value; fired++ })
  fired = 0
  store.setCardHidden(K, false)
  stop()

  assert.equal(fired, 1)
  assert.equal(store.cardHidden(K), false)
})
