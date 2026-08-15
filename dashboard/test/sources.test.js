import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import * as src from '../src/sources.js'

function fakeStorage() {
  const map = new Map()
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  }
}

beforeEach(() => {
  fakeStorage()
  globalThis.location = { origin: 'http://origin.test' }
  src.loadSources()
})

test('with nothing configured the origin is the one source', () => {
  assert.deepEqual(src.configured(), [])
  assert.deepEqual(src.sources(), ['http://origin.test'])
})

test('a base URL loses its trailing slash and keeps its port and path', () => {
  assert.equal(src.normalizeBase('http://bridge.local:8080/'), 'http://bridge.local:8080')
  assert.equal(src.normalizeBase('http://bridge.local:8080/mqtt/'), 'http://bridge.local:8080/mqtt')
  assert.equal(src.normalizeBase('  http://a.b  '), 'http://a.b')
})

test('a URL that is not http is refused', () => {
  assert.equal(src.normalizeBase('ws://a.b'), null)
  assert.equal(src.normalizeBase('not a url'), null)
  assert.equal(src.normalizeBase(''), null)
  assert.equal(src.addSource('nope'), false)
})

test('added sources replace the origin default and persist', () => {
  assert.equal(src.addSource('http://a.b/'), true)
  assert.equal(src.addSource('http://a.b'), false)
  assert.equal(src.addSource('http://c.d:80'), true)
  assert.deepEqual(src.sources(), ['http://a.b', 'http://c.d:80'])
  src.loadSources()
  assert.deepEqual(src.sources(), ['http://a.b', 'http://c.d:80'])
})

test('removing the last source falls back to the origin', () => {
  src.addSource('http://a.b')
  assert.equal(src.removeSource('http://a.b'), true)
  assert.equal(src.removeSource('http://a.b'), false)
  assert.deepEqual(src.sources(), ['http://origin.test'])
})
