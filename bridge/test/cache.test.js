import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createCache } from '../src/cache.js'

test('a topic never set has no message', () => {
  const cache = createCache()
  assert.equal(cache.get('a/b/c'), undefined)
  assert.equal(cache.size(), 0)
})

test('set replaces rather than accumulates', () => {
  const cache = createCache()
  cache.set('a/b/c', '{"t":1}')
  cache.set('a/b/c', '{"t":2}')
  assert.equal(cache.get('a/b/c'), '{"t":2}')
  assert.equal(cache.size(), 1)
})

test('entries yields every pair in insertion order', () => {
  const cache = createCache()
  cache.set('src/Acurite/1/temperature_C', '21.4')
  cache.set('src/Other/1/humidity', '48')
  cache.set('src/Acurite/2/temperature_C', '19.0')
  assert.deepEqual([...cache.entries()], [
    ['src/Acurite/1/temperature_C', '21.4'],
    ['src/Other/1/humidity', '48'],
    ['src/Acurite/2/temperature_C', '19.0'],
  ])
})

test('delete removes the topic rather than emptying it', () => {
  const cache = createCache()
  cache.set('a/b/c', '{"t":1}')
  cache.delete('a/b/c')
  assert.equal(cache.get('a/b/c'), undefined)
  assert.equal(cache.size(), 0)
  assert.deepEqual([...cache.entries()], [])
})
