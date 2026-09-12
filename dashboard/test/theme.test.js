import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { darkNow, CIVIL } from '../src/theme.js'
import { loadSettings, setTheme, setLocation } from '../src/settings.js'
import { sources } from '../src/sources.js'
import { tick } from '../src/tick.js'
import { sunEvents } from '../src/astro.js'

function fakeStorage() {
  const map = new Map()
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  }
  return map
}

globalThis.location = { origin: 'http://receiver.test' }
globalThis.fetch = async () => ({})

// New York, so a UTC hour maps to a predictable local one year round.
const NYC = { lat: 40.7128, lon: -74.0060, label: 'New York', zone: 'America/New_York' }

beforeEach(() => {
  fakeStorage()
  loadSettings()
  sources.value = []
})

test('the civil twilight boundary is six degrees below the horizon', () => {
  assert.equal(CIVIL, -6)
})

test('a fixed theme answers without a location', () => {
  setTheme('light')
  assert.equal(darkNow.value, false)
  setTheme('dark')
  assert.equal(darkNow.value, true)
})

test('the system theme never overrides', () => {
  setTheme('system')
  assert.equal(darkNow.value, null)
  setLocation(NYC)
  assert.equal(darkNow.value, null)
})

test('auto without a location does not override', () => {
  setTheme('auto')
  assert.equal(darkNow.value, null)
})

test('auto follows the sun at the location', (t) => {
  setTheme('auto')
  setLocation(NYC)
  // 17:00 UTC is midday in New York; 05:00 UTC is the middle of the night.
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 8, 12, 17, 0) })
  assert.equal(darkNow.value, false)
  t.mock.timers.setTime(Date.UTC(2026, 8, 12, 5, 0))
  // darkNow is a computed: nothing it reads has changed, so it would return
  // the cached answer. In the app the one-second tick is what invalidates it.
  tick.value++
  assert.equal(darkNow.value, true)
})

test('auto stays light between sunset and civil dusk', (t) => {
  setTheme('auto')
  setLocation(NYC)
  const { sunset, civilDusk } = sunEvents(new Date(Date.UTC(2026, 8, 12)), NYC.lat, NYC.lon, NYC.zone)
  const midDusk = (sunset.getTime() + civilDusk.getTime()) / 2

  t.mock.timers.enable({ apis: ['Date'], now: midDusk })
  assert.equal(darkNow.value, false)
  t.mock.timers.setTime(civilDusk.getTime() + 2 * 60000)
  tick.value++
  assert.equal(darkNow.value, true)
})
