// Expected times and illuminations come from the U.S. Naval Observatory
// one-day API, https://aa.usno.navy.mil/api/rstt/oneday. All times are UTC.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { julianDay, solarPosition, sunEvents, moonPhase, moonTimes, localMidnight } from '../src/astro.js'
import { offsetMinutes } from '../src/zone.js'

const utc = (y, mo, d, h = 0, mi = 0) => new Date(Date.UTC(y, mo - 1, d, h, mi))
const MIN = 60000
const DAY = 86400000

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

// Independent check on where astro.js places an event. This bisects true
// solar altitude across the true local calendar day straight from
// `date.getUTCHours()` and `solarPosition`'s declination and equation of
// time, without `zoneDateKey` or any of the day-window machinery sunEvents
// uses, so an event solved on the wrong day, or translated by a flat
// 86400000ms rather than solved, shows up here as tens to hundreds of
// seconds of disagreement.
const BI_RAD = Math.PI / 180
const biSin = d => Math.sin(d * BI_RAD)
const biCos = d => Math.cos(d * BI_RAD)

function trueAltitude (date, lat, lon) {
  const { declination, eqOfTime } = solarPosition(date)
  const utcMinutes = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60
  let h = (utcMinutes + 4 * lon + eqOfTime) / 4 - 180
  h = ((h + 180) % 360 + 360) % 360 - 180
  return Math.asin(biSin(lat) * biSin(declination) + biCos(lat) * biCos(declination) * biCos(h)) / BI_RAD
}

// UTC instant of the zone's local midnight for the given Y-M-D. Takes the
// offset at that midnight, not at UTC midnight -- the two differ by an hour
// on a DST transition day, which is the same shortcut docs/backlog.md faults
// `moonTimes` for.
function trueLocalMidnight (y, mo, d, zone) {
  const guess = Date.UTC(y, mo - 1, d)
  const near = guess - offsetMinutes(new Date(guess), zone) * 60000
  return guess - offsetMinutes(new Date(near), zone) * 60000
}

// Bisects the crossing of `target` altitude in [from, to), scanning forward
// for the rising crossing (dir 1) or the falling one (dir -1).
function bisectCrossing (lat, lon, from, to, target, dir) {
  const step = 60000
  let prevT = from
  let prevAlt = trueAltitude(new Date(prevT), lat, lon) - target
  for (let t = from + step; t <= to; t += step) {
    const alt = trueAltitude(new Date(t), lat, lon) - target
    const crossed = dir === 1 ? (prevAlt <= 0 && alt > 0) : (prevAlt > 0 && alt <= 0)
    if (crossed) {
      let lo = prevT, hi = t, loAlt = prevAlt
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2
        const midAlt = trueAltitude(new Date(mid), lat, lon) - target
        if ((loAlt <= 0) === (midAlt <= 0)) { lo = mid; loAlt = midAlt } else hi = mid
      }
      return (lo + hi) / 2
    }
    prevT = t; prevAlt = alt
  }
  return null
}

const localDay = (y, mo, d, zone) =>
  [trueLocalMidnight(y, mo, d, zone), trueLocalMidnight(y, mo, d + 1, zone)]

// Equinox dates, not solstices: declination and the equation of time both
// change fastest near an equinox, so a wrong-day event translated by exactly
// 24h (rather than solved in the day it belongs to) drifts tens to hundreds
// of seconds from the true crossing. At a solstice both are nearly
// stationary and the same bug drifts by only ~13s, inside the suite's usual
// 60s tolerance -- which is why these dates, not June 21, are the ones that
// catch it.
test('sunrise lands within a few seconds of true solar altitude at the Sydney equinox', () => {
  const lat = -33.87, lon = 151.21, zone = 'Australia/Sydney'
  const [from, to] = localDay(2026, 9, 23, zone)
  const e = sunEvents(new Date(from + 12 * 3600000), lat, lon, zone)
  const trueMs = bisectCrossing(lat, lon, from, to, -0.833, 1)
  near(e.sunrise, new Date(trueMs), 5000, 'sunrise (Sydney equinox, vs independent bisection)')
})

test('sunrise lands within a few seconds of true solar altitude at a high-latitude equinox (Murmansk)', () => {
  const lat = 68.97, lon = 33.0827, zone = 'Europe/Moscow'
  const [from, to] = localDay(2026, 5, 19, zone)
  const e = sunEvents(new Date(from + 12 * 3600000), lat, lon, zone)
  const trueMs = bisectCrossing(lat, lon, from, to, -0.833, 1)
  near(e.sunrise, new Date(trueMs), 5000, 'sunrise (Murmansk equinox, vs independent bisection)')
})

