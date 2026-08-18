import { test } from 'node:test'
import assert from 'node:assert/strict'

import { splitUnit, fmtValue, displayValue, ageText, readings, mergeReadings } from '../src/units.js'

const METRIC = { decimals: 1, custom: { temp: 'C', rain: 'mm', wind: 'km/h', pressure: 'hPa' } }
const IMPERIAL = { decimals: 1, custom: { temp: 'F', rain: 'in', wind: 'mi/h', pressure: 'hPa' } }

test('a unit suffix comes off the field name', () => {
  assert.deepEqual(splitUnit('temperature_F'), { name: 'temperature', unit: '°F' })
  assert.deepEqual(splitUnit('wind_avg_mi_h'), { name: 'wind avg', unit: 'mi/h' })
  assert.deepEqual(splitUnit('humidity'), { name: 'humidity', unit: '%' })
  assert.deepEqual(splitUnit('battery_ok'), { name: 'battery ok', unit: '' })
})

test('fmtValue rounds to the requested decimals and trims trailing zeros', () => {
  assert.equal(fmtValue(71.23456789, 0), '71')
  assert.equal(fmtValue(71.23456789, 1), '71.2')
  assert.equal(fmtValue(71.23456789, 2), '71.23')
  assert.equal(fmtValue(71.23456789, 3), '71.235')
  assert.equal(fmtValue(71.23456789, 4), '71.2346')
  assert.equal(fmtValue(71.23456789, 5), '71.23457')
  assert.equal(fmtValue(3.000, 2), '3')
  assert.equal(fmtValue(-4.5678, 2), '-4.57')
  assert.equal(fmtValue('CRC', 2), 'CRC')
  assert.equal(fmtValue(true, 2), 'true')
})

test('temperature converts between Fahrenheit and Celsius', () => {
  assert.deepEqual(displayValue('temperature_F', 71.2, METRIC), { name: 'temperature', num: '21.8', unit: '°C' })
  assert.deepEqual(displayValue('temperature_C', 19.4, METRIC), { name: 'temperature', num: '19.4', unit: '°C' })
  assert.deepEqual(displayValue('temperature_C', 19.4, IMPERIAL), { name: 'temperature', num: '66.9', unit: '°F' })
  assert.deepEqual(displayValue('temperature_F', 71.2, IMPERIAL), { name: 'temperature', num: '71.2', unit: '°F' })
})

test('rain converts between millimetres and inches', () => {
  assert.deepEqual(displayValue('rain_mm', 0.03, METRIC), { name: 'rain', num: '0', unit: 'mm' })
  assert.deepEqual(displayValue('rain_mm', 0.03, { ...METRIC, decimals: 3 }), { name: 'rain', num: '0.03', unit: 'mm' })
  assert.deepEqual(displayValue('rain_mm', 25.4, IMPERIAL), { name: 'rain', num: '1', unit: 'in' })
  assert.deepEqual(displayValue('rain_in', 1, METRIC), { name: 'rain', num: '25.4', unit: 'mm' })
})

test('wind converts between mi/h, km/h and m/s', () => {
  const WIND_METRIC = { decimals: 1, custom: { temp: 'C', rain: 'mm', wind: 'km/h', pressure: 'hPa' } }
  const WIND_MPS = { ...WIND_METRIC, custom: { ...WIND_METRIC.custom, wind: 'm/s' } }
  assert.deepEqual(displayValue('wind_avg_mi_h', 4.6, WIND_METRIC), { name: 'wind avg', num: '7.4', unit: 'km/h' })
  assert.deepEqual(displayValue('wind_avg_km_h', 7.4, IMPERIAL), { name: 'wind avg', num: '4.6', unit: 'mi/h' })
  assert.deepEqual(displayValue('wind_avg_mi_h', 4.6, WIND_MPS), { name: 'wind avg', num: '2.1', unit: 'm/s' })
  assert.deepEqual(displayValue('wind_avg_m_s', 2.1, IMPERIAL), { name: 'wind avg', num: '4.7', unit: 'mi/h' })
})

test('pressure converts between hectopascals and kilopascals', () => {
  const P_KPA = { decimals: 1, custom: { temp: 'C', rain: 'mm', wind: 'km/h', pressure: 'kPa' } }
  assert.deepEqual(displayValue('pressure_hPa', 1013.25, P_KPA), { name: 'pressure', num: '101.3', unit: 'kPa' })
  assert.deepEqual(displayValue('pressure_hPa', 1013.25, METRIC), { name: 'pressure', num: '1013.3', unit: 'hPa' })
  assert.deepEqual(displayValue('pressure_kPa', 101.3, METRIC), { name: 'pressure', num: '1013', unit: 'hPa' })
})

test('fields outside a converting group pass through with their unit', () => {
  assert.deepEqual(displayValue('humidity', 38, METRIC), { name: 'humidity', num: '38', unit: '%' })
  assert.deepEqual(displayValue('battery_ok', 1, METRIC), { name: 'battery ok', num: '1', unit: '' })
  assert.deepEqual(displayValue('wind_direction_deg', 337.5, METRIC), { name: 'wind direction', num: '337.5', unit: '°' })
  assert.deepEqual(displayValue('model', 'Acurite-5n1', METRIC), { name: 'model', num: 'Acurite-5n1', unit: '' })
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
