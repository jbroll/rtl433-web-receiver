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
  return map
}

beforeEach(() => {
  fakeStorage()
  globalThis.location = { origin: 'http://origin.test' }
  src.loadSources()
})

test('with nothing configured there are no sources and the key is absent', () => {
  assert.deepEqual(src.configured(), [])
  assert.deepEqual(src.sources.value, [])
  assert.equal(src.storageState(), 'absent')
})

test('a stored empty list is empty, not absent', () => {
  localStorage.setItem(src.SOURCES_KEY, '[]')
  src.loadSources()
  assert.deepEqual(src.sources.value, [])
  assert.equal(src.storageState(), 'empty')
})

test('a stored populated list is populated', () => {
  src.addSource('http://a.b')
  src.loadSources()
  assert.deepEqual(src.sources.value, ['http://a.b'])
  assert.equal(src.storageState(), 'populated')
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

test('added sources persist and reload', () => {
  assert.equal(src.addSource('http://a.b/'), true)
  assert.equal(src.addSource('http://a.b'), false)
  assert.equal(src.addSource('http://c.d:80'), true)
  assert.deepEqual(src.sources.value, ['http://a.b', 'http://c.d'])
  src.loadSources()
  assert.deepEqual(src.sources.value, ['http://a.b', 'http://c.d'])
})

test('a URL with a query, fragment, or credentials is refused', () => {
  assert.equal(src.normalizeBase('http://a.b?x=1'), null)
  assert.equal(src.normalizeBase('http://a.b#frag'), null)
  assert.equal(src.normalizeBase('http://user:pass@a.b'), null)
  assert.equal(src.normalizeBase('http://user@a.b'), null)
  assert.equal(src.normalizeBase('http://a.b/mqtt'), 'http://a.b/mqtt')
})

test('removing the last source leaves an empty list', () => {
  src.addSource('http://a.b')
  assert.equal(src.removeSource('http://a.b'), true)
  assert.equal(src.removeSource('http://a.b'), false)
  assert.deepEqual(src.sources.value, [])
  src.loadSources()
  assert.equal(src.storageState(), 'empty')
})

test('malformed storage yields no sources and no origin source', () => {
  localStorage.setItem(src.SOURCES_KEY, 'not json')
  src.loadSources()
  assert.deepEqual(src.sources.value, [])
  localStorage.setItem(src.SOURCES_KEY, '{"a":1}')
  src.loadSources()
  assert.deepEqual(src.sources.value, [])
})

test('a storage exception keeps adoption in memory and turns saves into no-ops', () => {
  const writes = []
  globalThis.localStorage = {
    getItem: () => { throw new Error('denied') },
    setItem: (k, v) => writes.push([k, String(v)]),
    removeItem: () => {},
  }
  src.loadSources()
  assert.equal(src.storageState(), 'absent')
  assert.equal(src.addSource('http://a.b'), true)
  assert.equal(src.addSource('http://c.d'), true)
  assert.deepEqual(src.sources.value, ['http://a.b', 'http://c.d'])
  assert.deepEqual(writes, [])
})
