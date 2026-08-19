globalThis.DEVICE_MAX = 24

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { devices } from '../src/devices.js'
import { cardHidden, loadCardState, setHideNewCards } from '../src/store.js'
import { loadSettings, setLocation } from '../src/settings.js'
import { loadFeedCache, cacheGet, cacheSet } from '../src/feeds/cache.js'
import { registerFeed, resetFeeds, feedState, pump, primeFeeds, feedKey, Unsupported } from '../src/feeds/feed.js'

function fakeStorage() {
  const map = new Map()
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  }
  return map
}

// setLocation POSTs the offset to location.origin; the node tests have neither
// global, so stand in for the browser.
globalThis.location = { origin: 'http://receiver.test' }
globalThis.fetch = async () => ({})

const settle = () => new Promise(done => setImmediate(done))

// Bring a feed's next run forward to now without disturbing its failure count.
function expire(id) {
  const next = new Map(feedState.value)
  next.set(id, { ...next.get(id), nextAt: 0 })
  feedState.value = next
}

let ran
function fakeFeed(over = {}) {
  return {
    id: 'test', topic: 'Test', interval: 60000, stamped: false,
    run: async () => { ran++; return { fields: { value: 1 } } },
    ...over,
  }
}

const KEY = feedKey({ topic: 'Test' })

beforeEach(() => {
  fakeStorage()
  devices.value = new Map()
  ran = 0
  resetFeeds()
  loadSettings()
  loadCardState()
  loadFeedCache()
  setHideNewCards(true)
})

function atBoulder() { setLocation({ lat: 40.015, lon: -105.2705 }); primeFeeds() }

test('nothing runs until a location is set', async () => {
  registerFeed(fakeFeed())
  pump(1000)
  await settle()
  assert.equal(ran, 0)

  atBoulder()
  pump(2000)
  await settle()
  assert.equal(ran, 1)
})

test('a successful run publishes a card that is not hidden', async () => {
  atBoulder()
  registerFeed(fakeFeed())
  pump(1000)
  await settle()

  assert.ok(devices.value.has(KEY))
  assert.deepEqual(devices.value.get(KEY).merged.value, { value: 1 })
  assert.equal(cardHidden(KEY), false)
})

test('a computed feed reports no arrival time', async () => {
  atBoulder()
  registerFeed(fakeFeed({ stamped: false }))
  pump(1000)
  await settle()
  assert.equal(devices.value.get(KEY).seenAt.value, 0)
})

test('a fetching feed stamps when its data came from', async () => {
  atBoulder()
  registerFeed(fakeFeed({ stamped: true, run: async () => ({ fields: { value: 1 }, at: 12345 }) }))
  pump(1000)
  await settle()
  assert.equal(devices.value.get(KEY).seenAt.value, 12345)
})

test('a feed does not run again inside its interval', async () => {
  atBoulder()
  registerFeed(fakeFeed({ interval: 60000 }))
  pump(Date.now())
  await settle()
  assert.equal(ran, 1)

  pump(Date.now())
  await settle()
  assert.equal(ran, 1, 'ran again before its interval elapsed')
})

test('a slow run is never started twice', async () => {
  atBoulder()
  let release
  registerFeed(fakeFeed({
    run: () => { ran++; return new Promise(r => { release = () => r({ fields: { value: 1 } }) }) },
  }))
  pump(1000)
  pump(2000)
  pump(3000)
  await settle()
  assert.equal(ran, 1)
  release()
  await settle()
})

test('a failure keeps the last good values and adds the error', async () => {
  atBoulder()
  let fail = false
  registerFeed(fakeFeed({
    run: async () => { if (fail) throw new Error('boom'); return { fields: { value: 7 } } },
  }))
  pump(1000)
  await settle()

  fail = true
  expire('test')
  pump(Date.now())
  await settle()

  const merged = devices.value.get(KEY).merged.value
  assert.equal(merged.value, 7, 'the last good value was dropped')
  assert.equal(merged.feed_error, 'boom')
  assert.equal(feedState.value.get('test').status, 'error')
})

test('repeated failures climb the backoff ladder and stop at six hours', async () => {
  atBoulder()
  registerFeed(fakeFeed({ run: async () => { ran++; throw new Error('down') } }))

  const waits = []
  for (let i = 0; i < 7; i++) {
    const now = Date.now()
    expire('test')
    pump(now)
    await settle()
    waits.push(Math.round((feedState.value.get('test').nextAt - now) / 60000))
  }

  assert.equal(ran, 7)
  const floors = [30, 60, 120, 240, 360, 360, 360]
  waits.forEach((w, i) => {
    assert.ok(w >= floors[i] * 0.9 && w <= floors[i] * 1.1,
      `retry ${i + 1} waited ${w}m, expected about ${floors[i]}m`)
  })
})

