globalThis.DEVICE_MAX = 24

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { effect } from '@preact/signals'

import { devices, upsert, clearSource, setEvictHook } from '../src/devices.js'
import * as src from '../src/sources.js'

function fakeStorage() {
  const map = new Map()
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  }
}

beforeEach(() => {
  fakeStorage()
  globalThis.location = { origin: 'http://origin.test' }
  src.loadSources()
  devices.value = new Map()
  setEvictHook(() => {})
})

test('the device cap scales with the number of configured sources', () => {
  src.addSource('http://bridge.local')
  src.addSource('http://nas.local')
  assert.equal(src.configured().length, 2)

  for (let i = 0; i < 30; i++) {
    upsert({ key: `http://bridge.local src/Acurite/${i}`, seenAt: i })
  }
  for (let i = 0; i < 30; i++) {
    upsert({ key: `http://nas.local src/Acurite/${i}`, seenAt: i })
  }

  assert.ok(devices.value.size > DEVICE_MAX, `expected more than ${DEVICE_MAX} devices, got ${devices.value.size}`)
  assert.equal(devices.value.size, DEVICE_MAX * 2)
})

test('feed records are exempt from the cap, which is zero with no sources', () => {
  assert.equal(src.configured().length, 0)

  upsert({ key: 'local feed/Sun', seenAt: 0 })
  upsert({ key: 'local feed/Moon', seenAt: 0 })
  upsert({ key: 'http://bridge.local src/Acurite/1', seenAt: 5 })

  assert.ok(devices.value.has('local feed/Sun'))
  assert.ok(devices.value.has('local feed/Moon'))
  assert.ok(!devices.value.has('http://bridge.local src/Acurite/1'))
})

test('feed records survive a full cap of radio devices', () => {
  src.addSource('http://bridge.local')
  upsert({ key: 'local feed/Weather', seenAt: 0 })
  for (let i = 0; i < 30; i++) {
    upsert({ key: `http://bridge.local src/Acurite/${i}`, seenAt: i })
  }

  assert.equal(devices.value.size, DEVICE_MAX + 1)
  assert.ok(devices.value.has('local feed/Weather'))
})

test('an evicted device is reported through the evict hook', () => {
  src.addSource('http://bridge.local')
  const evicted = []
  setEvictHook(key => evicted.push(key))

  for (let i = 0; i < DEVICE_MAX + 1; i++) {
    upsert({ key: `http://bridge.local src/Acurite/${i}`, seenAt: i })
  }

  assert.deepEqual(evicted, ['http://bridge.local src/Acurite/0'])
})

test('eviction notifies subscribers as its own change, not folded into the triggering upsert', () => {
  src.addSource('http://bridge.local')
  const snapshots = []
  const stop = effect(() => { snapshots.push(devices.value) })
  snapshots.length = 0 // drop the effect's initial subscribe firing

  for (let i = 0; i < DEVICE_MAX + 1; i++) {
    upsert({ key: `http://bridge.local src/Acurite/${i}`, seenAt: i })
  }
  stop()

  // DEVICE_MAX + 1 new-key upserts, each notifying once, plus one more when
  // trim evicts the oldest -- a self-assignment that never notifies would
  // leave this at DEVICE_MAX + 1 even though the final map looks correct.
  assert.equal(snapshots.length, DEVICE_MAX + 2)
  const last = snapshots[snapshots.length - 1]
  assert.ok(!last.has('http://bridge.local src/Acurite/0'))
  assert.equal(last.size, DEVICE_MAX)
})

test('clearing a source leaves feed records alone', () => {
  src.addSource('http://bridge.local')
  upsert({ key: 'local feed/Sun', seenAt: 0 })
  upsert({ key: 'http://bridge.local src/Acurite/1', seenAt: 5 })

  clearSource('http://bridge.local')

  assert.ok(devices.value.has('local feed/Sun'))
  assert.ok(!devices.value.has('http://bridge.local src/Acurite/1'))
})
