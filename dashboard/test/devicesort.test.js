import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { signal } from '@preact/signals'

import { aliases } from '../src/alias.js'
import * as sort from '../src/devicesort.js'

const BASE = 'http://a'

function dev(model, extra = {}) {
  const key = `${BASE} src/${model}/${extra.id ?? 0}`
  return {
    key,
    obj: signal({ model, ...extra }),
    seenAt: signal(extra.seenAt ?? 0),
    rssi: signal(extra.rssi),
    count: signal(extra.count),
  }
}

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
  aliases.value = new Map()
  sort.loadSort()
})

const A = dev('Acurite-5n1', { id: 396, rssi: -72, count: 9, seenAt: 100 })
const O = dev('Oregon-THN132N', { id: 23, rssi: -40, count: 2, seenAt: 300 })
const F = dev('Fineoffset-WH2', { id: 174, rssi: -95, count: 40, seenAt: 200 })

const names = (l) => sort.sortDevices(l).map((r) => r.obj.value.model)

test('the default is alphabetical, not last seen', () => {
  assert.deepEqual(sort.current(), { by: 'name', dir: 1 })
  assert.deepEqual(names([A, O, F]), ['Acurite-5n1', 'Fineoffset-WH2', 'Oregon-THN132N'])
})

test('clicking the sorted column reverses it, another starts ascending', () => {
  sort.sortBy('name')
  assert.deepEqual(sort.current(), { by: 'name', dir: -1 })
  assert.deepEqual(names([A, O, F]), ['Oregon-THN132N', 'Fineoffset-WH2', 'Acurite-5n1'])

  sort.sortBy('rssi')
  assert.deepEqual(sort.current(), { by: 'rssi', dir: 1 })
  assert.deepEqual(names([A, O, F]), ['Fineoffset-WH2', 'Acurite-5n1', 'Oregon-THN132N'])
})

test('ascending age is freshest first', () => {
  sort.sortBy('age')
  assert.deepEqual(names([A, O, F]), ['Oregon-THN132N', 'Fineoffset-WH2', 'Acurite-5n1'])
  sort.sortBy('age')
  assert.deepEqual(names([A, O, F]), ['Acurite-5n1', 'Fineoffset-WH2', 'Oregon-THN132N'])
})

test('numeric columns compare as numbers, not as text', () => {
  sort.sortBy('count')
  assert.deepEqual(names([A, O, F]), ['Oregon-THN132N', 'Acurite-5n1', 'Fineoffset-WH2'])
})

test('a device missing the field sorts last whichever way the column points', () => {
  const none = dev('Nothing', { id: 1 })
  sort.sortBy('rssi')
  assert.equal(names([none, A, O]).at(-1), 'Nothing')
  sort.sortBy('rssi')
  assert.equal(names([none, A, O]).at(-1), 'Nothing')
})

test('the alias column sorts by the published name', () => {
  aliases.value.set(O.key, 'Back fence')
  aliases.value.set(A.key, 'Zenith')
  sort.sortBy('alias')
  assert.deepEqual(names([A, O, F]), ['Oregon-THN132N', 'Acurite-5n1', 'Fineoffset-WH2'])
})

test('names differing only in case sort by the collator, not code point', () => {
  const lower = dev('acurite-5n1', { id: 1 })
  const upper = dev('Acurite-5n1', { id: 2 })
  // Code-point order would put 'Acurite' before 'acurite' ('A' < 'a'); the
  // locale collator treats the pair as equal and falls through to the tie
  // break, which is stable insertion order for equal keys.
  assert.deepEqual(names([lower, upper]), ['acurite-5n1', 'Acurite-5n1'])
})

test('the collator is constructed once, not per comparison', async () => {
  const OrigCollator = Intl.Collator
  let constructions = 0
  class SpyCollator extends OrigCollator {
    constructor(...args) { super(...args); constructions++ }
  }
  globalThis.Intl.Collator = SpyCollator
  try {
    const mod = await import('../src/devicesort.js?spy=' + Date.now())
    mod.sortDevices([A, O, F])
    mod.sortDevices([A, O, F])
  } finally {
    globalThis.Intl.Collator = OrigCollator
  }
  assert.equal(constructions, 1)
})

test('the choice persists and a corrupt or unknown one falls back', () => {
  sort.sortBy('rssi')
  sort.loadSort()
  assert.deepEqual(sort.current(), { by: 'rssi', dir: 1 })

  localStorage.setItem(sort.SORT_KEY, '{"by":')
  sort.loadSort()
  assert.deepEqual(sort.current(), { by: 'name', dir: 1 })

  localStorage.setItem(sort.SORT_KEY, JSON.stringify({ by: 'reading', dir: -1 }))
  sort.loadSort()
  assert.deepEqual(sort.current(), { by: 'name', dir: 1 })
})

test('the id column counts numerically and puts channel-only devices after', () => {
  const big = dev('Big', { id: 396 })
  const small = dev('Small', { id: 5 })
  const chA = dev('ChanA', { channel: 2 })
  const chB = dev('ChanB', { channel: 10 })
  sort.sortBy('id')
  assert.deepEqual(sort.sortDevices([chB, big, chA, small]).map(r => r.obj.value.model),
                   ['Small', 'Big', 'ChanA', 'ChanB'])
})

test('an unsortable column is refused rather than stored', () => {
  assert.equal(sort.sortBy('reading'), false)
  assert.deepEqual(sort.current(), { by: 'name', dir: 1 })
})
