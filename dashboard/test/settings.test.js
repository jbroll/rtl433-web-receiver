import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { settings, SETTINGS_KEY, loadSettings, saveSettings, setUnits, setDecimals, setCustomField,
         setLocation, clearLocation, hasLocation, activeZone, localZone,
         locations, tzOffsets, onLocationFrame, onTzFrame, locationForSources,
         unitsBySource, onUnitsFrame, unitsForSources, publishUnits } from '../src/settings.js'
import { sources } from '../src/sources.js'
import { tokens, setToken } from '../src/auth.js'
import { toast } from '../src/toast.js'

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
  unitsBySource.value = new Map()
  tokens.value = new Map()
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

test('setLocation attaches the Authorization header to $tz when a token is stored for the origin', async () => {
  const posted = []
  globalThis.fetch = async (url, opts) => { posted.push([url, opts.headers]); return {} }
  sources.value = ['http://receiver.test']
  setToken('http://receiver.test', 'secret')
  setLocation({ lat: 40.015, lon: -105.2705 })
  const tzCall = posted.find(p => p[0].endsWith('/$tz'))
  assert.equal(tzCall[1].Authorization, 'Bearer secret')
  globalThis.fetch = async () => ({})
})

test('setLocation omits the Authorization header on $tz when no token is stored', async () => {
  const posted = []
  globalThis.fetch = async (url, opts) => { posted.push([url, opts.headers]); return {} }
  sources.value = ['http://receiver.test']
  setLocation({ lat: 40.015, lon: -105.2705 })
  const tzCall = posted.find(p => p[0].endsWith('/$tz'))
  assert.equal(tzCall[1].Authorization, undefined)
  globalThis.fetch = async () => ({})
})

test('setLocation surfaces a 401 on $tz as a toast, not only console.error', async () => {
  toast.value = null
  globalThis.fetch = async (url) => (url.endsWith('/$tz') ? { status: 401, ok: false } : {})
  sources.value = ['http://receiver.test']
  setLocation({ lat: 40.015, lon: -105.2705 })
  await new Promise(r => setTimeout(r, 10))
  assert.ok(toast.value)
  globalThis.fetch = async () => ({})
})

test('setLocation attaches the Authorization header to $location when a token is stored for the origin', async () => {
  const posted = []
  globalThis.fetch = async (url, opts) => { posted.push([url, opts.headers]); return {} }
  sources.value = ['http://receiver.test']
  setToken('http://receiver.test', 'secret')
  setLocation({ lat: 40.015, lon: -105.2705 })
  const locCall = posted.find(p => p[0].endsWith('/$location'))
  assert.equal(locCall[1].Authorization, 'Bearer secret')
  globalThis.fetch = async () => ({})
})

test('setLocation omits the Authorization header on $location when no token is stored', async () => {
  const posted = []
  globalThis.fetch = async (url, opts) => { posted.push([url, opts.headers]); return {} }
  sources.value = ['http://receiver.test']
  setLocation({ lat: 40.015, lon: -105.2705 })
  const locCall = posted.find(p => p[0].endsWith('/$location'))
  assert.equal(locCall[1].Authorization, undefined)
  globalThis.fetch = async () => ({})
})

test('setLocation surfaces a 401 on $location as a toast, not only console.error', async () => {
  toast.value = null
  globalThis.fetch = async (url) => (url.endsWith('/$location') ? { status: 401, ok: false } : {})
  sources.value = ['http://receiver.test']
  setLocation({ lat: 40.015, lon: -105.2705 })
  await new Promise(r => setTimeout(r, 10))
  assert.ok(toast.value)
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

const IMPERIAL = { units: 'imperial', decimals: 2,
                   custom: { temp: 'F', rain: 'in', wind: 'mi/h', pressure: 'hPa' } }

test('a $units frame is adopted when the browser had nothing stored', () => {
  sources.value = ['http://a']
  onUnitsFrame('http://a', IMPERIAL)
  assert.equal(settings.value.units, 'imperial')
  assert.equal(settings.value.decimals, 2)
  assert.equal(settings.value.custom.temp, 'F')
})

test('an adopted $units frame is not written into localStorage', () => {
  sources.value = ['http://a']
  onUnitsFrame('http://a', IMPERIAL)
  assert.equal(localStorage.getItem(SETTINGS_KEY), null)
})

test('a $units frame does not override settings the browser had stored', () => {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ units: 'metric', decimals: 3 }))
  loadSettings()
  sources.value = ['http://a']
  onUnitsFrame('http://a', IMPERIAL)
  assert.equal(settings.value.units, 'metric')
  assert.equal(settings.value.decimals, 3)
})

test('a $units frame does not override a choice the visitor has since made', () => {
  sources.value = ['http://a']
  setUnits('metric')
  onUnitsFrame('http://a', IMPERIAL)
  assert.equal(settings.value.units, 'metric')
  assert.equal(settings.value.custom.temp, 'C')
})

