import { aliasOf, shortKey } from './alias.js'

export const SORT_KEY = 'rtl433.devicesort.v1'

export function deviceName(r) {
  return r.obj && r.obj.model ? r.obj.model : shortKey(r.key)
}

function deviceId(r) {
  const o = r.obj
  if (!o) return undefined
  if (o.id !== undefined) return o.id
  if (o.channel !== undefined) return 'ch' + o.channel
  return undefined
}

// Ascending age means most recently heard first, so the key is negated: a
// larger seenAt is a smaller age.
const KEYS = {
  name: (r) => deviceName(r).toLowerCase(),
  id: deviceId,
  rssi: (r) => r.rssi,
  count: (r) => r.count,
  age: (r) => -r.seenAt,
  alias: (r) => aliasOf(r.key).toLowerCase(),
}

export function sortable(by) {
  return Object.prototype.hasOwnProperty.call(KEYS, by)
}

let sort = { by: 'name', dir: 1 }
let storageBroken = false

export function current() {
  return { by: sort.by, dir: sort.dir }
}

export function loadSort() {
  sort = { by: 'name', dir: 1 }
  let stored
  try { stored = localStorage.getItem(SORT_KEY) } catch (e) { storageBroken = true; return }
  if (!stored) return
  let parsed
  try { parsed = JSON.parse(stored) } catch (e) { return }
  if (!parsed || typeof parsed !== 'object') return
  if (!sortable(parsed.by)) return
  sort = { by: parsed.by, dir: parsed.dir === -1 ? -1 : 1 }
}

function save() {
  if (storageBroken) return
  try { localStorage.setItem(SORT_KEY, JSON.stringify(sort)) }
  catch (e) { storageBroken = true }
}

// Clicking the column already sorted reverses it; any other column starts
// ascending, which reads as A-Z, smallest first, and freshest first for age.
export function sortBy(by) {
  if (!sortable(by)) return false
  sort = { by, dir: by === sort.by ? -sort.dir : 1 }
  save()
  return true
}

// A device missing the field sorts last whichever way the column points, so
// reversing never buries the rows that do have a value.
function compare(a, b, dir) {
  if (a === undefined || a === '') return b === undefined || b === '' ? 0 : 1
  if (b === undefined || b === '') return -1
  if (typeof a === 'number' && typeof b === 'number') return (a - b) * dir
  return String(a).localeCompare(String(b), undefined, { numeric: true }) * dir
}

export function sortDevices(list) {
  const key = KEYS[sort.by]
  const dir = sort.dir
  // Ties settle on the name so a re-render cannot reorder equal rows.
  return [...list].sort((x, y) =>
    compare(key(x), key(y), dir) ||
    compare(deviceName(x).toLowerCase(), deviceName(y).toLowerCase(), 1))
}