test('sunset lands within a few seconds of true solar altitude at the Denver equinox', () => {
  const lat = 39.7392, lon = -104.9903, zone = 'America/Denver'
  const [from, to] = localDay(2026, 3, 21, zone)
  const e = sunEvents(new Date(from + 12 * 3600000), lat, lon, zone)
  const trueMs = bisectCrossing(lat, lon, from, to, -0.833, -1)
  near(e.sunset, new Date(trueMs), 5000, 'sunset (Denver equinox, vs independent bisection)')
})

// Reads the zone-local Y-M-D of a Date, independent of astro.js's own
// zoneDateKey, so these regression checks don't share a bug with the code
// under test.
function localDateKey (date, zone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(date)
  const p = Object.create(null)
  for (const { type, value } of parts) p[type] = value
  return `${p.year}-${p.month}-${p.day}`
}

// Regression for 3542f66: at Denver, requesting the local day 2026-10-30,
// the re-solved sunset landed on 2026-10-31 (a third day, past the shifted
// anchor's own day) instead of falling back to the naive-translation answer,
// which is on the right day.
test('sunset on 2026-10-30 in Denver falls on the requested local day', () => {
  const lat = 39.7392, lon = -104.9903, zone = 'America/Denver'
  const dayStart = trueLocalMidnight(2026, 10, 30, zone)
  const e = sunEvents(new Date(dayStart + 12 * 3600000), lat, lon, zone)
  assert.equal(localDateKey(e.sunset, zone), '2026-10-30')
})

// Regression for 3542f66: at Murmansk on 2026-07-23, the re-solved anchor
// found no crossing at all and returned null, flipping alwaysUp to true even
// though the sun does rise that day.
test('sunrise on 2026-07-23 in Murmansk is not dropped', () => {
  const lat = 68.9585, lon = 33.0827, zone = 'Europe/Moscow'
  const dayStart = trueLocalMidnight(2026, 7, 23, zone)
  const e = sunEvents(new Date(dayStart + 12 * 3600000), lat, lon, zone)
  assert.ok(e.sunrise instanceof Date, `sunrise was ${e.sunrise}`)
  assert.equal(e.alwaysUp, false)
  assert.equal(localDateKey(e.sunrise, zone), '2026-07-23')
})

// The worst mistimings the anchor-and-correct solve left behind. Each was
// answered by translating a solve from another day by a flat 86400000ms,
// which is off by however far declination and the equation of time moved
// over that day.
const MISTIMED = [
  ['nauticalDawn', 78.22, 15.65, 'Arctic/Longyearbyen', [2026, 9, 24], -12, 1],
  ['sunset', 39.7392, -104.9903, 'America/Denver', [2026, 10, 30], -0.833, -1],
  ['civilDawn', 27.7172, 85.3240, 'Asia/Kathmandu', [2026, 3, 20], -6, 1],
  ['civilDusk', -53.1638, -70.9171, 'America/Punta_Arenas', [2026, 3, 8], -6, -1]
]

test('the events the anchor-and-correct solve mistimed land on the true crossing', () => {
  for (const [event, lat, lon, zone, [y, mo, d], target, dir] of MISTIMED) {
    const [from, to] = localDay(y, mo, d, zone)
    const e = sunEvents(new Date(from + (to - from) / 2), lat, lon, zone)
    const trueMs = bisectCrossing(lat, lon, from, to, target, dir)
    assert.ok(trueMs !== null, `${zone} ${event} ${y}-${mo}-${d}: no true crossing to compare against`)
    near(e[event], new Date(trueMs), 1000, `${event} at ${zone} ${y}-${mo}-${d}`)
  }
})

// A spring-forward local day is 23 hours long, and the old fallback's flat
// 86400000ms shift ran past its end, dating an astroDusk a day late. No
// -18 degree falling crossing exists on any of these local days.
const NO_ASTRO_DUSK = [
  [64.1835, -51.7216, 'America/Nuuk', [2026, 3, 28]],
  [64.1835, -51.7216, 'America/Nuuk', [2027, 3, 27]],
  [71.2906, -156.7886, 'America/Anchorage', [2027, 3, 14]]
]

test('no astroDusk is reported on a spring-forward day that holds no crossing', () => {
  for (const [lat, lon, zone, [y, mo, d]] of NO_ASTRO_DUSK) {
    const [from, to] = localDay(y, mo, d, zone)
    assert.equal(to - from, 23 * 3600000, `${zone} ${y}-${mo}-${d} is not a 23-hour day`)
    assert.equal(bisectCrossing(lat, lon, from, to, -18, -1), null,
      `${zone} ${y}-${mo}-${d}: the day does hold a crossing`)
    const e = sunEvents(new Date(from + (to - from) / 2), lat, lon, zone)
    assert.equal(e.astroDusk, null, `${zone} ${y}-${mo}-${d}: astroDusk was ${e.astroDusk}`)
  }
})

