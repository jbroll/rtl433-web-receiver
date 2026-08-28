import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  ALIASES_KEY, aliases, loadAliases, applyAliasFrame, postAlias,
  aliasOf, displayName, sourceOf, topicOf, makeKey,
} from '../src/alias.js'
import { tokens, setToken } from '../src/auth.js'
import { toast } from '../src/toast.js'

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
  aliases.value = new Map()
  loadAliases()
  tokens.value = new Map()
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
  assert.equal(aliases.value.get('a'), 'keep')
  assert.equal(aliases.value.has('b'), false)
  assert.equal(aliases.value.has('c'), false)
  assert.equal(aliases.value.has('d'), false)
})

test('loadAliases leaves the map empty when storage is empty', () => {
  loadAliases()
  assert.equal(aliases.value.size, 0)
})

test('loadAliases leaves the map empty when storage is corrupt', () => {
  localStorage.setItem(ALIASES_KEY, '{not json')
  loadAliases()
  assert.equal(aliases.value.size, 0)
})

test('applyAliasFrame sets an alias and persists it', () => {
  applyAliasFrame(`${K}/$alias`, 'Back fence')
  assert.equal(aliasOf(K), 'Back fence')
  assert.deepEqual(JSON.parse(localStorage.getItem(ALIASES_KEY)), { [K]: 'Back fence' })
})

test('applyAliasFrame removes an alias and persists the removal', () => {
  aliases.value.set(K, 'Back fence')
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
  aliases.value.set(K, 'Back fence')
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

test('postAlias clears an alias with a zero-length body, not an empty JSON string', () => {
  postAlias(K, 'Back fence')
  postAlias(K, '')
  assert.equal(fetches.length, 2)
  assert.equal(fetches[1].opts.method, 'POST')
  assert.equal(fetches[1].opts.body, undefined)
})

test('postAlias attaches the Authorization header when a token is stored for the origin', () => {
  setToken(BASE, 'secret')
  postAlias(K, 'Back fence')
  assert.equal(fetches[0].opts.headers.Authorization, 'Bearer secret')
})

test('postAlias omits the Authorization header when no token is stored for the origin', () => {
  postAlias(K, 'Back fence')
  assert.equal(fetches[0].opts.headers.Authorization, undefined)
})

test('postAlias attaches the header on a clearing post too', () => {
  setToken(BASE, 'secret')
  postAlias(K, 'Back fence')
  postAlias(K, '')
  assert.equal(fetches[1].opts.headers.Authorization, 'Bearer secret')
})

test('a token stored for a different origin is not sent', () => {
  setToken(OTHER, 'other-secret')
  postAlias(K, 'Back fence')
  assert.equal(fetches[0].opts.headers.Authorization, undefined)
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

test('postAlias toasts a failed POST without throwing', async () => {
  const origFetch = globalThis.fetch
  try {
    toast.value = null
    globalThis.fetch = () => Promise.resolve({ ok: false, status: 503 })
    postAlias(K, 'Back fence')
    await new Promise(r => setTimeout(r, 10))
    assert.ok(toast.value)
    assert.match(toast.value.msg, /503/)

    toast.value = null
    globalThis.fetch = () => Promise.reject(new Error('network down'))
    postAlias(K, 'Back fence')
    await new Promise(r => setTimeout(r, 10))
    assert.ok(toast.value)
    assert.match(toast.value.msg, /network down/)
  } finally {
    globalThis.fetch = origFetch
  }
})

test('postAlias surfaces a 401 as a toast, not only console.error', async () => {
  toast.value = null
  globalThis.fetch = () => Promise.resolve({ ok: false, status: 401 })
  postAlias(K, 'Back fence')
  await new Promise(r => setTimeout(r, 10))
  assert.ok(toast.value)
  assert.match(toast.value.msg, /401|token|unauthorized/i)
})

test('postAlias reverts the local alias when the device rejects the rename', async () => {
  aliases.value.set(K, 'Original')
  globalThis.fetch = () => Promise.resolve({ ok: false, status: 503 })
  postAlias(K, 'Rejected name')
  assert.equal(aliasOf(K), 'Rejected name')
  await new Promise(r => setTimeout(r, 10))
  assert.equal(aliasOf(K), 'Original')
  assert.deepEqual(JSON.parse(localStorage.getItem(ALIASES_KEY)), { [K]: 'Original' })
})

test('postAlias reverts to no alias when there was none before a rejected rename', async () => {
  globalThis.fetch = () => Promise.resolve({ ok: false, status: 503 })
  postAlias(K, 'Rejected name')
  await new Promise(r => setTimeout(r, 10))
  assert.equal(aliasOf(K), '')
  assert.equal(localStorage.getItem(ALIASES_KEY), '{}')
})

test('postAlias also reverts on a 401, since the device did not take the name either', async () => {
  aliases.value.set(K, 'Original')
  globalThis.fetch = () => Promise.resolve({ ok: false, status: 401 })
  postAlias(K, 'Rejected name')
  await new Promise(r => setTimeout(r, 10))
  assert.equal(aliasOf(K), 'Original')
})

test('postAlias reverts on a fetch rejection with no response at all', async () => {
  aliases.value.set(K, 'Original')
  globalThis.fetch = () => Promise.reject(new Error('network down'))
  postAlias(K, 'Rejected name')
  await new Promise(r => setTimeout(r, 10))
  assert.equal(aliasOf(K), 'Original')
})

test('a late failure from a superseded rename does not clobber a newer successful rename', async () => {
  aliases.value.set(K, 'Original')
  let resolveFirst
  globalThis.fetch = () => new Promise((resolve) => { resolveFirst = resolve })
  postAlias(K, 'First attempt')

  globalThis.fetch = () => Promise.resolve({ ok: true })
  postAlias(K, 'Second attempt')
  await new Promise(r => setTimeout(r, 10))
  assert.equal(aliasOf(K), 'Second attempt')

  resolveFirst({ ok: false, status: 503 })
  await new Promise(r => setTimeout(r, 10))
  assert.equal(aliasOf(K), 'Second attempt')
})
