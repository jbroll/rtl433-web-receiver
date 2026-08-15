import { requestRender } from './render.js'

export const ALIAS_SUFFIX = '/$alias'
export const aliases = new Map()

export function makeKey(base, topic) { return `${base} ${topic}` }

export function sourceOf(key) { return key.slice(0, key.indexOf(' ')) }

export function topicOf(key) { return key.slice(key.indexOf(' ') + 1) }

export function shortKey(key) { return topicOf(key).split('/').slice(1).join('/') }

export function isSelf(key) { return topicOf(key).split('/')[1] === 'Receiver' }

export function aliasOf(key) { return aliases.get(key) || '' }

export function displayName(key) { return aliasOf(key) || shortKey(key) }

export function applyAliasFrame(key, payload) {
  const device = key.slice(0, -ALIAS_SUFFIX.length)
  if (typeof payload === 'string' && payload !== '') aliases.set(device, payload)
  else aliases.delete(device)
  requestRender()
}

// Applied locally first so the field and the card settle at once; the frame the
// source sends back confirms it.
export function postAlias(key, name) {
  const trimmed = String(name).trim()
  if (trimmed) aliases.set(key, trimmed)
  else aliases.delete(key)
  requestRender()
  fetch(`${sourceOf(key)}/${topicOf(key)}${ALIAS_SUFFIX}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(trimmed),
  }).catch(() => {})
}