test('an unsupported location stops the feed instead of retrying', async () => {
  atBoulder()
  registerFeed(fakeFeed({ run: async () => { ran++; throw new Unsupported('no data here') } }))

  pump(Date.now())
  await settle()
  assert.equal(feedState.value.get('test').status, 'unsupported')

  pump(Date.now() + 100 * 3600000)
  await settle()
  assert.equal(ran, 1, 'a terminal failure was retried')
  assert.equal(devices.value.get(KEY).merged.value.note.brief, 'no data here')
})

test('a cached result paints on load without refetching', async () => {
  atBoulder()
  cacheSet('test', { at: Date.now(), fields: { value: 42 }, meta: null, place: '40.015,-105.2705' })
  registerFeed(fakeFeed({ cached: true }))

  primeFeeds()
  assert.deepEqual(devices.value.get(KEY).merged.value, { value: 42 })

  pump(Date.now())
  await settle()
  assert.equal(ran, 0, 'refetched despite a fresh cache entry')
})

test('a cached result older than the interval is repainted then refreshed', async () => {
  atBoulder()
  const stale = Date.now() - 10 * 60000
  cacheSet('test', { at: stale, fields: { value: 42 }, meta: null, place: '40.015,-105.2705' })
  registerFeed(fakeFeed({ interval: 60000, cached: true }))

  primeFeeds()
  assert.deepEqual(devices.value.get(KEY).merged.value, { value: 42 })

  pump(Date.now())
  await settle()
  assert.equal(ran, 1)
  assert.deepEqual(devices.value.get(KEY).merged.value, { value: 1 })
})

test('a cache entry from another place is ignored on load', async () => {
  atBoulder()
  cacheSet('test', { at: Date.now(), fields: { value: 42 }, meta: null, place: '51.5,-0.1' })
  registerFeed(fakeFeed({ cached: true }))

  primeFeeds()
  assert.equal(devices.value.has(KEY), false)

  pump(Date.now())
  await settle()
  assert.equal(ran, 1)
})

test('moving the location discards the cache and reruns', async () => {
  atBoulder()
  registerFeed(fakeFeed({ cached: true }))
  pump(Date.now())
  await settle()
  assert.equal(ran, 1)
  assert.ok(cacheGet('test'))

  setLocation({ lat: 51.5, lon: -0.1 })
  pump(Date.now())
  await settle()
  assert.equal(ran, 2, 'did not rerun after the location moved')
  assert.equal(cacheGet('test').place, '51.5,-0.1')
})

test('the meta a feed returns comes back only at the same place', async () => {
  atBoulder()
  const seenMeta = []
  registerFeed(fakeFeed({
    cached: true,
    run: async (ctx) => { seenMeta.push(ctx.meta); return { fields: { value: 1 }, meta: { grid: 'BOU' } } },
  }))
  pump(Date.now())
  await settle()

  expire('test')
  pump(Date.now())
  await settle()
  assert.deepEqual(seenMeta, [null, { grid: 'BOU' }])

  setLocation({ lat: 51.5, lon: -0.1 })
  pump(Date.now())
  await settle()
  assert.deepEqual(seenMeta[2], null, 'meta from another place was reused')
})

test('data older than the interval does not make the feed look overdue', async () => {
  atBoulder()
  // A station that reports hourly stamps data well older than a 15 minute
  // refresh. That must not schedule a fetch on every pass.
  const hourOld = Date.now() - 3600000
  registerFeed(fakeFeed({ interval: 900000, stamped: true, run: async () => { ran++; return { fields: { value: 1 }, at: hourOld } } }))

  pump(Date.now())
  await settle()
  assert.equal(ran, 1)
  assert.equal(devices.value.get(KEY).seenAt.value, hourOld, 'the card lost the data time')

  pump(Date.now())
  await settle()
  assert.equal(ran, 1, 'refetched because the data was older than the interval')
})

test('a reload with stale-stamped data in cache still does not refetch', async () => {
  atBoulder()
  const hourOld = Date.now() - 3600000
  cacheSet('test', { at: hourOld, ranAt: Date.now(), fields: { value: 1 }, meta: null, place: '40.015,-105.2705' })
  registerFeed(fakeFeed({ interval: 900000, stamped: true, cached: true }))

  primeFeeds()
  pump(Date.now())
  await settle()
  assert.equal(ran, 0)
})

// A cached entry outlives the code that wrote it, so a feed that recomputes for
// free should not have one at all. This is what put "undefined" on the moon
// card after a field was added to its rich value.
test('a feed that does not ask to be cached never writes one', async () => {
  atBoulder()
  registerFeed(fakeFeed())
  pump(Date.now())
  await settle()

  assert.equal(ran, 1)
  assert.equal(cacheGet('test'), null)
})

test('an uncached feed is not painted from a cache entry left behind', async () => {
  atBoulder()
  cacheSet('test', { at: Date.now(), ranAt: Date.now(), fields: { value: 42 }, meta: null, place: '40.015,-105.2705' })
  registerFeed(fakeFeed())

  primeFeeds()
  assert.equal(devices.value.has(KEY), false, 'a stale entry was painted')

  pump(Date.now())
  await settle()
  assert.deepEqual(devices.value.get(KEY).merged.value, { value: 1 })
})
