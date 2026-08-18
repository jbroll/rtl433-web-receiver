import { signal } from '@preact/signals'
import { upsert, devices } from '../devices.js'
import { makeKey, FEED_BASE } from '../alias.js'
import { ensureCard, saveCardState } from '../store.js'
import { settings, hasLocation, activeZone } from '../settings.js'
import { loadFeedCache, cacheGet, cacheSet, cacheClear } from './cache.js'

// Retry ladder for a feed whose fetch failed, in minutes. A feed that reports
// its data will never exist for this location stops instead of climbing it.
const BACKOFF = [30, 60, 120, 240, 360].map(m => m * 60000)

const FEEDS = []
const running = new Set()
let place = ''

export const feedState = signal(new Map())

export function registerFeed(feed) { FEEDS.push(feed) }

export function feedKey(feed) { return makeKey(FEED_BASE, `feed/${feed.topic}`) }

// Thrown by a feed whose failure is permanent for this location, such as a
// point outside the area a provider covers. Retrying it would never succeed.
export class Unsupported extends Error {}

const IDLE = { status: 'idle', at: 0, err: '', nextAt: 0, fails: 0 }

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
  const l = settings.value.location
  return hasLocation() ? `${l.lat},${l.lon}` : ''
}

function publish(feed, fields, at) {
  const key = feedKey(feed)
  upsert({
    key, merged: fields, obj: null, raw: '',
    rssi: undefined, count: undefined, flashUntil: 0,
    // A computed feed is never stale, so it reports no age. Only a feed that
    // fetched something stamps the time its data came from.
    seenAt: feed.stamped ? at : 0,
  })
  ensureCard(key, fields, { autoShow: true })
  saveCardState()
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
  try {
    const cached = cacheGet(feed.id)
    const out = await feed.run({ ...ctx, meta: cached && cached.place === ctx.place ? cached.meta : null })
    const at = out.at || Date.now()
    publish(feed, out.fields, at)
    cacheSet(feed.id, { at, fields: out.fields, meta: out.meta || null, place: ctx.place })
    setState(feed.id, { status: 'ok', at, err: '', fails: 0, nextAt: Date.now() + feed.interval })
  } catch (e) {
    const message = (e && e.message) || 'failed'
    if (e instanceof Unsupported) {
      setState(feed.id, { status: 'unsupported', err: message, nextAt: Infinity })
      publish(feed, { note: { $r: 'text', label: feed.topic, brief: message, text: message } }, 0)
    } else {
      const fails = stateOf(feed.id).fails + 1
      const wait = BACKOFF[Math.min(fails, BACKOFF.length) - 1]
      // Jitter so several feeds failing on one outage do not retry in lockstep.
      const jittered = Math.round(wait * (0.9 + 0.2 * ((fails * 2654435761) % 1000) / 1000))
      setState(feed.id, { status: 'error', err: message, fails, nextAt: Date.now() + jittered })
      publishError(feed, message)
    }
  } finally {
    running.delete(feed.id)
  }
}

export function pump(now = Date.now()) {
  if (!hasLocation()) return

  const next = placeOf()
  if (next !== place) {
    // A new place invalidates everything: grid mappings, station ids, sun
    // times. Nothing carries over.
    place = next
    cacheClear()
    feedState.value = new Map()
  }

  const l = settings.value.location
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
  const now = Date.now()
  for (const feed of FEEDS) {
    const e = cacheGet(feed.id)
    if (!e || e.place !== place) continue
    publish(feed, e.fields, e.at)
    setState(feed.id, { status: 'ok', at: e.at, nextAt: e.at + feed.interval })
  }
}

export function resetFeeds() {
  FEEDS.length = 0
  running.clear()
  place = ''
  feedState.value = new Map()
}
