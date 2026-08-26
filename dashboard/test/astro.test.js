// Expected times and illuminations come from the U.S. Naval Observatory
// one-day API, https://aa.usno.navy.mil/api/rstt/oneday. All times are UTC.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { julianDay, solarPosition, sunEvents, moonPhase, moonTimes } from '../src/astro.js'

const utc = (y, mo, d, h = 0, mi = 0) => new Date(Date.UTC(y, mo - 1, d, h, mi))
const MIN = 60000

function near (actual, expected, tol, label) {
  assert.ok(actual instanceof Date, `${label}: expected a Date, got ${actual}`)
  const off = Math.abs(actual.getTime() - expected.getTime())
  assert.ok(off <= tol, `${label}: ${actual.toISOString()} is ${(off / 1000).toFixed(0)}s from ${expected.toISOString()}`)
}

test('julianDay matches the standard epoch', () => {
  assert.equal(julianDay(utc(2000, 1, 1, 12, 0)), 2451545)
  assert.equal(julianDay(utc(1970, 1, 1, 0, 0)), 2440587.5)
})

test('solar declination and equation of time at the June solstice', () => {
  const { declination, eqOfTime } = solarPosition(utc(2026, 6, 21, 12, 0))
  assert.ok(Math.abs(declination - 23.44) < 0.05, `declination ${declination}`)
  assert.ok(Math.abs(eqOfTime - -1.7) < 0.5, `eqOfTime ${eqOfTime}`)
})

test('sun events at 40N 105W on 2026-06-21', () => {
  const d = utc(2026, 6, 21)
  const e = sunEvents(d, 40.0, -105.0)
  near(e.sunrise, utc(2026, 6, 21, 11, 31), 60000, 'sunrise')
  near(e.solarNoon, utc(2026, 6, 21, 19, 2), 60000, 'solarNoon')
  near(e.sunset, utc(2026, 6, 21, 2, 32), 60000, 'sunset')
  near(e.civilDawn, utc(2026, 6, 21, 10, 59), 60000, 'civilDawn')
  near(e.civilDusk, utc(2026, 6, 21, 3, 5), 60000, 'civilDusk')
  assert.equal(e.alwaysUp, false)
  assert.equal(e.alwaysDown, false)
})

test('moon at 40N 105W on 2026-06-21', () => {
  const d = utc(2026, 6, 21)
  const m = moonTimes(d, 40.0, -105.0)
  near(m.rise, utc(2026, 6, 21, 18, 59), 10 * MIN, 'moonrise')
  near(m.set, utc(2026, 6, 21, 6, 35), 10 * MIN, 'moonset')
  // USNO quotes fracillum for a date at 12:00 UT.
  const p = moonPhase(utc(2026, 6, 21, 12))
  assert.ok(Math.abs(p.illumination - 0.46) <= 0.02, `illumination ${p.illumination}`)
  assert.equal(p.waxing, true)
  assert.equal(p.name, 'Waxing Crescent')
})

test('sun and moon at 0N 0E on the March equinox', () => {
  const d = utc(2026, 3, 20)
  const e = sunEvents(d, 0.0, 0.0)
  near(e.sunrise, utc(2026, 3, 20, 6, 4), 60000, 'sunrise')
  near(e.solarNoon, utc(2026, 3, 20, 12, 7), 60000, 'solarNoon')
  near(e.sunset, utc(2026, 3, 20, 18, 11), 60000, 'sunset')
  near(e.civilDawn, utc(2026, 3, 20, 5, 44), 60000, 'civilDawn')
  near(e.civilDusk, utc(2026, 3, 20, 18, 31), 60000, 'civilDusk')
  const m = moonTimes(d, 0.0, 0.0)
  near(m.rise, utc(2026, 3, 20, 7, 3), 10 * MIN, 'moonrise')
  near(m.set, utc(2026, 3, 20, 19, 27), 10 * MIN, 'moonset')
  const p = moonPhase(utc(2026, 3, 20, 12))
  assert.ok(Math.abs(p.illumination - 0.03) <= 0.02, `illumination ${p.illumination}`)
  assert.equal(p.name, 'Waxing Crescent')
})

// A UTC instant just after local midnight must still pick the local day it
// falls on, not the next one.
test('sunrise at UTC-7 after 17:00 local is today\'s, not tomorrow\'s', () => {
  const afterFivePM = utc(2026, 6, 22, 1, 30)
  const e = sunEvents(afterFivePM, 40.0, -105.0, 'Etc/GMT+7')
  near(e.sunrise, utc(2026, 6, 21, 11, 31), 60000, 'sunrise')
})

