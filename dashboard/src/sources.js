import { requestRender } from './render.js'

export const SOURCES_KEY = 'rtl433.sources.v1'

let list = []
let storageBroken = false

// WHATWG URL parsing drops a port that matches its scheme's default (":80" on
// http, ":443" on https), so url.origin alone would turn "http://c.d:80" into
// "http://c.d" and collide it with the plain form. Recover the explicit port
// from the raw text before it is lost.
const DEFAULT_PORT = { 'http:': '80', 'https:': '443' }

export function normalizeBase(raw) {
  const trimmed = String(raw).trim()
  let url
  try { url = new URL(trimmed) } catch (e) { return null }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const authority = trimmed.replace(/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//, '').replace(/[/?#].*$/, '')
  const explicitPort = authority.match(/:(\d+)$/)
  const port = url.port || (explicitPort && explicitPort[1] === DEFAULT_PORT[url.protocol] ? explicitPort[1] : '')
  const host = url.hostname + (port ? ':' + port : '')
  const path = url.pathname.replace(/\/+$/, '')
  return url.protocol + '//' + host + path
}

export function loadSources() {
  list = []
  let stored
  try { stored = localStorage.getItem(SOURCES_KEY) } catch (e) { storageBroken = true; return }
  if (!stored) return
  let parsed
  try { parsed = JSON.parse(stored) } catch (e) { return }
  if (!Array.isArray(parsed)) return
  for (const entry of parsed) {
    const base = normalizeBase(entry)
    if (base && list.indexOf(base) < 0) list.push(base)
  }
}

function save() {
  if (storageBroken) return
  try { localStorage.setItem(SOURCES_KEY, JSON.stringify(list)) }
  catch (e) { storageBroken = true }
}

export function configured() { return list.slice() }

// Never empty: with nothing configured the page reads the origin it was served
// from, which is what makes the firmware-served build work with no setup.
export function sources() { return list.length ? list.slice() : [location.origin] }

export function addSource(raw) {
  const base = normalizeBase(raw)
  if (!base || list.indexOf(base) >= 0) return false
  list.push(base)
  save()
  requestRender()
  return true
}

export function removeSource(base) {
  const at = list.indexOf(base)
  if (at < 0) return false
  list.splice(at, 1)
  save()
  requestRender()
  return true
}
