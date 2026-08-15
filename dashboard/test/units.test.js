import { test } from 'node:test'
import assert from 'node:assert/strict'

import { splitUnit, fmtValue, ageText, readings, mergeReadings } from '../src/units.js'

test('a unit suffix comes off the field name', () => {
  assert.deepEqual(splitUnit('temperature_F'), { name: 'temperature', unit: '°F' })
  assert.deepEqual(splitUnit('wind_avg_mi_h'), { name: 'wind avg', unit: 'mi/h' })
  assert.deepEqual(splitUnit('humidity'), { name: 'humidity', unit: '%' })
  assert.deepEqual(splitUnit('battery_ok'), { name: 'battery ok', unit: '' })
})

test('values are rounded for reading, not for storage', () => {
  assert.equal(fmtValue(71.23456789), '71.2')
  assert.equal(fmtValue(-4.5678), '-4.57')
  assert.equal(fmtValue(0.03), '0.03')
  assert.equal(fmtValue('CRC'), 'CRC')
})

test('age reads in seconds, minutes, then hours', () => {
  assert.equal(ageText(4000), '4s')
  assert.equal(ageText(125000), '2m5s')
  assert.equal(ageText(7260000), '2h1m')
  assert.equal(ageText(-5), '0s')
})

test('meta fields are not readings, and readings accumulate', () => {
  const a = readings({ model: 'X', id: 1, rssi: -70, temperature_C: 4 })
  assert.deepEqual(a, { temperature_C: 4 })
  assert.deepEqual(mergeReadings({ humidity: 91 }, { model: 'X', temperature_C: 4 }),
                   { humidity: 91, temperature_C: 4 })
})
