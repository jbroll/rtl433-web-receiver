import { test } from 'node:test'
import assert from 'node:assert/strict'

import { offsetMinutes, offsetText, isDST, hhmm } from '../src/feeds/zone.js'

const utc = (y, mo, d, h = 0) => new Date(Date.UTC(y, mo - 1, d, h))

test('a zone offset is read back from Intl, on both sides of a transition', () => {
  assert.equal(offsetMinutes(utc(2026, 1, 15), 'America/Denver'), -420)
  assert.equal(offsetMinutes(utc(2026, 7, 15), 'America/Denver'), -360)
  assert.equal(offsetMinutes(utc(2026, 1, 15), 'UTC'), 0)
})

test('a half-hour and a three-quarter-hour zone come out whole', () => {
  assert.equal(offsetMinutes(utc(2026, 1, 15), 'Asia/Kolkata'), 330)
  assert.equal(offsetMinutes(utc(2026, 1, 15), 'Asia/Kathmandu'), 345)
})

test('an offset formats with a sign and two-digit parts', () => {
  assert.equal(offsetText(-420), '-07:00')
  assert.equal(offsetText(330), '+05:30')
  assert.equal(offsetText(345), '+05:45')
  assert.equal(offsetText(0), '+00:00')
})

test('DST is reported for both hemispheres and refused where there is none', () => {
  assert.equal(isDST(utc(2026, 7, 15), 'America/Denver'), true)
  assert.equal(isDST(utc(2026, 1, 15), 'America/Denver'), false)
  assert.equal(isDST(utc(2026, 1, 15), 'Australia/Sydney'), true)
  assert.equal(isDST(utc(2026, 7, 15), 'Australia/Sydney'), false)
  assert.equal(isDST(utc(2026, 7, 15), 'Asia/Kolkata'), false)
  assert.equal(isDST(utc(2026, 7, 15), 'UTC'), false)
})

test('a time renders in its zone, and a missing one renders as a dash', () => {
  assert.equal(hhmm(utc(2026, 6, 21, 18), 'UTC'), '18:00')
  assert.equal(hhmm(utc(2026, 6, 21, 18), 'America/Denver'), '12:00')
  assert.equal(hhmm(null, 'UTC'), '—')
})
