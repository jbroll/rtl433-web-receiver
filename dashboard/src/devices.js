import { sources } from './sources.js'

export const devices = new Map()

function trim() {
  const cap = DEVICE_MAX * sources().length
  if (devices.size <= cap) return
  const stale = [...devices.values()].sort((a, b) => b.seenAt - a.seenAt).slice(cap)
  for (const d of stale) devices.delete(d.key)
}

export function upsert(rec) {
  devices.set(rec.key, rec)
  trim()
}

export function clearSource(base) {
  for (const key of [...devices.keys()]) {
    if (key.startsWith(`${base} `)) devices.delete(key)
  }
}
