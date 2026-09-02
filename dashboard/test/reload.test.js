import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildChanged, resetBuilds } from '../src/reload.js'

test('the first build a device reports is not a change', () => {
  resetBuilds()
  assert.equal(buildChanged('origin rtl433-4354c8/Receiver/0', '950a8ed'), false)
})

test('the same device reporting a new build is a change', () => {
  resetBuilds()
  buildChanged('origin rtl433-4354c8/Receiver/0', '950a8ed')
  assert.equal(buildChanged('origin rtl433-4354c8/Receiver/0', 'ca427af'), true)
})

test('a repeated report of the build that triggered a reload does not trigger another', () => {
  resetBuilds()
  buildChanged('origin rtl433-4354c8/Receiver/0', '950a8ed')
  buildChanged('origin rtl433-4354c8/Receiver/0', 'ca427af')
  assert.equal(buildChanged('origin rtl433-4354c8/Receiver/0', 'ca427af'), false)
})

test('two receivers on one origin reporting different builds never reload', () => {
  resetBuilds()
  const a = 'https://weather.rkroll.com rtl433-4354c8/Receiver/0'
  const b = 'https://weather.rkroll.com rtl433-435364/Receiver/0'
  // The order the broker replays retained messages in is not fixed, so the
  // two interleave. Sharing one slot made every alternation look like an
  // update and reloaded the page in a loop.
  for (let i = 0; i < 10; i++) {
    assert.equal(buildChanged(a, '950a8ed'), false)
    assert.equal(buildChanged(b, 'ca427af-dirty'), false)
  }
})

test('a build that is not a string is ignored', () => {
  resetBuilds()
  assert.equal(buildChanged('origin rtl433-4354c8/Receiver/0', undefined), false)
  assert.equal(buildChanged('origin rtl433-4354c8/Receiver/0', 7), false)
  // and the ignored values left no slot behind, so the first real one is still
  // a first sighting rather than a change
  assert.equal(buildChanged('origin rtl433-4354c8/Receiver/0', '950a8ed'), false)
})
