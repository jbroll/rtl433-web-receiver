import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  ALIASES_KEY, aliases, loadAliases, applyAliasFrame, postAlias,
  aliasOf, displayName, sourceOf, topicOf, makeKey,
} from '../src/alias.js'

const BASE = 'http://a'
const OTHER = 'http://b'
const K = `${BASE} src/Acurite-5n1/396`

function fakeStorage() {
  const map = new Map()
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  }
  return map
}

function fakeLocation(origin) {
  globalThis.location = { origin }
}

let fetches
function fakeFetch() {
  fetches = []
  globalThis.fetch = (url, opts) => {
    fetches.push({ url, opts })
    return Promise.resolve({ ok: true })
  }
}

beforeEach(() => {
  fakeStorage()
  fakeLocation(BASE)
  fakeFetch()
  aliases.clear()
  loadAliases()
})

test('loadAliases restores stored aliases', () => {
  localStorage.setItem(ALIASES_KEY, JSON.stringify({ [K]: 'Back fence' }))
  loadAliases()
  assert.equal(aliasOf(K), 'Back fence')
  assert.equal(displayName(K), 'Back fence')
})

test('loadAliases ignores non-string and empty values', () => {
  localStorage.setItem(ALIASES_KEY, JSON.stringify({
    a: 'keep',
    b: 123,
    c: '',
    d: null,
  }))
  loadAliases()
  assert.equal(aliases.get('a'), 'keep')
  assert.equal(aliases.has('b'), false)
  assert.equal(aliases.has('c'), false)
  assert.equal(aliases.has('d'), false)
})

test('loadAliases leaves the map empty when storage is empty', () => {
  loadAliases()
  assert.equal(aliases.size, 0)
})

test('loadAliases leaves the map empty when storage is corrupt', () => {
  localStorage.setItem(ALIASES_KEY, '{not json')
  loadAliases()
  assert.equal(aliases.size, 0)
})

test('applyAliasFrame sets an alias and persists it', () => {
  applyAliasFrame(`${K}/$alias`, 'Back fence')
  assert.equal(aliasOf(K), 'Back fence')
  assert.deepEqual(JSON.parse(localStorage.getItem(ALIASES_KEY)), { [K]: 'Back fence' })
})

test('applyAliasFrame removes an alias and persists the removal', () => {
  aliases.set(K, 'Back fence')
  applyAliasFrame(`${K}/$alias`, '')
  assert.equal(aliasOf(K), '')
  assert.equal(localStorage.getItem(ALIASES_KEY), '{}')
})

test('postAlias sets an alias and persists it', () => {
  postAlias(K, 'Back fence')
  assert.equal(aliasOf(K), 'Back fence')
  assert.deepEqual(JSON.parse(localStorage.getItem(ALIASES_KEY)), { [K]: 'Back fence' })
})

test('postAlias removes an alias and persists the removal', () => {
  aliases.set(K, 'Back fence')
  postAlias(K, '')
  assert.equal(aliasOf(K), '')
  assert.equal(localStorage.getItem(ALIASES_KEY), '{}')
})

test('postAlias posts to the source when it is the serving origin', () => {
  postAlias(K, 'Back fence')
  assert.equal(fetches.length, 1)
  assert.equal(fetches[0].url, `${sourceOf(K)}/${topicOf(K)}/$alias`)
  assert.equal(fetches[0].opts.method, 'POST')
  assert.equal(fetches[0].opts.body, JSON.stringify('Back fence'))
})

test('postAlias does not post when the source is not the serving origin', () => {
  fakeLocation(OTHER)
  postAlias(K, 'Back fence')
  assert.equal(fetches.length, 0)
  assert.deepEqual(JSON.parse(localStorage.getItem(ALIASES_KEY)), { [K]: 'Back fence' })
})

test('a storage exception keeps aliases in memory and turns saves into no-ops', () => {
  localStorage.setItem = () => { throw new Error('quota') }
  postAlias(K, 'Back fence')
  assert.equal(aliasOf(K), 'Back fence')
  assert.equal(localStorage.getItem(ALIASES_KEY), null)
})

test('the alias key is scoped to the full device key including source base', () => {
  const otherKey = makeKey(OTHER, topicOf(K))
  postAlias(K, 'A')
  postAlias(otherKey, 'B')
  loadAliases()
  assert.equal(aliasOf(K), 'A')
  assert.equal(aliasOf(otherKey), 'B')
})
