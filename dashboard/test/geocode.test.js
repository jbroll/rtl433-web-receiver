import { test, mock, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { geocode, reverseGeocode, resetGeocode, geocodeCacheSize } from '../src/geocode.js'

const BOULDER = [{ lat: '40.0149856', lon: '-105.2705456', display_name: 'Boulder, Colorado, United States' }]

let calls
function fakeFetch(body, ok = true, status = 200) {
  calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return { ok, status, json: async () => body }
  }
}

beforeEach(() => { resetGeocode() })

test('a search returns coordinates as numbers with a label', async () => {
  fakeFetch(BOULDER)
  const found = await geocode('boulder')
  assert.deepEqual(found, [{ lat: 40.0149856, lon: -105.2705456, label: 'Boulder, Colorado, United States' }])
})

test('the query is escaped into the url and asks for jsonv2', async () => {
  fakeFetch(BOULDER)
  await geocode('boulder co & 80301')
  assert.match(calls[0].url, /^https:\/\/nominatim\.openstreetmap\.org\/search\?/)
  assert.match(calls[0].url, /format=jsonv2/)
  assert.match(calls[0].url, /q=boulder%20co%20%26%2080301/)
})

test('only Accept is sent, so the request is never preflighted', async () => {
  fakeFetch(BOULDER)
  await geocode('boulder')
  assert.deepEqual(Object.keys(calls[0].init.headers), ['Accept'])
})

test('an empty query never reaches the network', async () => {
  fakeFetch(BOULDER)
  assert.deepEqual(await geocode('   '), [])
  assert.deepEqual(await geocode(null), [])
  assert.equal(calls.length, 0)
})

test('a repeated query is answered from cache, not the network', async () => {
  fakeFetch(BOULDER)
  await geocode('boulder')
  await geocode('boulder')
  assert.equal(calls.length, 1)
})

test('a result with no usable coordinate is dropped, not returned', async () => {
  fakeFetch([{ lat: 'nowhere', lon: '0' }, { display_name: 'no coords' }, ...BOULDER])
  const found = await geocode('mixed')
  assert.equal(found.length, 1)
  assert.equal(found[0].label, 'Boulder, Colorado, United States')
})

test('an http error surfaces its status and is not cached', async () => {
  fakeFetch(null, false, 429)
  await assert.rejects(() => geocode('boulder'), /429/)

  fakeFetch(BOULDER)
  assert.equal((await geocode('boulder')).length, 1)
})

test('a failed request does not wedge the queue behind it', async () => {
  fakeFetch(null, false, 500)
  await assert.rejects(() => geocode('first'))
  fakeFetch(BOULDER)
  assert.equal((await geocode('second')).length, 1)
})

test('the cache drops its oldest entry past 100 distinct queries', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  try {
    fakeFetch(BOULDER)
    for (let i = 0; i < 150; i++) {
      const found = geocode(`query ${i}`)
      mock.timers.tick(1000)
      await found
    }
    assert.equal(geocodeCacheSize(), 100)

    const before = calls.length
    const recent = geocode('query 149')
    mock.timers.tick(1000)
    await recent
    assert.equal(calls.length, before, 'a recent query should still be cached')

    const oldest = geocode('query 0')
    mock.timers.tick(1000)
    await oldest
    assert.equal(calls.length, before + 1, 'the oldest query should have been evicted')
  } finally {
    mock.timers.reset()
  }
})

test('reverse geocoding yields just the label', async () => {
  fakeFetch({ lat: '40.01', lon: '-105.27', display_name: 'Boulder, Colorado' })
  assert.equal(await reverseGeocode(40.01, -105.27), 'Boulder, Colorado')
  assert.match(calls[0].url, /\/reverse\?/)
})
