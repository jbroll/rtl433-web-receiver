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

// Legacy UI helpers; removed when sources.jsx lands.
export function renderSourcePanel(next) {
  if (next) sourceState.value = next
  const ul = document.getElementById('source-list')
  if (!ul) return
  const li = (base) => {
    const dot = document.createElement('span')
    dot.className = 'dot'
    dot.dataset.state = sourceState.value.get(base) || 'connecting'
    const rm = document.createElement('button')
    rm.className = 'rm'
    rm.textContent = '✕'
    rm.title = `Remove ${base}`
    rm.onclick = () => { removeSource(base); renderSourcePanel() }
    const url = document.createElement('span')
    url.className = 'url'
    url.textContent = base
    const item = document.createElement('li')
    item.append(dot, url, rm)
    return item
  }
  ul.replaceChildren(...sources.value.map(li))
}

export function installSourcePanel() {
  const form = document.getElementById('source-form')
  const input = document.getElementById('source-url')
  if (!form || !input) return
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
