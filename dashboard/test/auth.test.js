import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { TOKENS_KEY, tokens, loadTokens, tokenFor, setToken } from '../src/auth.js'

const A = 'http://a'
const B = 'http://b'

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
  tokens.value = new Map()
  loadTokens()
})

test('tokenFor returns empty string when nothing is stored', () => {
  assert.equal(tokenFor(A), '')
})

test('setToken stores and persists a token for an origin', () => {
  setToken(A, 'secret')
  assert.equal(tokenFor(A), 'secret')
  assert.deepEqual(JSON.parse(localStorage.getItem(TOKENS_KEY)), { [A]: 'secret' })
})

test('setToken with an empty value clears the token', () => {
  setToken(A, 'secret')
  setToken(A, '')
  assert.equal(tokenFor(A), '')
  assert.equal(localStorage.getItem(TOKENS_KEY), '{}')
})

test('setToken trims whitespace', () => {
  setToken(A, '  secret  ')
  assert.equal(tokenFor(A), 'secret')
})

test('a token stored for one origin is not returned for another', () => {
  setToken(A, 'a-secret')
  assert.equal(tokenFor(B), '')
  setToken(B, 'b-secret')
  assert.equal(tokenFor(A), 'a-secret')
  assert.equal(tokenFor(B), 'b-secret')
})

test('loadTokens restores stored tokens', () => {
  localStorage.setItem(TOKENS_KEY, JSON.stringify({ [A]: 'a-secret', [B]: 'b-secret' }))
  loadTokens()
  assert.equal(tokenFor(A), 'a-secret')
  assert.equal(tokenFor(B), 'b-secret')
})

test('loadTokens ignores non-string and empty values', () => {
  localStorage.setItem(TOKENS_KEY, JSON.stringify({ a: 'keep', b: 123, c: '', d: null }))
  loadTokens()
  assert.equal(tokenFor('a'), 'keep')
  assert.equal(tokenFor('b'), '')
  assert.equal(tokenFor('c'), '')
  assert.equal(tokenFor('d'), '')
})

test('loadTokens leaves the map empty when storage is corrupt', () => {
  localStorage.setItem(TOKENS_KEY, '{not json')
  loadTokens()
  assert.equal(tokens.value.size, 0)
})

test('a storage exception keeps tokens in memory and turns saves into no-ops', () => {
  localStorage.setItem = () => { throw new Error('quota') }
  setToken(A, 'secret')
  assert.equal(tokenFor(A), 'secret')
  assert.equal(localStorage.getItem(TOKENS_KEY), null)
})
