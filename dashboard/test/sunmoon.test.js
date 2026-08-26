import { test } from 'node:test'
import assert from 'node:assert/strict'

import { sunEvents, moonPhase, moonTimes } from '../src/astro.js'
import { hhmm } from '../src/zone.js'
import sun from '../src/feeds/sun.js'
import moon from '../src/feeds/moon.js'

const BOULDER = { lat: 40.015, lon: -105.2705, zone: 'America/Denver', place: '', meta: null }
const POLE = { lat: 89.9, lon: 0, zone: 'UTC', place: '', meta: null }
const SOUTH_POLE = { lat: -89.9, lon: 0, zone: 'UTC', place: '', meta: null }

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const roundTrip = v => JSON.parse(JSON.stringify(v))

test('the sun feed reports its dial and every event as a scalar', () => {
  const { fields } = sun.run(BOULDER)
  assert.deepEqual(Object.keys(fields), [
    'sun', 'sunrise', 'sunset', 'solar_noon', 'civil_dawn', 'civil_dusk',
    'nautical_dawn', 'nautical_dusk', 'astro_dawn', 'astro_dusk', 'day_length',
  ])
  assert.equal(fields.sun.$r, 'sun')
})

test('the moon feed reports its disc, times and phase', () => {
  const { fields } = moon.run(BOULDER)
  assert.deepEqual(Object.keys(fields), [
    'moon', 'moonrise', 'moonset', 'phase', 'moon_age', 'illumination',
  ])
  assert.equal(fields.moon.$r, 'moon')
})

test('both feeds are computed on a quarter hour', () => {
  for (const feed of [sun, moon]) {
    assert.equal(feed.stamped, false)
    assert.equal(feed.interval, 900000)
  }
  assert.equal(sun.id, 'sun')
  assert.equal(sun.topic, 'Sun')
  assert.equal(moon.id, 'moon')
  assert.equal(moon.topic, 'Moon')
})

test('a rich value survives the cache round trip unchanged', () => {
  for (const ctx of [BOULDER, POLE, SOUTH_POLE]) {
    const s = sun.run(ctx).fields.sun
    assert.deepEqual(roundTrip(s), s)
    const m = moon.run(ctx).fields.moon
    assert.deepEqual(roundTrip(m), m)
  }
})

test('the dial carries epoch numbers, never dates', () => {
  const { sun: v } = sun.run(BOULDER).fields
  for (const k of ['sunrise', 'sunset', 'solarNoon', 'civilDawn', 'civilDusk',
                   'nauticalDawn', 'nauticalDusk', 'astroDawn', 'astroDusk']) {
    assert.ok(v[k] === null || typeof v[k] === 'number', `${k} is ${typeof v[k]}`)
  }
  assert.equal(typeof v.dayLength, 'number')
  assert.equal(typeof v.alwaysUp, 'boolean')
  assert.equal(typeof v.alwaysDown, 'boolean')
})

test('Boulder at the solstice rises early and sets late', () => {
  const e = sunEvents(new Date(Date.UTC(2026, 5, 21, 12)), BOULDER.lat, BOULDER.lon)
  assert.match(hhmm(e.sunrise, BOULDER.zone), /^05:3\d$/)
  assert.match(hhmm(e.sunset, BOULDER.zone), /^20:3\d$/)
  assert.ok(e.dayLength > 14.9 * 3600000 && e.dayLength < 15.1 * 3600000)
  assert.equal(e.alwaysUp, false)
  assert.equal(e.alwaysDown, false)
})

test('Boulder reports readable times and a brief of both', () => {
  const { fields } = sun.run(BOULDER)
  for (const f of ['sunrise', 'sunset', 'solar_noon', 'civil_dawn', 'civil_dusk',
                   'nautical_dawn', 'nautical_dusk', 'astro_dawn', 'astro_dusk']) {
    assert.match(fields[f], HHMM, `${f} read ${fields[f]}`)
  }
  assert.match(fields.day_length, /^\d{1,2}h \d{1,2}m$/)
  assert.equal(fields.sun.brief, `${fields.sunrise} / ${fields.sunset}`)
})

test('polar day and polar night dash the times they have none of', () => {
  const summer = sunEvents(new Date(Date.UTC(2026, 5, 21, 12)), 89.9, 0)
  assert.equal(summer.alwaysUp, true)
  assert.equal(hhmm(summer.sunrise, 'UTC'), '—')
  assert.equal(hhmm(summer.sunset, 'UTC'), '—')

  const winter = sunEvents(new Date(Date.UTC(2026, 11, 21, 12)), 89.9, 0)
  assert.equal(winter.alwaysDown, true)
  assert.equal(hhmm(winter.sunrise, 'UTC'), '—')
  assert.equal(hhmm(winter.sunset, 'UTC'), '—')
})

test('no polar field ever reads Invalid Date or NaN', () => {
  for (const ctx of [POLE, SOUTH_POLE]) {
    for (const [f, v] of Object.entries(sun.run(ctx).fields)) {
      if (typeof v !== 'string') continue
      assert.doesNotMatch(v, /Invalid|NaN/, `${f} read ${v}`)
    }
    for (const [f, v] of Object.entries(moon.run(ctx).fields)) {
      if (typeof v !== 'string') continue
      assert.doesNotMatch(v, /Invalid|NaN/, `${f} read ${v}`)
    }
  }
})

test('day length reads 24h 0m under a polar day and 0h 0m under a polar night', () => {
  for (const ctx of [POLE, SOUTH_POLE]) {
    const e = sunEvents(new Date(), ctx.lat, ctx.lon)
    const { day_length } = sun.run(ctx).fields
    if (e.alwaysUp) assert.equal(day_length, '24h 0m')
    else if (e.alwaysDown) assert.equal(day_length, '0h 0m')
    else assert.match(day_length, /^\d{1,2}h \d{1,2}m$/)
  }
})

test('the polar brief says which way the sun is stuck', () => {
  for (const ctx of [POLE, SOUTH_POLE]) {
    const e = sunEvents(new Date(), ctx.lat, ctx.lon)
    const { brief } = sun.run(ctx).fields.sun
    if (e.alwaysUp) assert.equal(brief, 'up all day')
    else if (e.alwaysDown) assert.equal(brief, 'down all day')
  }
})

test('the moon disc matches the phase it was computed from', () => {
  const { fields } = moon.run(BOULDER)
  const p = moonPhase(new Date())
  assert.equal(fields.moon.name, p.name)
  assert.equal(fields.phase, p.name)
  assert.equal(fields.moon.waxing, p.waxing)
  assert.ok(fields.moon.illumination >= 0 && fields.moon.illumination <= 1)
  assert.ok(fields.moon.phase >= 0 && fields.moon.phase < 1)
  assert.equal(fields.illumination, `${Math.round(p.illumination * 100)}%`)
  assert.equal(fields.moon.brief, `${p.name} ${Math.round(p.illumination * 100)}%`)
  assert.match(fields.moon_age, /^\d{1,2}\.\d d$/)
})

test('moonrise and moonset read as times or a dash', () => {
  const { fields } = moon.run(BOULDER)
  const t = moonTimes(new Date(), BOULDER.lat, BOULDER.lon, BOULDER.zone)
  assert.equal(fields.moonrise, hhmm(t.rise, BOULDER.zone))
  for (const f of ['moonrise', 'moonset']) {
    assert.ok(fields[f] === '—' || HHMM.test(fields[f]), `${f} read ${fields[f]}`)
  }
})
