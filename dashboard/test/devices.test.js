globalThis.DEVICE_MAX = 24

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { devices, upsert, clearSource } from '../src/devices.js'
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
})

test('the device cap scales with the number of configured sources', () => {
  src.addSource('http://a.b')
  src.addSource('http://c.d')
  assert.equal(src.configured().length, 2)

  for (let i = 0; i < 30; i++) {
    upsert({ key: `http://a.b src/Acurite/${i}`, seenAt: i })
  }
  for (let i = 0; i < 30; i++) {
    upsert({ key: `http://c.d src/Acurite/${i}`, seenAt: i })
  }

  assert.ok(devices.value.size > DEVICE_MAX, `expected more than ${DEVICE_MAX} devices, got ${devices.value.size}`)
  assert.equal(devices.value.size, DEVICE_MAX * 2)
})

test('feed records are exempt from the cap, which is zero with no sources', () => {
  assert.equal(src.configured().length, 0)

  upsert({ key: 'local feed/Sun', seenAt: 0 })
  upsert({ key: 'local feed/Moon', seenAt: 0 })
  upsert({ key: 'http://a.b src/Acurite/1', seenAt: 5 })

  assert.ok(devices.value.has('local feed/Sun'))
  assert.ok(devices.value.has('local feed/Moon'))
  assert.ok(!devices.value.has('http://a.b src/Acurite/1'))
})

test('feed records survive a full cap of radio devices', () => {
  src.addSource('http://a.b')
  upsert({ key: 'local feed/Weather', seenAt: 0 })
  for (let i = 0; i < 30; i++) {
    upsert({ key: `http://a.b src/Acurite/${i}`, seenAt: i })
  }

  assert.equal(devices.value.size, DEVICE_MAX + 1)
  assert.ok(devices.value.has('local feed/Weather'))
})

test('clearing a source leaves feed records alone', () => {
  src.addSource('http://a.b')
  upsert({ key: 'local feed/Sun', seenAt: 0 })
  upsert({ key: 'http://a.b src/Acurite/1', seenAt: 5 })

  clearSource('http://a.b')

  assert.ok(devices.value.has('local feed/Sun'))
  assert.ok(!devices.value.has('http://a.b src/Acurite/1'))
})
