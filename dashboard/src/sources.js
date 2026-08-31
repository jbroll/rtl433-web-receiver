import { signal } from '@preact/signals'

export const SOURCES_KEY = 'rtl433.sources.v1'

export const sources = signal([])
export const sourceState = signal(new Map())

let storageBroken = false
let stored = 'absent'
let onChange = () => {}

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
    (a === 192 && b === 168) || (a === 169 && b === 254)
}

function isPrivateIPv6(host) {
  // host is bracketed, e.g. "[fc00::1]" or "[::ffff:192.168.1.5]"
  const h = host.slice(1, -1).toLowerCase()
  if (h === '::1') return true
  if (h.startsWith('fe80:')) return true // link-local, fe80::/10
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true // unique local, fc00::/7
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h)
  if (mapped) return isPrivateIPv4(mapped[1])
  return false
}

// Known local-network conventions: mDNS (.local, RFC 6762), the reserved
// home-router special-use domain (.home.arpa, RFC 8375), and the common but
// unofficial ".lan" suffix routers use. A bare single-label hostname (no
// dot) is also local -- Android/iOS both treat it that way, since a name
// with no dot can only resolve via a local search domain, never public DNS.
const LOCAL_SUFFIXES = ['.local', '.home.arpa', '.lan']

export function isLocalHost(host) {
  if (!host) return false
  const h = host.toLowerCase()
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

export function addSource(raw) {
  const base = normalizeBase(raw)
  if (!base || sources.value.indexOf(base) >= 0) return false
  if (!isLocalHost(new URL(base).hostname)) return false
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
