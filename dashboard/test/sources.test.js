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
  src.addSource('http://bridge.local')
  src.loadSources()
  assert.deepEqual(src.sources.value, ['http://bridge.local'])
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
  assert.equal(src.addSource('http://bridge.local/'), true)
  assert.equal(src.addSource('http://bridge.local'), false)
  assert.equal(src.addSource('http://nas.local:80'), true)
  assert.deepEqual(src.sources.value, ['http://bridge.local', 'http://nas.local'])
  src.loadSources()
  assert.deepEqual(src.sources.value, ['http://bridge.local', 'http://nas.local'])
})

test('a URL with a query, fragment, or credentials is refused', () => {
  assert.equal(src.normalizeBase('http://a.b?x=1'), null)
  assert.equal(src.normalizeBase('http://a.b#frag'), null)
  assert.equal(src.normalizeBase('http://user:pass@a.b'), null)
  assert.equal(src.normalizeBase('http://user@a.b'), null)
  assert.equal(src.normalizeBase('http://a.b/mqtt'), 'http://a.b/mqtt')
})

test('removing the last source leaves an empty list', () => {
  src.addSource('http://bridge.local')
  assert.equal(src.removeSource('http://bridge.local'), true)
  assert.equal(src.removeSource('http://bridge.local'), false)
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
  assert.equal(src.addSource('http://bridge.local'), true)
  assert.equal(src.addSource('http://nas.local'), true)
  assert.deepEqual(src.sources.value, ['http://bridge.local', 'http://nas.local'])
  assert.deepEqual(writes, [])
})

test('a private IPv4 host is accepted', () => {
  assert.equal(src.addSource('http://192.168.1.5'), true)
})

test('a loopback host is accepted', () => {
  assert.equal(src.addSource('http://127.0.0.1:8080'), true)
})

test('a .local host is accepted', () => {
  assert.equal(src.addSource('http://receiver.local'), true)
})

test('a bare single-label hostname is accepted', () => {
  assert.equal(src.addSource('http://bridge'), true)
})

test('an IPv6 literal with a port is accepted when private', () => {
  assert.equal(src.addSource('http://[fc00::1]:8080'), true)
  assert.equal(src.addSource('http://[::1]:8080'), true)
})

test('a public host is refused', () => {
  assert.equal(src.addSource('http://example.com'), false)
  assert.equal(src.addSource('http://api.example.com'), false)
})

test('a public IPv4 or IPv6 host is refused', () => {
  assert.equal(src.addSource('http://8.8.8.8'), false)
  assert.equal(src.addSource('http://[2001:db8::1]'), false)
})

test('.lan and .home.arpa suffixes are accepted like .local', () => {
  assert.equal(src.addSource('http://nas.lan'), true)
  assert.equal(src.addSource('http://router.home.arpa'), true)
})
