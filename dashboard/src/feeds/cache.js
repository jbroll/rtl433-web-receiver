// Last good feed results, so a reload paints immediately and an entry younger
// than its feed's interval defers the next run instead of re-fetching.

const CACHE_KEY = 'rtl433.feeds.v1'

let broken = false
let entries = Object.create(null)

export function loadFeedCache() {
  entries = Object.create(null)
  broken = false
  let raw
  try { raw = localStorage.getItem(CACHE_KEY) } catch (e) { broken = true; return }
  if (!raw) return
  let s
  try { s = JSON.parse(raw) } catch (e) { return }
  if (!s || typeof s !== 'object') return
  for (const id of Object.keys(s)) {
    const e = s[id]
    if (!e || typeof e !== 'object') continue
    if (!Number.isFinite(e.at) || !e.fields || typeof e.fields !== 'object') continue
    entries[id] = { at: e.at, ranAt: Number.isFinite(e.ranAt) ? e.ranAt : e.at,
                    fields: e.fields, meta: e.meta || null,
                    place: typeof e.place === 'string' ? e.place : '' }
  }
}

function save() {
  if (broken) return
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(entries)) }
  catch (e) { broken = true }
}

export function cacheGet(id) { return entries[id] || null }

export function cacheSet(id, entry) { entries[id] = entry; save() }

export function cacheDrop(id) { delete entries[id]; save() }

export function cacheClear() { entries = Object.create(null); save() }