test('sun events default to the UTC calendar day when no zone is given', () => {
  const d = utc(2026, 6, 21)
  const withZone = sunEvents(d, 40.0, -105.0, 'UTC')
  const withoutZone = sunEvents(d, 40.0, -105.0)
  assert.equal(withoutZone.sunrise.getTime(), withZone.sunrise.getTime())
})

test('sun and moon at Sydney on 2026-06-21', () => {
  const d = utc(2026, 6, 21)
  const e = sunEvents(d, -33.87, 151.21)
  near(e.sunrise, utc(2026, 6, 21, 21, 0), 60000, 'sunrise')
  near(e.solarNoon, utc(2026, 6, 21, 1, 57), 60000, 'solarNoon')
  near(e.sunset, utc(2026, 6, 21, 6, 54), 60000, 'sunset')
  near(e.civilDawn, utc(2026, 6, 21, 20, 32), 60000, 'civilDawn')
  near(e.civilDusk, utc(2026, 6, 21, 7, 22), 60000, 'civilDusk')
  const m = moonTimes(d, -33.87, 151.21)
  near(m.rise, utc(2026, 6, 21, 1, 25), 10 * MIN, 'moonrise')
  near(m.set, utc(2026, 6, 21, 13, 39), 10 * MIN, 'moonset')
})

// Sydney is UTC+10 with no DST in June, so local 2026-06-21 spans UTC
// 2026-06-20T14:00Z to 2026-06-21T14:00Z, straddling two UTC calendar days:
// its sunrise is the one the UTC-day-20 call above finds, its sunset the one
// the UTC-day-21 call finds. Both are the untouched no-zone path, so this
// check does not depend on the zone-window code it is verifying.
test('sunrise and sunset land on the Sydney local day for a UTC+10 instant', () => {
  const local0900 = utc(2026, 6, 20, 23, 0) // 2026-06-21 09:00 AEST
  const e = sunEvents(local0900, -33.87, 151.21, 'Australia/Sydney')
  near(e.sunrise, sunEvents(utc(2026, 6, 20), -33.87, 151.21).sunrise, 60000, 'sunrise')
  near(e.sunset, sunEvents(utc(2026, 6, 21), -33.87, 151.21).sunset, 60000, 'sunset')
})

// Asia/Kolkata is UTC+5:30, a non-hour offset with no DST. New Delhi's
// moonrise/moonset drift about 50 minutes later each day; local 2026-06-21's
// moonset lands just after its window closes, so that day has a moonrise and
// no moonset -- exactly the case the review called out.
test('sun and moon land on the Kolkata local day for a UTC+5:30 instant', () => {
  const local0830 = utc(2026, 6, 21, 3, 0) // 2026-06-21 08:30 IST
  const lat = 28.6139, lon = 77.2090
  const e = sunEvents(local0830, lat, lon, 'Asia/Kolkata')
  near(e.sunrise, sunEvents(utc(2026, 6, 20), lat, lon).sunrise, 60000, 'sunrise')
  near(e.sunset, sunEvents(utc(2026, 6, 21), lat, lon).sunset, 60000, 'sunset')

  const m = moonTimes(local0830, lat, lon, 'Asia/Kolkata')
  near(m.rise, moonTimes(utc(2026, 6, 21), lat, lon).rise, 10 * MIN, 'moonrise')
  assert.equal(m.set, null)
})

test('polar day at Svalbard on 2026-06-21', () => {
  const d = utc(2026, 6, 21)
  const e = sunEvents(d, 78.22, 15.65)
  assert.equal(e.alwaysUp, true)
  assert.equal(e.alwaysDown, false)
  assert.equal(e.sunrise, null)
  assert.equal(e.sunset, null)
  near(e.solarNoon, utc(2026, 6, 21, 10, 59), 5 * MIN, 'solarNoon')
  const m = moonTimes(d, 78.22, 15.65)
  near(m.rise, utc(2026, 6, 21, 10, 29), 10 * MIN, 'moonrise')
  near(m.set, utc(2026, 6, 21, 22, 5), 10 * MIN, 'moonset')
})

test('polar night at Svalbard on 2026-12-21', () => {
  const d = utc(2026, 12, 21)
  const e = sunEvents(d, 78.22, 15.65)
  assert.equal(e.alwaysDown, true)
  assert.equal(e.alwaysUp, false)
  assert.equal(e.sunrise, null)
  assert.equal(e.sunset, null)
  const m = moonTimes(d, 78.22, 15.65)
  assert.equal(m.alwaysUp, true)
  assert.equal(m.rise, null)
  assert.equal(m.set, null)
})

