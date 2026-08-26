// Nominatim's usage policy caps callers at one request a second and rules out
// autocomplete, so this searches on submit only, serializes requests behind a
// one-second gap, and caches every query it has already answered. Browsers
// send Referer automatically, which is the identification the policy asks for.

const SEARCH = 'https://nominatim.openstreetmap.org/search'
const REVERSE = 'https://nominatim.openstreetmap.org/reverse'
const MIN_GAP = 1000

let last = 0
let chain = Promise.resolve()
let cache = new Map()
const CACHE_MAX = 100

export function resetGeocode() { last = 0; chain = Promise.resolve(); cache = new Map() }

export function geocodeCacheSize() { return cache.size }

function cacheSet(query, found) {
  cache.set(query, found)
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value)
}

function sleep(ms) { return new Promise(done => setTimeout(done, ms)) }

// Accept is CORS-safelisted. Any other header would force a preflight the
// endpoint does not answer.
function queue(url, parse) {
  const run = chain.then(async () => {
    const wait = MIN_GAP - (Date.now() - last)
    if (wait > 0) await sleep(wait)
    last = Date.now()
    const res = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!res.ok) throw new Error(`search failed (${res.status})`)
    return parse(await res.json())
  })
  chain = run.then(() => {}, () => {})
  return run
}

function place(r) {
  const lat = Number(r && r.lat)
  const lon = Number(r && r.lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  const label = typeof r.display_name === 'string' ? r.display_name : ''
  return { lat, lon, label }
}

export function geocode(q) {
  const query = String(q == null ? '' : q).trim()
  if (!query) return Promise.resolve([])
  if (cache.has(query)) return Promise.resolve(cache.get(query))

  const url = `${SEARCH}?format=jsonv2&limit=5&q=${encodeURIComponent(query)}`
  return queue(url, json => {
    const found = (Array.isArray(json) ? json : []).map(place).filter(Boolean)
    cacheSet(query, found)
    return found
  })
}

export function reverseGeocode(lat, lon) {
  const url = `${REVERSE}?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`
  return queue(url, json => {
    const found = place(json)
    return found ? found.label : ''
  })
}
