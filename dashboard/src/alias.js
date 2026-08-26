import { signal } from '@preact/signals'
import { tokenFor } from './auth.js'
import { showToast } from './toast.js'

export const ALIAS_SUFFIX = '/$alias'
export const ALIASES_KEY = 'rtl433.aliases.v1'
export const aliases = signal(new Map())

let storageBroken = false

export function makeKey(base, topic) { return `${base} ${topic}` }

export function sourceOf(key) { return key.slice(0, key.indexOf(' ')) }

export function topicOf(key) { return key.slice(key.indexOf(' ') + 1) }

export function shortKey(key) { return topicOf(key).split('/').slice(1).join('/') }

export function isSelf(key) { return topicOf(key).split('/')[1] === 'Receiver' }

// Feeds are app-generated cards, not radio devices. normalizeBase only ever
// yields an http(s) URL, so this base cannot collide with a real source.
export const FEED_BASE = 'local'

export function isFeed(key) { return sourceOf(key) === FEED_BASE }

export function aliasOf(key) { return aliases.value.get(key) || '' }

export function displayName(key) { return aliasOf(key) || shortKey(key) }

function saveAliases() {
  if (storageBroken) return
  try {
    localStorage.setItem(ALIASES_KEY, JSON.stringify(Object.fromEntries(aliases.value)))
  } catch (e) { storageBroken = true }
}

export function loadAliases() {
  aliases.value = new Map()
  storageBroken = false
  let raw
  try { raw = localStorage.getItem(ALIASES_KEY) } catch (e) { storageBroken = true; return }
  if (!raw) return
  let parsed
  try { parsed = JSON.parse(raw) } catch (e) { return }
  if (!parsed || typeof parsed !== 'object') return
  const next = new Map()
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === 'string' && v !== '') next.set(k, v)
  }
  aliases.value = next
}

export function applyAliasFrame(key, payload) {
  const device = key.slice(0, -ALIAS_SUFFIX.length)
  const next = new Map(aliases.value)
  if (typeof payload === 'string' && payload !== '') next.set(device, payload)
  else next.delete(device)
  aliases.value = next
  saveAliases()
}

export function postAlias(key, name) {
  const trimmed = String(name).trim()
  const next = new Map(aliases.value)
  if (trimmed) next.set(key, trimmed)
  else next.delete(key)
  aliases.value = next
  saveAliases()
  const origin = sourceOf(key)
  if (origin !== location.origin) return
  const url = `${origin}/${topicOf(key)}${ALIAS_SUFFIX}`
  const token = tokenFor(origin)
  const auth = token ? { Authorization: `Bearer ${token}` } : {}
  // A zero-length body is the bridge's retained-delete primitive; a cleared
  // alias posts one instead of the JSON string "".
  const options = trimmed
    ? { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth }, body: JSON.stringify(trimmed) }
    : { method: 'POST', headers: auth }
  fetch(url, options).then(res => {
    if (res.status === 401) {
      showToast('Rename rejected: the bridge needs an access token. Set it in Settings.')
      return
    }
    if (!res.ok) {
      console.error(`POST ${url} failed: ${res.status}`)
    }
  }).catch(err => {
    console.error(`POST ${url} failed: ${err.message || err}`)
  })
}
