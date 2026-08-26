import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import * as br from '../src/bridges.js'

function fakeFetch(responses) {
  const calls = []
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts })
    const key = `${(opts && opts.method) || 'GET'} ${url}`
    const r = responses[key]
    if (!r) throw new Error(`unexpected fetch ${key}`)
    if (r.throws) throw new Error('network error')
    return { ok: r.ok, status: r.status || (r.ok ? 200 : 500), json: async () => r.body }
  }
  return calls
}

beforeEach(() => {
  globalThis.location = { origin: 'http://receiver.local' }
  br.bridges.value = null
})

test('loadBridges populates the list from a 200', async () => {
  fakeFetch({
    'GET http://receiver.local/$mqtt': { ok: true, body: [{ url: 'mqtts://a:8883', connected: true }] },
  })
  await br.loadBridges()
  assert.deepEqual(br.bridges.value, [{ url: 'mqtts://a:8883', connected: true }])
})

test('loadBridges leaves the list null on a 404', async () => {
  fakeFetch({ 'GET http://receiver.local/$mqtt': { ok: false, status: 404 } })
  await br.loadBridges()
  assert.equal(br.bridges.value, null)
})

test('loadBridges leaves the list null on a network error', async () => {
  fakeFetch({ 'GET http://receiver.local/$mqtt': { throws: true } })
  await br.loadBridges()
  assert.equal(br.bridges.value, null)
})

test('loadBridges treats a non-array body as unavailable', async () => {
  fakeFetch({ 'GET http://receiver.local/$mqtt': { ok: true, body: { not: 'an array' } } })
  await br.loadBridges()
  assert.equal(br.bridges.value, null)
})

test('overlapping loadBridges calls resolve out of order and the later one wins', async () => {
  const deferred = []
  globalThis.fetch = () => new Promise(resolve => deferred.push(resolve))

  const first = br.loadBridges()
  const second = br.loadBridges()

  // The first call's fetch settles last, after the second call's already has.
  deferred[1]({ ok: true, status: 200, json: async () => [{ url: 'second', connected: true }] })
  await second
  deferred[0]({ ok: true, status: 200, json: async () => [{ url: 'first', connected: true }] })
  await first

  assert.deepEqual(br.bridges.value, [{ url: 'second', connected: true }])
})

test('addBridge posts the url and token, then reloads', async () => {
  const calls = fakeFetch({
    'POST http://receiver.local/$mqtt': { ok: true },
    'GET http://receiver.local/$mqtt': { ok: true, body: [{ url: 'mqtt://b:1883', connected: false }] },
  })
  const ok = await br.addBridge('mqtt://b:1883', 'tok')
  assert.equal(ok, true)
  assert.deepEqual(br.bridges.value, [{ url: 'mqtt://b:1883', connected: false }])
  const post = calls.find(c => c.opts && c.opts.method === 'POST' && c.url.endsWith('/$mqtt'))
  assert.deepEqual(JSON.parse(post.opts.body), { url: 'mqtt://b:1883', token: 'tok' })
})

test('addBridge defaults a missing token to an empty string', async () => {
  const calls = fakeFetch({
    'POST http://receiver.local/$mqtt': { ok: true },
    'GET http://receiver.local/$mqtt': { ok: true, body: [] },
  })
  await br.addBridge('mqtt://b:1883')
  const post = calls.find(c => c.opts && c.opts.method === 'POST' && c.url.endsWith('/$mqtt'))
  assert.deepEqual(JSON.parse(post.opts.body), { url: 'mqtt://b:1883', token: '' })
})

test('addBridge reports failure on a non-ok response and does not reload', async () => {
  const calls = fakeFetch({ 'POST http://receiver.local/$mqtt': { ok: false, status: 400 } })
  const ok = await br.addBridge('not a url', '')
  assert.equal(ok, false)
  assert.equal(calls.length, 1)
})

test('addBridge reports failure on a network error', async () => {
  fakeFetch({ 'POST http://receiver.local/$mqtt': { throws: true } })
  const ok = await br.addBridge('mqtt://b:1883', '')
  assert.equal(ok, false)
})

test('removeBridge posts the url to /$mqtt/remove, then reloads', async () => {
  const calls = fakeFetch({
    'POST http://receiver.local/$mqtt/remove': { ok: true },
    'GET http://receiver.local/$mqtt': { ok: true, body: [] },
  })
  const ok = await br.removeBridge('mqtt://b:1883')
  assert.equal(ok, true)
  assert.deepEqual(br.bridges.value, [])
  const post = calls.find(c => c.url.endsWith('/$mqtt/remove'))
  assert.deepEqual(JSON.parse(post.opts.body), { url: 'mqtt://b:1883' })
})

test('removeBridge reports failure on a non-ok response', async () => {
  const calls = fakeFetch({ 'POST http://receiver.local/$mqtt/remove': { ok: false, status: 500 } })
  const ok = await br.removeBridge('mqtt://b:1883')
  assert.equal(ok, false)
  assert.equal(calls.length, 1)
})

test('removeBridge reports failure on a network error', async () => {
  fakeFetch({ 'POST http://receiver.local/$mqtt/remove': { throws: true } })
  const ok = await br.removeBridge('mqtt://b:1883')
  assert.equal(ok, false)
})

test('removeBridge reports "stuck" when a 204 leaves the bridge in the reloaded list', async () => {
  fakeFetch({
    'POST http://receiver.local/$mqtt/remove': { ok: true },
    'GET http://receiver.local/$mqtt': { ok: true, body: [{ url: 'mqtt://b:1883', connected: true }] },
  })
  const ok = await br.removeBridge('mqtt://b:1883')
  assert.equal(ok, 'stuck')
  assert.deepEqual(br.bridges.value, [{ url: 'mqtt://b:1883', connected: true }])
})
