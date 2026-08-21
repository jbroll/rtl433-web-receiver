import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { settings, SETTINGS_KEY, loadSettings, saveSettings, setUnits, setDecimals, setCustomField,
         setLocation, clearLocation, hasLocation, activeZone, localZone,
         locations, tzOffsets, onLocationFrame, onTzFrame, locationForSources } from '../src/settings.js'
import { sources } from '../src/sources.js'

function fakeStorage() {
  const map = new Map()
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  }
  return map
}

// setLocation POSTs the offset to location.origin; the node tests have neither
// global, so stand in for the browser.
globalThis.location = { origin: 'http://receiver.test' }
globalThis.fetch = async () => ({})

beforeEach(() => {
  fakeStorage()
  loadSettings()
  sources.value = []
  locations.value = new Map()
  tzOffsets.value = new Map()
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

test('setLocation does not POST when the serving origin is not a configured source', async () => {
  const posted = []
  globalThis.fetch = async (url) => { posted.push(url); return {} }
  sources.value = []
  setLocation({ lat: 40.015, lon: -105.2705 })
  assert.deepEqual(posted, [])
  globalThis.fetch = async () => ({})
})

test('setLocation POSTs both /$tz and /$location when the origin is a configured source', async () => {
  const posted = []
  globalThis.fetch = async (url, opts) => { posted.push([url, opts.body]); return {} }
  sources.value = ['http://receiver.test']
  setLocation({ lat: 40.015, lon: -105.2705, label: 'Boulder', zone: 'America/Denver', zoom: 12 })
  assert.equal(posted.length, 2)
  assert.deepEqual(posted.map(p => p[0]).sort(),
    ['http://receiver.test/$location', 'http://receiver.test/$tz'])
  globalThis.fetch = async () => ({})
})

test('setLocation does not POST a blanked location when only the fallback has one', async () => {
  const posted = []
  globalThis.fetch = async (url) => { posted.push(url); return {} }
  sources.value = ['http://receiver.test']
  onLocationFrame('http://receiver.test', { lat: 5, lon: 6, label: '', zone: 'Europe/Berlin', zoom: 11 })
  setLocation({ lat: 40.015 })
  assert.deepEqual(posted, [])
  globalThis.fetch = async () => ({})
})

test('onLocationFrame stores a valid object and clears on a non-object payload', () => {
  onLocationFrame('http://a', { lat: 10, lon: 20, label: '', zone: '', zoom: 5 })
  assert.equal(locations.value.get('http://a').lat, 10)
  onLocationFrame('http://a', null)
  assert.equal(locations.value.has('http://a'), false)
})

test('onTzFrame stores a finite number and clears on anything else', () => {
  onTzFrame('http://a', -300)
  assert.equal(tzOffsets.value.get('http://a'), -300)
  onTzFrame('http://a', 'nope')
  assert.equal(tzOffsets.value.has('http://a'), false)
})

test('locationForSources picks the first source in order that published one', () => {
  const map = new Map([['http://b', { lat: 1, lon: 1 }], ['http://a', { lat: 2, lon: 2 }]])
  assert.equal(locationForSources(map, ['http://a', 'http://b']).lat, 2)
  assert.equal(locationForSources(map, ['http://c', 'http://b']).lat, 1)
  assert.equal(locationForSources(map, ['http://c']), null)
})

test('locationForSources skips a coordinate-less entry', () => {
  const map = new Map([['http://a', { lat: null, lon: null }], ['http://b', { lat: 2, lon: 2 }]])
  assert.equal(locationForSources(map, ['http://a', 'http://b']).lat, 2)
  assert.equal(locationForSources(map, ['http://a']), null)
})

test('hasLocation falls back to a configured source with no local location set', () => {
  assert.equal(hasLocation(), false)
  sources.value = ['http://a', 'http://b']
  onLocationFrame('http://b', { lat: 5, lon: 6, label: '', zone: '', zoom: 11 })
  assert.equal(hasLocation(), true)
  onLocationFrame('http://a', { lat: 7, lon: 8, label: '', zone: '', zoom: 11 })
  assert.equal(hasLocation(), true)
})

test('a local location always wins over the network fallback', () => {
  sources.value = ['http://a']
  onLocationFrame('http://a', { lat: 5, lon: 6, label: '', zone: '', zoom: 11 })
  setLocation({ lat: 40.015, lon: -105.2705 })
  assert.equal(settings.value.location.lat, 40.015)
  assert.equal(hasLocation(), true)
})

test('the network fallback never writes into localStorage', () => {
  sources.value = ['http://a']
  onLocationFrame('http://a', { lat: 5, lon: 6, label: '', zone: 'Europe/Berlin', zoom: 11 })
  assert.equal(hasLocation(), true)
  assert.deepEqual(settings.value.location, NO_PLACE)
  assert.equal(activeZone(), 'Europe/Berlin')
})

test('activeZone falls back to the network location zone, then the browser zone', () => {
  sources.value = ['http://a']
  assert.equal(activeZone(), localZone())
  onLocationFrame('http://a', { lat: 5, lon: 6, label: '', zone: '', zoom: 11 })
  assert.equal(activeZone(), localZone())
  onLocationFrame('http://a', { lat: 5, lon: 6, label: '', zone: 'Europe/Berlin', zoom: 11 })
  assert.equal(activeZone(), 'Europe/Berlin')
})
