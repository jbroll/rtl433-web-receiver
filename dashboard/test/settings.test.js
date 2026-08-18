import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { settings, SETTINGS_KEY, loadSettings, saveSettings, setUnits, setDecimals, setCustomField,
         setLocation, clearLocation, hasLocation, activeZone, localZone } from '../src/settings.js'

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
  loadSettings()
})

const NO_PLACE = { lat: null, lon: null, label: '', zone: '', zoom: 11 }

test('first-load defaults are metric with one decimal', () => {
  assert.deepEqual(settings.value,
    { units: 'metric', decimals: 1, custom: { temp: 'C', rain: 'mm', wind: 'km/h', pressure: 'hPa' },
      location: NO_PLACE })
})

test('setUnits presets set all four groups at once', () => {
  setUnits('imperial')
  assert.deepEqual(settings.value.custom, { temp: 'F', rain: 'in', wind: 'mi/h', pressure: 'hPa' })
  setUnits('metric')
  assert.deepEqual(settings.value.custom, { temp: 'C', rain: 'mm', wind: 'km/h', pressure: 'hPa' })
})

test('custom units keep the four fields while presets overwrite them', () => {
  setUnits('custom')
  setCustomField('temp', 'F')
  assert.equal(settings.value.units, 'custom')
  assert.equal(settings.value.custom.temp, 'F')
  setUnits('metric')
  assert.equal(settings.value.custom.temp, 'C')
})

test('setDecimals accepts 0-5 and rejects everything else', () => {
  for (let d = 0; d <= 5; d++) {
    setDecimals(d)
    assert.equal(settings.value.decimals, d)
  }
  setDecimals(6)
  assert.equal(settings.value.decimals, 5)
  setDecimals(-1)
  assert.equal(settings.value.decimals, 5)
  setDecimals(1.5)
  assert.equal(settings.value.decimals, 5)
})

test('setCustomField accepts the four groups only', () => {
  setCustomField('temp', 'F')
  assert.equal(settings.value.custom.temp, 'F')
  setCustomField('rain', 'in')
  assert.equal(settings.value.custom.rain, 'in')
  setCustomField('wind', 'm/s')
  assert.equal(settings.value.custom.wind, 'm/s')
  setCustomField('pressure', 'kPa')
  assert.equal(settings.value.custom.pressure, 'kPa')
  setCustomField('temp', 'K')
  assert.equal(settings.value.custom.temp, 'F')
  setCustomField('unknown', 'x')
  assert.deepEqual(settings.value.custom, { temp: 'F', rain: 'in', wind: 'm/s', pressure: 'kPa' })
})

test('changes persist to localStorage and reload', () => {
  setDecimals(3)
  setUnits('custom')
  setCustomField('wind', 'm/s')
  loadSettings()
  assert.deepEqual(settings.value,
    { units: 'custom', decimals: 3, custom: { temp: 'C', rain: 'mm', wind: 'm/s', pressure: 'hPa' },
      location: NO_PLACE })
})

test('a stored preset keeps its custom fields aligned', () => {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ units: 'imperial', decimals: 2, custom: { temp: 'C' } }))
  loadSettings()
  assert.deepEqual(settings.value,
    { units: 'imperial', decimals: 2, custom: { temp: 'F', rain: 'in', wind: 'mi/h', pressure: 'hPa' },
      location: NO_PLACE })
})

test('malformed storage falls back to the defaults', () => {
  localStorage.setItem(SETTINGS_KEY, 'not json')
  loadSettings()
  assert.equal(settings.value.units, 'metric')
  localStorage.setItem(SETTINGS_KEY, '{"units":"bogus","decimals":9}')
  loadSettings()
  assert.equal(settings.value.units, 'metric')
  assert.equal(settings.value.decimals, 1)
})

test('a storage exception leaves the in-memory settings usable', () => {
  globalThis.localStorage = {
    getItem: () => { throw new Error('denied') },
    setItem: () => { throw new Error('denied') },
    removeItem: () => {},
  }
  loadSettings()
  assert.equal(settings.value.units, 'metric')
  setUnits('imperial')
  assert.equal(settings.value.units, 'imperial')
})

test('a location round-trips through storage', () => {
  setLocation({ lat: 40.015, lon: -105.2705, label: 'Boulder, Colorado', zone: 'America/Denver', zoom: 12 })
  loadSettings()
  assert.deepEqual(settings.value.location,
    { lat: 40.015, lon: -105.2705, label: 'Boulder, Colorado', zone: 'America/Denver', zoom: 12 })
  assert.equal(hasLocation(), true)
})

test('an out-of-range or non-numeric coordinate is refused', () => {
  for (const bad of [{ lat: 91, lon: 0 }, { lat: 0, lon: 181 }, { lat: '40', lon: 0 },
                     { lat: NaN, lon: 0 }, { lat: Infinity, lon: 0 }]) {
    loadSettings()
    setLocation(bad)
    assert.equal(hasLocation(), false, JSON.stringify(bad))
  }
})

test('half a coordinate pair is not a location', () => {
  setLocation({ lat: 40.015 })
  assert.equal(hasLocation(), false)
  assert.equal(settings.value.location.lat, null)
})

test('an unknown time zone is dropped and the browser zone stands in', () => {
  setLocation({ lat: 40.015, lon: -105.2705, zone: 'Mars/Olympus_Mons' })
  assert.equal(settings.value.location.zone, '')
  assert.equal(activeZone(), localZone())

  setLocation({ zone: 'Europe/Berlin' })
  assert.equal(activeZone(), 'Europe/Berlin')
})

test('a zoom outside 1-19 falls back, and a label is capped', () => {
  setLocation({ lat: 0, lon: 0, zoom: 40, label: 'x'.repeat(300) })
  assert.equal(settings.value.location.zoom, 11)
  assert.equal(settings.value.location.label.length, 120)
})

test('settings stored before locations existed load clean', () => {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ units: 'imperial', decimals: 2 }))
  loadSettings()
  assert.equal(settings.value.units, 'imperial')
  assert.deepEqual(settings.value.location, NO_PLACE)
  assert.equal(hasLocation(), false)
})

test('clearing a location leaves the units alone', () => {
  setUnits('imperial')
  setLocation({ lat: 40.015, lon: -105.2705 })
  clearLocation()
  assert.equal(hasLocation(), false)
  assert.equal(settings.value.units, 'imperial')
})
