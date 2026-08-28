import { signal } from '@preact/signals'
import { upsert, devices } from '../devices.js'
import { makeKey, FEED_BASE } from '../alias.js'
import { ensureCard, saveCardState } from '../store.js'
import { hasLocation, resolvedLocation, activeZone } from '../settings.js'
import { loadFeedCache, cacheGet, cacheSet, cacheClear } from './cache.js'

// Retry ladder for a feed whose fetch failed, in minutes. A feed that reports
// its data will never exist for this location stops instead of climbing it.
const BACKOFF = [30, 60, 120, 240, 360].map(m => m * 60000)

const FEEDS = []
const running = new Set()
const inFlight = new Map()
let place = ''

export const feedState = signal(new Map())

export function registerFeed(feed) { FEEDS.push(feed) }

export function feedKey(feed) { return makeKey(FEED_BASE, `feed/${feed.topic}`) }

// Thrown by a feed whose failure is permanent for this location, such as a
// point outside the area a provider covers. Retrying it would never succeed.
export class Unsupported extends Error {}

const IDLE = { status: 'idle', at: 0, ranAt: 0, err: '', nextAt: 0, fails: 0 }

// A plain char-code sum is order-blind: anagrams collide outright, and it
// barely spreads over 1000 buckets. DJB2's per-character multiply fixes both.
export function stringHash(s) {
  let h = 5381
  for (const c of s) h = (h * 33 + c.charCodeAt(0)) >>> 0
  return h
}

// Merged over the defaults rather than returned as stored: a partial entry
// would otherwise feed an undefined straight into the backoff index.
function stateOf(id) {
  return { ...IDLE, ...feedState.value.get(id) }
}

function setState(id, patch) {
  const next = new Map(feedState.value)
  next.set(id, { ...stateOf(id), ...patch })
  feedState.value = next
}

function placeOf() {
  const l = resolvedLocation()
  return hasLocation() ? `${l.lat},${l.lon}` : ''
}

function publish(feed, fields, at) {
  const key = feedKey(feed)
  upsert({
    key, merged: fields, obj: null,
    rssi: undefined, count: undefined,
    // A computed feed is never stale, so it reports no age. Only a feed that
    // fetched something stamps the time its data came from.
    seenAt: feed.stamped ? at : 0,
  })
  // Save only when the card actually changed, or every feed tick would write
  // storage and notify subscribers for nothing.
  const changed = ensureCard(key, fields, { autoShow: true, hiddenValues: feed.defaultHidden, save: false })
  if (changed) saveCardState()
}

// The last good fields stay on the card; the error joins them as a plain
// string, so it renders through the scalar path and can be hidden like any
// other value.
function publishError(feed, message) {
  const rec = devices.value.get(feedKey(feed))
  const prev = rec ? rec.merged.value : {}
  publish(feed, { ...prev, feed_error: message }, stateOf(feed.id).at)
}

async function runFeed(feed, ctx) {
  if (running.has(feed.id)) return
  running.add(feed.id)
  const controller = new AbortController()
  inFlight.set(feed.id, controller)
  try {
    const cached = feed.cached ? cacheGet(feed.id) : null
    const out = await feed.run({
      ...ctx,
      meta: cached && cached.place === ctx.place ? cached.meta : null,
      signal: controller.signal,
    })
    // The place can move while a request is in flight; a reply for a place
    // nobody asked for any more must not reach the card, the cache, or state.
    if (ctx.place !== place) return
    // Two different times. `at` is when the data is from, which the card shows
    // as its age; `ranAt` is when we asked, which is what paces the next ask.
    // A station reporting hourly would otherwise look overdue on every pass.
    const at = out.at || Date.now()
    const ranAt = Date.now()
    publish(feed, out.fields, at)
    if (feed.cached) cacheSet(feed.id, { at, ranAt, fields: out.fields, meta: out.meta || null, place: ctx.place })
    setState(feed.id, { status: 'ok', at, ranAt, err: '', fails: 0, nextAt: ranAt + feed.interval })
  } catch (e) {
    if (ctx.place !== place) return
    const message = (e && e.message) || 'failed'
    if (e instanceof Unsupported) {
      setState(feed.id, { status: 'unsupported', err: message, nextAt: Infinity })
      publish(feed, { note: { $r: 'text', label: feed.topic, brief: message, text: message } }, 0)
    } else {
      const fails = stateOf(feed.id).fails + 1
      const wait = BACKOFF[Math.min(fails, BACKOFF.length) - 1]
      // Jitter so several feeds failing on one outage do not retry in lockstep.
      // The feed id folds in too, or every feed at the same fail count would
      // still jitter to the same offset.
      const jittered = Math.round(wait * (0.9 + 0.2 * ((fails * 2654435761 + stringHash(feed.id)) % 1000) / 1000))
      // A provider naming its own retry window overrides the ladder's guess.
      const delay = Math.max(e && e.retryAfter || 0, jittered)
      setState(feed.id, { status: 'error', err: message, fails, nextAt: Date.now() + delay })
      publishError(feed, message)
    }
  } finally {
    running.delete(feed.id)
    inFlight.delete(feed.id)
  }
}

export function pump(now = Date.now()) {
  const l = resolvedLocation()
  if (l.lat === null || l.lon === null) return

  const next = `${l.lat},${l.lon}`
  // A new place invalidates everything: grid mappings, station ids, sun
  // times. Nothing carries over. An empty previous place is priming still
  // waiting on its first frame, not a real place to invalidate away from.
  if (next !== place && place !== '') {
    // A reply for the old place is already discarded on arrival; abort the
    // request too so it does not keep running for nothing.
    for (const c of inFlight.values()) c.abort()
    inFlight.clear()
    cacheClear()
    feedState.value = new Map()
  }
  place = next

  const ctx = { lat: l.lat, lon: l.lon, zone: activeZone(), place }

  for (const feed of FEEDS) {
    const s = stateOf(feed.id)
    if (s.status === 'unsupported') continue
    if (now < s.nextAt) continue
    runFeed(feed, ctx)
  }
}

// Paint the last good result before anything runs, and treat an entry younger
// than its interval as already current so a reload does not re-fetch. Call
// this before the first pump: it is what tells pump which place the cached
// entries belong to.
export function primeFeeds() {
  loadFeedCache()
  place = placeOf()
  for (const feed of FEEDS) {
    if (!feed.cached) continue
    const e = cacheGet(feed.id)
    if (!e || e.place !== place) continue
    publish(feed, e.fields, e.at)
    setState(feed.id, { status: 'ok', at: e.at, ranAt: e.ranAt, nextAt: e.ranAt + feed.interval })
  }
}

// Brings every feed's next run forward to now. Only the tests use it: the
// alternative is waiting out a backoff ladder measured in hours.
export function expireFeeds() {
  const next = new Map()
  for (const [id, s] of feedState.value) next.set(id, { ...s, nextAt: 0 })
  feedState.value = next
}

export function resetFeeds() {
  FEEDS.length = 0
  running.clear()
  inFlight.clear()
  place = ''
  feedState.value = new Map()
}
