import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { settings, SETTINGS_KEY, loadSettings, saveSettings, setUnits, setDecimals, setCustomField } from '../src/settings.js'

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

test('first-load defaults are metric with one decimal', () => {
  assert.deepEqual(settings.value,
    { units: 'metric', decimals: 1, custom: { temp: 'C', rain: 'mm', wind: 'km/h', pressure: 'hPa' } })
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
    { units: 'custom', decimals: 3, custom: { temp: 'C', rain: 'mm', wind: 'm/s', pressure: 'hPa' } })
})

test('a stored preset keeps its custom fields aligned', () => {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ units: 'imperial', decimals: 2, custom: { temp: 'C' } }))
  loadSettings()
  assert.deepEqual(settings.value,
    { units: 'imperial', decimals: 2, custom: { temp: 'F', rain: 'in', wind: 'mi/h', pressure: 'hPa' } })
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