test('moon illumination through January 2026', () => {
  assert.ok(moonPhase(utc(2026, 1, 18, 12)).illumination <= 0.02)
  assert.equal(moonPhase(utc(2026, 1, 18, 12)).name, 'New Moon')
  const gibbous = moonPhase(utc(2026, 1, 26, 12))
  assert.ok(Math.abs(gibbous.illumination - 0.54) <= 0.02, `illumination ${gibbous.illumination}`)
  assert.equal(gibbous.name, 'Waxing Gibbous')
  const full = moonPhase(utc(2026, 2, 1, 12))
  assert.ok(full.illumination >= 0.98, `illumination ${full.illumination}`)
  assert.equal(full.name, 'Full Moon')
})

const SITES = [
  [0, 0], [51.5, -0.1], [-33.87, 151.21], [40, -105], [35.7, 139.7],
  [-23.5, -46.6], [59.3, 18.1], [-41.3, 174.8], [19.4, -99.1], [55.8, 37.6]
]
const DATES = [[2026, 1, 5], [2026, 3, 20], [2026, 6, 21], [2026, 9, 23], [2026, 12, 21]]

test('twilight events run in order through the day', () => {
  const order = ['astroDawn', 'nauticalDawn', 'civilDawn', 'sunrise', 'solarNoon',
    'sunset', 'civilDusk', 'nauticalDusk', 'astroDusk']
  let checked = 0
  for (let i = 0; i < 20; i++) {
    const [lat, lon] = SITES[i % SITES.length]
    const [y, mo, d] = DATES[(i * 3) % DATES.length]
    const e = sunEvents(utc(y, mo, d + (i % 4)), lat, lon)
    if (!e.solarNoon) continue
    // Events are reported inside one UTC day, so shift each to the same
    // solar day as noon before comparing.
    const noon = e.solarNoon.getTime()
    const times = order.map(k => {
      if (!e[k]) return null
      const t = e[k].getTime()
      return t + 86400000 * Math.round((noon - t) / 86400000)
    }).filter(t => t !== null)
    for (let j = 1; j < times.length; j++) {
      assert.ok(times[j] > times[j - 1],
        `${lat},${lon} ${y}-${mo}-${d + (i % 4)}: ${order[j]} not after ${order[j - 1]}`)
    }
    checked++
  }
  assert.ok(checked >= 18)
})

test('illumination and phase stay in range across a synodic month', () => {
  for (let i = 0; i < 30; i++) {
    const p = moonPhase(new Date(Date.UTC(2026, 4, 1) + i * 86400000))
    assert.ok(p.illumination >= 0 && p.illumination <= 1, `illumination ${p.illumination}`)
    assert.ok(p.phase >= 0 && p.phase < 1, `phase ${p.phase}`)
    assert.ok(Math.abs(p.age - p.phase * 29.530588853) < 1e-9)
  }
})

test('the phase name agrees with illumination and direction', () => {
  for (let i = 0; i < 60; i++) {
    const p = moonPhase(new Date(Date.UTC(2026, 4, 1) + i * 43200000))
    assert.equal(p.waxing, p.phase < 0.5)
    if (p.name === 'New Moon') assert.ok(p.illumination < 0.02, `${p.name} ${p.illumination}`)
    if (p.name === 'Full Moon') assert.ok(p.illumination > 0.98, `${p.name} ${p.illumination}`)
    if (p.name.endsWith('Quarter')) assert.ok(Math.abs(p.illumination - 0.5) <= 0.02, `${p.name} ${p.illumination}`)
    if (p.name.endsWith('Crescent')) assert.ok(p.illumination < 0.5, `${p.name} ${p.illumination}`)
    if (p.name.endsWith('Gibbous')) assert.ok(p.illumination > 0.5, `${p.name} ${p.illumination}`)
    if (p.name.startsWith('Waxing')) assert.equal(p.waxing, true)
    if (p.name.startsWith('Waning')) assert.equal(p.waxing, false)
  }
})

test('no returned Date is invalid', () => {
  for (const [lat, lon] of SITES.concat([[78.22, 15.65], [-78, 0], [89, 0], [-89, 180]])) {
    for (let i = 0; i < 24; i++) {
      const d = new Date(Date.UTC(2026, 0, 1) + i * 15 * 86400000)
      const e = sunEvents(d, lat, lon)
      for (const v of Object.values(e)) {
        if (v instanceof Date) assert.ok(Number.isFinite(v.getTime()), `${lat},${lon} ${d.toISOString()}`)
      }
      const m = moonTimes(d, lat, lon)
      for (const v of [m.rise, m.set]) {
        if (v !== null) assert.ok(Number.isFinite(v.getTime()), `moon ${lat},${lon} ${d.toISOString()}`)
      }
    }
  }
})