test('onUnitsFrame cleans what it stores and clears on a malformed payload', () => {
  onUnitsFrame('http://a', { units: 'bogus', decimals: 9, custom: { temp: 'K' } })
  assert.deepEqual(unitsBySource.value.get('http://a'),
    { units: 'metric', decimals: 1, custom: { temp: 'C', rain: 'mm', wind: 'km/h', pressure: 'hPa' } })
  assert.equal(settings.value.units, 'metric')
  for (const bad of ['imperial', 42, null, ['imperial']]) {
    onUnitsFrame('http://a', bad)
    assert.equal(unitsBySource.value.has('http://a'), false, JSON.stringify(bad))
  }
})

test('unitsForSources picks the first source in order that published one', () => {
  const map = new Map([['http://b', { units: 'imperial' }], ['http://a', { units: 'custom' }]])
  assert.equal(unitsForSources(map, ['http://a', 'http://b']).units, 'custom')
  assert.equal(unitsForSources(map, ['http://c', 'http://b']).units, 'imperial')
  assert.equal(unitsForSources(map, ['http://c']), null)
})

test('a unit change POSTs $units only when the origin is a configured source', async () => {
  const posted = []
  globalThis.fetch = async (url, opts) => { posted.push([url, opts.body]); return {} }
  sources.value = []
  setUnits('imperial')
  assert.deepEqual(posted, [])
  sources.value = ['http://receiver.test']
  setDecimals(3)
  setCustomField('temp', 'C')
  assert.equal(posted.length, 2)
  assert.deepEqual(posted.map(p => p[0]),
    ['http://receiver.test/$units', 'http://receiver.test/$units'])
  assert.deepEqual(JSON.parse(posted[0][1]),
    { units: 'imperial', decimals: 3,
      custom: { temp: 'F', rain: 'in', wind: 'mi/h', pressure: 'hPa' } })
  globalThis.fetch = async () => ({})
})

test('a browser that only ever set a location still adopts the receiver units', () => {
  sources.value = ['http://a']
  setLocation({ lat: 40, lon: -105, zone: 'America/Denver' })
  loadSettings()
  onUnitsFrame('http://a', IMPERIAL)
  assert.equal(settings.value.units, 'imperial')
})

test('settings stored before $units existed count as a unit choice', () => {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ units: 'metric', decimals: 3 }))
  loadSettings()
  sources.value = ['http://a']
  onUnitsFrame('http://a', IMPERIAL)
  assert.equal(settings.value.units, 'metric')
})

test('publishUnits POSTs the current units when the origin is a configured source', () => {
  const posted = []
  globalThis.fetch = async (url, opts) => { posted.push([url, opts.body]); return {} }
  sources.value = ['http://receiver.test']
  publishUnits()
  assert.deepEqual(posted,
    [['http://receiver.test/$units',
      JSON.stringify({ units: 'metric', decimals: 1,
                       custom: { temp: 'C', rain: 'mm', wind: 'km/h', pressure: 'hPa' } })]])
  globalThis.fetch = async () => ({})
})

test('publishUnits does not POST when the serving origin is not a configured source', () => {
  const posted = []
  globalThis.fetch = async (url) => { posted.push(url); return {} }
  sources.value = []
  publishUnits()
  assert.deepEqual(posted, [])
  globalThis.fetch = async () => ({})
})

test('publishUnits attaches the Authorization header when a token is stored for the origin', () => {
  const posted = []
  globalThis.fetch = async (url, opts) => { posted.push([url, opts.headers]); return {} }
  sources.value = ['http://receiver.test']
  setToken('http://receiver.test', 'secret')
  publishUnits()
  assert.equal(posted[0][1].Authorization, 'Bearer secret')
  globalThis.fetch = async () => ({})
})

test('publishUnits omits the Authorization header when no token is stored', () => {
  const posted = []
  globalThis.fetch = async (url, opts) => { posted.push([url, opts.headers]); return {} }
  sources.value = ['http://receiver.test']
  publishUnits()
  assert.equal(posted[0][1].Authorization, undefined)
  globalThis.fetch = async () => ({})
})

test('publishUnits surfaces a 401 as a toast, not only console.error', async () => {
  toast.value = null
  globalThis.fetch = async () => ({ status: 401, ok: false })
  sources.value = ['http://receiver.test']
  publishUnits()
  await new Promise(r => setTimeout(r, 10))
  assert.ok(toast.value)
  globalThis.fetch = async () => ({})
})

test('publishUnits leaves the adoption latch open', () => {
  sources.value = ['http://receiver.test']
  publishUnits()
  onUnitsFrame('http://receiver.test', IMPERIAL)
  assert.equal(settings.value.units, 'imperial')
})
