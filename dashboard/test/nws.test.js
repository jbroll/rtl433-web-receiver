globalThis.DEVICE_MAX = 24

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parsePoints, parseStations, parseForecast, parseObservation } from '../src/feeds/nws.js'
import nws from '../src/feeds/nws.js'
import { Unsupported } from '../src/feeds/feed.js'
import { skyOf, isNight, glyphOf } from '../src/feeds/wx-icons.js'
import { splitUnit } from '../src/units.js'
import { POINTS, FORECAST, STATIONS, OBSERVATION } from './fixtures-nws.js'

// A fetch that behaves like a real one under AbortController: it never
// settles on its own, but rejects with an AbortError once its signal fires.
function fetchThatHonorsAbort() {
  return (url, opts) => new Promise((resolve, reject) => {
    if (opts && opts.signal) {
      opts.signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      })
    }
  })
}

const timeout = (ms, message) => new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))

test('the point lookup yields the urls, the zone and the place', () => {
  const m = parsePoints(POINTS)
  assert.match(m.forecast, /^https:\/\/api\.weather\.gov\/gridpoints\//)
  assert.match(m.stations, /\/stations$/)
  assert.equal(m.zone, 'America/Denver')
  assert.equal(m.city, 'Boulder')
})

test('a point outside the united states is terminal, not a retry', () => {
  assert.throws(() => parsePoints({ status: 404, title: 'Data Unavailable For Requested Point' }),
    (e) => e instanceof Unsupported && /United States only/.test(e.message))
  assert.throws(() => parsePoints(null), Unsupported)
})

test('the first usable station identifier is taken, with its distance', () => {
  assert.deepEqual(parseStations(STATIONS), { id: 'KBDU', distanceM: 6437 })
  assert.deepEqual(
    parseStations({ features: [{ properties: {} }, { properties: { stationIdentifier: 'KLMO' } }] }),
    { id: 'KLMO', distanceM: null })
  assert.deepEqual(parseStations({}), { id: '', distanceM: null })
})

test('fourteen periods fold into seven days with a high and a low', () => {
  const { days } = parseForecast(FORECAST)
  assert.equal(days.length, 7)
  assert.equal(days[0].label, 'Today')
  assert.equal(days[0].hi, 91)
  assert.equal(days[0].lo, 60)
  assert.equal(days[0].unit, 'F')
  assert.equal(days[6].label, 'Monday')
  assert.equal(days[6].hi, 89)
  assert.equal(days[6].lo, 60)
})

test('a run that opens on a night gives that night its own entry', () => {
  const periods = FORECAST.properties.periods.slice(1)
  const { days } = parseForecast({ properties: { periods } })
  assert.equal(days[0].label, 'Tonight')
  assert.equal(days[0].hi, null)
  assert.equal(days[0].lo, 60)
  assert.equal(days[1].label, 'Wednesday')
  assert.equal(days[1].hi, 88)
})

test('a trailing day with no night after it keeps a null low', () => {
  const periods = FORECAST.properties.periods.slice(0, 3)
  const { days } = parseForecast({ properties: { periods } })
  assert.equal(days.length, 2)
  assert.equal(days[1].label, 'Wednesday')
  assert.equal(days[1].lo, null)
  assert.equal(days[1].brief, 'Wednesday 88°')
})

test('a null chance of precipitation reads as zero rather than crashing', () => {
  const periods = JSON.parse(JSON.stringify(FORECAST.properties.periods))
  periods[0].probabilityOfPrecipitation = { value: null }
  delete periods[2].probabilityOfPrecipitation
  const { days } = parseForecast({ properties: { periods } })
  assert.equal(days[0].pop, 0)
  assert.equal(days[1].pop, 0)
})

test('an empty forecast is an ordinary failure, so it retries', () => {
  for (const bad of [{ properties: { periods: [] } }, {}, null]) {
    assert.throws(() => parseForecast(bad),
      (e) => e instanceof Error && !(e instanceof Unsupported),
      'an empty forecast must not stop the feed the way an unsupported point does')
  }
})

test('every forecast day survives the round trip through the cache', () => {
  const { days } = parseForecast(FORECAST)
  assert.deepEqual(JSON.parse(JSON.stringify(days)), days)
})

test('observations come out under rtl_433 field names, in their own units', () => {
  const o = parseObservation(OBSERVATION)
  assert.equal(o.fields.temperature_C, 20)
  assert.equal(o.fields.wind_avg_km_h, 9.36)
  assert.equal(o.fields.wind_dir_deg, 220)
  assert.equal(o.fields.humidity, 34.8, 'twelve decimals of humidity is noise, not data')
  assert.equal(o.text, 'Clear')
})

test('pascals become hectopascals, which is what units.js knows', () => {
  const o = parseObservation(OBSERVATION)
  assert.equal(o.fields.pressure_hPa, 1024.1)
})

test('a null reading is left out rather than stored as null', () => {
  const o = parseObservation(OBSERVATION)
  assert.equal('wind_max_km_h' in o.fields, false)
  assert.equal(parseObservation({}), null)
  assert.equal(parseObservation(null), null)
})

test('every emitted field name carries a unit units.js can convert', () => {
  const o = parseObservation(OBSERVATION)
  const expected = {
    temperature_C: '°C', dewpoint_C: '°C', humidity: '%',
    wind_avg_km_h: 'km/h', wind_dir_deg: '°', pressure_hPa: 'hPa',
  }
  for (const name of Object.keys(o.fields)) {
    assert.equal(splitUnit(name).unit, expected[name], `${name} split to the wrong unit`)
  }
})

test('the condition comes out of the icon path, first one wins', () => {
  assert.equal(skyOf('https://api.weather.gov/icons/land/day/bkn/tsra_hi,30?size=medium'), 'bkn')
  assert.equal(skyOf('https://api.weather.gov/icons/land/night/tsra_hi,40/tsra_hi,20?size=medium'), 'tsra_hi')
  assert.equal(skyOf('https://api.weather.gov/icons/land/day/few?size=medium'), 'few')
  assert.equal(skyOf('nonsense'), '')
  assert.equal(skyOf(undefined), '')
})

test('night is read from the same path', () => {
  assert.equal(isNight('https://api.weather.gov/icons/land/night/skc?size=medium'), true)
  assert.equal(isNight('https://api.weather.gov/icons/land/day/skc?size=medium'), false)
  assert.equal(isNight(null), false)
})

test('aborting the run signal actually cancels the underlying fetch request', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = fetchThatHonorsAbort()
  try {
    const controller = new AbortController()
    const run = nws.run({ lat: 40.015, lon: -105.2705, signal: controller.signal })
    controller.abort()
    await assert.rejects(
      Promise.race([run, timeout(500, 'the request was not aborted; it kept running')]),
      (e) => e.name === 'AbortError',
    )
  } finally {
    globalThis.fetch = realFetch
  }
})

test('every condition in the fixture maps to a glyph, and the unknown falls back', () => {
  const seen = new Set()
  for (const p of FORECAST.properties.periods) seen.add(skyOf(p.icon))
  for (const sky of seen) {
    assert.notEqual(glyphOf(sky, false), '·', `no glyph for ${sky}`)
  }
  assert.equal(glyphOf('nothing-like-this', false), '·')
  assert.equal(glyphOf('skc', true), '🌙')
})
