import { el } from './units.js'

export const SOURCES_KEY = 'rtl433.sources.v1'

let list = []
let storageBroken = false
let stored = 'absent' // 'absent' | 'empty' | 'populated'
let onChange = () => {}

export function setSourcesChanged(fn) { onChange = fn }

// What loadSources() found in storage. Startup uses it to decide between
// probing the serving origin (absent) and landing on Sources (empty).
export function storageState() { return stored }

export function normalizeBase(raw) {
  let url
  try { url = new URL(String(raw).trim()) } catch (e) { return null }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  // A query, fragment, or credentials would be silently dropped from the
  // returned string, losing information (and collapsing distinct sources
  // into one key) instead of surfacing the problem to the caller.
  if (url.search || url.hash || url.username || url.password) return null
  const path = url.pathname.replace(/\/+$/, '')
  return url.origin + path
}

export function loadSources() {
  list = []
  storageBroken = false
  stored = 'absent'
  let raw
  try { raw = localStorage.getItem(SOURCES_KEY) } catch (e) { storageBroken = true; return }
  if (raw === null) return
  stored = 'empty'
  let parsed
  try { parsed = JSON.parse(raw) } catch (e) { return }
  if (!Array.isArray(parsed)) return
  for (const entry of parsed) {
    const base = normalizeBase(entry)
    if (base && list.indexOf(base) < 0) list.push(base)
  }
  if (list.length) stored = 'populated'
}

function save() {
  if (storageBroken) return
  try { localStorage.setItem(SOURCES_KEY, JSON.stringify(list)) }
  catch (e) { storageBroken = true }
}

export function configured() { return list.slice() }

// May be empty: the stored list is the only source of truth. A serving origin
// joins it only through the startup probe's explicit adoption.
export function sources() { return list.slice() }

export function addSource(raw) {
  const base = normalizeBase(raw)
  if (!base || list.indexOf(base) >= 0) return false
  list.push(base)
  save()
  onChange()
  return true
}

export function removeSource(base) {
  const at = list.indexOf(base)
  if (at < 0) return false
  list.splice(at, 1)
  save()
  onChange()
  return true
}

let states = new Map()

export function renderSourcePanel(next) {
  if (next) states = next
  const ul = document.getElementById('source-list')
  if (!ul) return
  ul.replaceChildren(...list.map((base) => {
    const li = el('li')
    const dot = el('span', 'dot')
    dot.dataset.state = states.get(base) || 'connecting'
    const rm = el('button', 'rm', '✕')
    rm.title = `Remove ${base}`
    rm.onclick = () => { removeSource(base); renderSourcePanel() }
    li.append(dot, el('span', 'url', base), rm)
    return li
  }))
}

export function installSourcePanel() {
  const form = document.getElementById('source-form')
  const input = document.getElementById('source-url')
  input.oninput = () => input.removeAttribute('aria-invalid')
  form.onsubmit = (ev) => {
    ev.preventDefault()
    if (!addSource(input.value)) {
      input.setAttribute('aria-invalid', 'true')
      return
    }
    input.removeAttribute('aria-invalid')
    input.value = ''
    renderSourcePanel()
  }
  renderSourcePanel()
}
