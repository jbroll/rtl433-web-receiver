import { requestRender } from './render.js'

export const ALIAS_SUFFIX = '/$alias'
export const ALIASES_KEY = 'rtl433.aliases.v1'
export const aliases = new Map()

let storageBroken = false

export function makeKey(base, topic) { return `${base} ${topic}` }

export function sourceOf(key) { return key.slice(0, key.indexOf(' ')) }

export function topicOf(key) { return key.slice(key.indexOf(' ') + 1) }

export function shortKey(key) { return topicOf(key).split('/').slice(1).join('/') }

export function isSelf(key) { return topicOf(key).split('/')[1] === 'Receiver' }

export function aliasOf(key) { return aliases.get(key) || '' }

export function displayName(key) { return aliasOf(key) || shortKey(key) }

function saveAliases() {
  if (storageBroken) return
  try {
    localStorage.setItem(ALIASES_KEY, JSON.stringify(Object.fromEntries(aliases)))
  } catch (e) { storageBroken = true }
}

export function loadAliases() {
  aliases.clear()
  storageBroken = false
  let raw
  try { raw = localStorage.getItem(ALIASES_KEY) } catch (e) { storageBroken = true; return }
  if (!raw) return
  let parsed
  try { parsed = JSON.parse(raw) } catch (e) { return }
  if (!parsed || typeof parsed !== 'object') return
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === 'string' && v !== '') aliases.set(k, v)
  }
}

export function applyAliasFrame(key, payload) {
  const device = key.slice(0, -ALIAS_SUFFIX.length)
  if (typeof payload === 'string' && payload !== '') aliases.set(device, payload)
  else aliases.delete(device)
  saveAliases()
  requestRender()
}

// Applied locally first so the field and the card settle at once; the frame the
// source sends back confirms it.
export function postAlias(key, name) {
  const trimmed = String(name).trim()
  if (trimmed) aliases.set(key, trimmed)
  else aliases.delete(key)
  saveAliases()
  requestRender()
  // When the dashboard is served by a receiver, the alias belongs there.
  // When it is served by a separate broker or static server, the source is
  // external and has no persistent alias store, so keep the name locally.
  if (sourceOf(key) !== location.origin) return
  const url = `${sourceOf(key)}/${topicOf(key)}${ALIAS_SUFFIX}`
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(trimmed),
  }).then(res => {
    if (!res.ok) {
      console.error(`POST ${url} failed: ${res.status}`)
    }
  }).catch(err => {
    console.error(`POST ${url} failed: ${err.message || err}`)
  })
}
