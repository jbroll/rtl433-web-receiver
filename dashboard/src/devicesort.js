import { signal } from '@preact/signals'
import { aliasOf, shortKey } from './alias.js'

export const SORT_KEY = 'rtl433.devicesort.v1'

export function deviceName(r) {
  const obj = r.obj.value
  return obj && obj.model ? obj.model : shortKey(r.key)
}

function deviceId(r) {
  const o = r.obj.value
  if (!o) return undefined
  if (o.id !== undefined) return o.id
  if (o.channel !== undefined) return 'ch' + o.channel
  return undefined
}

const KEYS = {
  name: (r) => deviceName(r).toLowerCase(),
  id: deviceId,
  rssi: (r) => r.rssi.value,
  count: (r) => r.count.value,
  age: (r) => -r.seenAt.value,
  alias: (r) => aliasOf(r.key).toLowerCase(),
}

export function sortable(by) {
  return Object.prototype.hasOwnProperty.call(KEYS, by)
}

export const sort = signal({ by: 'name', dir: 1 })
let storageBroken = false

export function current() {
  return { by: sort.value.by, dir: sort.value.dir }
}

export function loadSort() {
  sort.value = { by: 'name', dir: 1 }
  let stored
  try { stored = localStorage.getItem(SORT_KEY) } catch (e) { storageBroken = true; return }
  if (!stored) return
  let parsed
  try { parsed = JSON.parse(stored) } catch (e) { return }
  if (!parsed || typeof parsed !== 'object') return
  if (!sortable(parsed.by)) return
  sort.value = { by: parsed.by, dir: parsed.dir === -1 ? -1 : 1 }
}

function save() {
  if (storageBroken) return
  try { localStorage.setItem(SORT_KEY, JSON.stringify(sort.value)) }
  catch (e) { storageBroken = true }
}

export function sortBy(by) {
  if (!sortable(by)) return false
  sort.value = { by, dir: by === sort.value.by ? -sort.value.dir : 1 }
  save()
  return true
}

const collator = new Intl.Collator(undefined, { numeric: true })

function compare(a, b, dir) {
  if (a === undefined || a === '') return b === undefined || b === '' ? 0 : 1
  if (b === undefined || b === '') return -1
  if (typeof a === 'number' && typeof b === 'number') return (a - b) * dir
  return collator.compare(String(a), String(b)) * dir
}

export function sortDevices(list) {
  const key = KEYS[sort.value.by]
  const dir = sort.value.dir
  const decorated = [...list].map(r => ({ r, k: key(r), n: deviceName(r).toLowerCase() }))
  decorated.sort((x, y) => compare(x.k, y.k, dir) || compare(x.n, y.n, 1))
  return decorated.map(d => d.r)
}
