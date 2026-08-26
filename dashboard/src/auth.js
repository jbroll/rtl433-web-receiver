import { signal } from '@preact/signals'

export const TOKENS_KEY = 'rtl433.tokens.v1'
export const tokens = signal(new Map())

let storageBroken = false

function saveTokens() {
  if (storageBroken) return
  try {
    localStorage.setItem(TOKENS_KEY, JSON.stringify(Object.fromEntries(tokens.value)))
  } catch (e) { storageBroken = true }
}

export function loadTokens() {
  tokens.value = new Map()
  storageBroken = false
  let raw
  try { raw = localStorage.getItem(TOKENS_KEY) } catch (e) { storageBroken = true; return }
  if (!raw) return
  let parsed
  try { parsed = JSON.parse(raw) } catch (e) { return }
  if (!parsed || typeof parsed !== 'object') return
  const next = new Map()
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === 'string' && v !== '') next.set(k, v)
  }
  tokens.value = next
}

export function tokenFor(origin) { return tokens.value.get(origin) || '' }

export function setToken(origin, token) {
  const trimmed = String(token).trim()
  const next = new Map(tokens.value)
  if (trimmed) next.set(origin, trimmed)
  else next.delete(origin)
  tokens.value = next
  saveTokens()
}
