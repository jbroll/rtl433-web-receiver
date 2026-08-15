import { test } from 'node:test'
import assert from 'node:assert/strict'

import { matchFilter, validFilter, validTopic } from '../src/topic.js'

test('a literal filter matches only its own topic', () => {
  assert.equal(matchFilter('a/b/c', 'a/b/c'), true)
  assert.equal(matchFilter('a/b/c', 'a/b/d'), false)
  assert.equal(matchFilter('a/b/c', 'a/b'), false)
  assert.equal(matchFilter('a/b/c', 'a/b/c/d'), false)
})

test('+ matches exactly one segment', () => {
  assert.equal(matchFilter('a/+/c', 'a/b/c'), true)
  assert.equal(matchFilter('a/+/c', 'a//c'), true)
  assert.equal(matchFilter('a/+/c', 'a/b/d/c'), false)
  assert.equal(matchFilter('a/+', 'a'), false)
})

test('# matches the remainder including nothing', () => {
  assert.equal(matchFilter('a/#', 'a/b/c'), true)
  assert.equal(matchFilter('a/#', 'a'), true)
  assert.equal(matchFilter('#', 'a/b/c'), true)
  assert.equal(matchFilter('a/#', 'b/c'), false)
})

test('a device filter excludes alias topics below it', () => {
  const filter = 'rtl433-a1b2c3/+/+'
  assert.equal(matchFilter(filter, 'rtl433-a1b2c3/Acurite-5n1/1234'), true)
  assert.equal(matchFilter(filter, 'rtl433-a1b2c3/Acurite-5n1/1234/$alias'), false)
  assert.equal(matchFilter('rtl433-a1b2c3/#', 'rtl433-a1b2c3/Acurite-5n1/1234/$alias'), true)
})

test('a topic may not be empty or carry a wildcard', () => {
  assert.equal(validTopic('a/b/c'), true)
  assert.equal(validTopic('a/b/c/$alias'), true)
  assert.equal(validTopic(''), false)
  assert.equal(validTopic('a/+/c'), false)
  assert.equal(validTopic('a/#'), false)
  assert.equal(validTopic('a/ /c'), false)
})

test('a filter takes wildcards only as whole segments, # only last', () => {
  assert.equal(validFilter('a/+/c'), true)
  assert.equal(validFilter('#'), true)
  assert.equal(validFilter('a/#'), true)
  assert.equal(validFilter(''), false)
  assert.equal(validFilter('a/#/c'), false)
  assert.equal(validFilter('a/b+/c'), false)
  assert.equal(validFilter('a/#b'), false)
})
