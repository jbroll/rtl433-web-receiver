import { signal } from '@preact/signals'

export const SOURCES_KEY = 'rtl433.sources.v1'

export const sources = signal([])
export const sourceState = signal(new Map())

let storageBroken = false
let stored = 'absent'
let onChange = () => {}
let nativePlatform = false

export function setNativePlatform(v) { nativePlatform = v }

export function setSourceState(base, state) {
  sourceState.value = new Map(sourceState.value).set(base, state)
}

export function setSourcesChanged(fn) { onChange = fn }

export function storageState() { return stored }

const IPV4_OCTETS = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

function isPrivateIPv4(host) {
  const m = IPV4_OCTETS.exec(host)
  if (!m) return false
  const o = m.slice(1).map(Number)
  if (o.some(n => n > 255)) return false
  const [a, b] = o
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
}

function isPrivateIPv6(host) {
  const h = host.slice(1, -1).toLowerCase()
  if (h === '::1') return true
  if (h.startsWith('fe80:')) return true // link-local, fe80::/16 in practice
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true // unique local, fc00::/7
  // WHATWG URL canonicalizes an IPv4-mapped address to hex groups, e.g.
  // "::ffff:192.168.1.5" becomes "::ffff:c0a8:105", not dotted-decimal.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h)
  if (mapped) {
    const hi = parseInt(mapped[1], 16)
    const lo = parseInt(mapped[2], 16)
    return isPrivateIPv4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`)
  }
  return false
}

// See "Local-source scoping" in architecture.md for why these suffixes and
// not others.
const LOCAL_SUFFIXES = ['.local', '.home.arpa', '.lan', '.ts.net']

export function isLocalHost(host) {
  if (!host) return false
  let h = host.toLowerCase()
  if (h.endsWith('.') && h.length > 1) h = h.slice(0, -1) // trailing-dot FQDN
  if (h.startsWith('[') && h.endsWith(']')) return isPrivateIPv6(h)
  if (isPrivateIPv4(h)) return true
  if (h === 'localhost') return true
  if (!h.includes('.')) return true
  return LOCAL_SUFFIXES.some(suffix => h === suffix.slice(1) || h.endsWith(suffix))
}

export function normalizeBase(raw) {
  let url
  try { url = new URL(String(raw).trim()) } catch (e) { return null }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.search || url.hash || url.username || url.password) return null
  const path = url.pathname.replace(/\/+$/, '')
  return url.origin + path
}

export function loadSources() {
  sources.value = []
  storageBroken = false
  stored = 'absent'
  let raw
  try { raw = localStorage.getItem(SOURCES_KEY) } catch (e) { storageBroken = true; return }
  if (raw === null) return
  stored = 'empty'
  let parsed
  try { parsed = JSON.parse(raw) } catch (e) { return }
  if (!Array.isArray(parsed)) return
  const list = []
  for (const entry of parsed) {
    const base = normalizeBase(entry)
    if (base && list.indexOf(base) < 0) list.push(base)
  }
  sources.value = list
  if (list.length) stored = 'populated'
}

function save() {
  if (storageBroken) return
  try { localStorage.setItem(SOURCES_KEY, JSON.stringify(sources.value)) }
  catch (e) { storageBroken = true }
}

export function configured() { return sources.value.slice() }

// Reason a candidate base would be refused ('invalid', 'duplicate', 'remote'),
// or null if it would be accepted. Shared by addSource and the UI, which
// needs the reason to distinguish a guard rejection from a malformed URL.
export function rejectionReason(raw) {
  const base = normalizeBase(raw)
  if (!base) return 'invalid'
  if (sources.value.indexOf(base) >= 0) return 'duplicate'
  if (nativePlatform && base !== location.origin) {
    const url = new URL(base)
    if (url.protocol === 'http:' && !isLocalHost(url.hostname)) return 'remote'
  }
  return null
}

export function addSource(raw) {
  if (rejectionReason(raw)) return false
  const base = normalizeBase(raw)
  sources.value = [...sources.value, base]
  save()
  onChange()
  return true
}

export function removeSource(base) {
  const at = sources.value.indexOf(base)
  if (at < 0) return false
  const next = sources.value.slice()
  next.splice(at, 1)
  sources.value = next
  save()
  onChange()
  return true
}
