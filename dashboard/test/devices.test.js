globalThis.DEVICE_MAX = 24

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { devices, upsert } from '../src/devices.js'
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
  devices.clear()
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

  assert.ok(devices.size > DEVICE_MAX, `expected more than ${DEVICE_MAX} devices, got ${devices.size}`)
  assert.equal(devices.size, DEVICE_MAX * 2)
})
