import { test } from 'node:test'
import assert from 'node:assert/strict'

import { registerValue, isRich, rendererFor, briefOf, labelOf } from '../src/render-values.js'

test('a scalar is never rich and never finds a renderer', () => {
  for (const v of [71.2, 0, -3, 'ok', '', true, false, null, undefined]) {
    assert.equal(isRich(v), false)
    assert.equal(rendererFor(v), null)
  }
})

test('an object is rich, and finds its renderer only once registered', () => {
  const raw = { $r: 'never-registered', brief: 'x' }
  assert.equal(isRich(raw), true)
  assert.equal(rendererFor(raw), null)

  const C = () => null
  registerValue('never-registered', C)
  assert.equal(rendererFor(raw), C)
})

test('an object with no tag is still rich, so it cannot leak as text', () => {
  assert.equal(isRich({ hi: 91 }), true)
  assert.equal(rendererFor({ hi: 91 }), null)
})

test('brief is the one-line form, and absent unless it is a string', () => {
  assert.equal(briefOf({ $r: 'x', brief: 'Tue 91/63' }), 'Tue 91/63')
  assert.equal(briefOf({ $r: 'x' }), '')
  assert.equal(briefOf({ $r: 'x', brief: 91 }), '')
  assert.equal(briefOf(91), '')
})

test('label falls back to the field name', () => {
  assert.equal(labelOf({ $r: 'x', label: 'Tuesday' }, 'day1'), 'Tuesday')
  assert.equal(labelOf({ $r: 'x' }, 'day1'), 'day1')
  assert.equal(labelOf(91, 'temperature_F'), 'temperature_F')
})