// A local day near the polar summer boundary can hold two crossings of one
// altitude in one direction: one left over from the previous evening, one
// belonging to this day's own. Reporting the first put Tromso's civil dusk
// 21.5 hours before the sunset it follows, and its sunset before its sunrise.
test('a day holding two crossings of one direction reports the one its daylight ends with', () => {
  const lat = 69.65, lon = 18.96, zone = 'Europe/Oslo'

  const [from, to] = localDay(2026, 8, 15, zone)
  const e = sunEvents(new Date(from + (to - from) / 2), lat, lon, zone)
  const dusks = []
  for (let t = from; t < to; t = t + 60000) {
    const next = Math.min(t + 60000, to)
    if (trueAltitude(new Date(t), lat, lon) > -6 && trueAltitude(new Date(next), lat, lon) <= -6) dusks.push(next)
  }
  assert.equal(dusks.length, 2, `expected two civil dusks, got ${dusks.length}`)
  near(e.civilDusk, new Date(bisectCrossing(lat, lon, dusks[1] - 60000, to, -6, -1)), 1000, 'civilDusk')
  assert.ok(e.civilDusk > e.sunset, `civilDusk ${e.civilDusk?.toISOString()} is not after sunset ${e.sunset?.toISOString()}`)

  const [f2, t2] = localDay(2026, 7, 27, zone)
  const e2 = sunEvents(new Date(f2 + (t2 - f2) / 2), lat, lon, zone)
  assert.ok(e2.sunset > e2.sunrise, `sunset ${e2.sunset?.toISOString()} is not after sunrise ${e2.sunrise?.toISOString()}`)
  assert.equal(localDateKey(e2.sunset, zone), '2026-07-27')
})

// At the edge of the midnight-sun season a local day holds a sunrise and no
// sunset. dayLength used to fall through to 0, which reads as "0h 0m" and
// puts the dial's sun below the horizon on a day with 22 hours of it.
test('dayLength on a day holding one horizon crossing runs to the window edge', () => {
  const lat = 78.22, lon = 15.65, zone = 'Arctic/Longyearbyen'
  const [from, to] = localDay(2026, 4, 17, zone)
  const e = sunEvents(new Date(from + (to - from) / 2), lat, lon, zone)
  assert.ok(e.sunrise instanceof Date, `sunrise was ${e.sunrise}`)
  assert.equal(e.sunset, null, `sunset was ${e.sunset}`)
  assert.equal(e.alwaysUp, false)
  assert.ok(Math.abs(e.dayLength - (to - e.sunrise.getTime())) < 1, `dayLength ${e.dayLength} vs ${to - e.sunrise.getTime()}`)
  assert.ok(e.dayLength > 21.5 * 3600000, `dayLength ${e.dayLength / 3600000}h`)
})

// Santiago springs forward at 24:00, so 2026-09-06 has no 00:00 and begins at
// 01:00 local. Reading an offset twice oscillated between -04 and -03 and
// settled on 23:00 the previous day, stretching one window and truncating the
// other by an hour.
test('localMidnight starts the day where the zone actually starts it', () => {
  for (const [zone, y, mo, d] of [
    ['America/Santiago', 2026, 9, 6], ['America/Santiago', 2027, 9, 5],
    ['America/Santiago', 2026, 4, 5], ['America/Havana', 2026, 3, 8],
    ['Pacific/Apia', 2026, 9, 27], ['Arctic/Longyearbyen', 2026, 3, 29]
  ]) {
    const key = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    const t = localMidnight(y, mo, d, zone)
    assert.equal(localDateKey(new Date(t), zone), key, `${zone} ${key} starts on the wrong date`)
    assert.notEqual(localDateKey(new Date(t - 1), zone), key, `${zone} ${key} starts a minute late`)
  }
})

test('the Santiago 24:00 spring-forward days are bounded 24 hours apart in real time', () => {
  const start = localMidnight(2026, 9, 5, 'America/Santiago')
  const mid = localMidnight(2026, 9, 6, 'America/Santiago')
  const end = localMidnight(2026, 9, 7, 'America/Santiago')
  assert.equal(mid - start, 24 * 3600000, 'the day before the transition is not 24 hours')
  assert.equal(end - mid, 23 * 3600000, 'the transition day is not 23 hours')
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
