import { signal } from '@preact/signals'
import { sources } from './sources.js'
import { isFeed } from './alias.js'

export const devices = signal(new Map())

// Single-owner slot, not a list: main.jsx is the only registrant in the app,
// and a second one would silently replace the first rather than add a
// listener. Tests that install their own hook must reset it in beforeEach.
let onEvict = () => {}
export function setEvictHook(fn) { onEvict = fn }

function trim() {
  const cap = DEVICE_MAX * sources.value.length
  // Feed records are app-generated and bounded, and they are exempt from the
  // cap: it scales with configured sources, so it is zero until one is added.
  const radio = [...devices.value.values()].filter(d => !isFeed(d.key))
  if (radio.length <= cap) return
  const stale = radio.sort((a, b) => b.seenAt.value - a.seenAt.value).slice(cap)
  const next = new Map(devices.value)
  for (const d of stale) { next.delete(d.key); onEvict(d.key) }
  devices.value = next
}

export function upsert(rec) {
  const existing = devices.value.get(rec.key)
  if (existing) {
    existing.rssi.value = rec.rssi
    existing.count.value = rec.count
    existing.seenAt.value = rec.seenAt
    existing.obj.value = rec.obj
    existing.merged.value = rec.merged
  } else {
    const next = new Map(devices.value)
    next.set(rec.key, {
      key: rec.key,
      rssi: signal(rec.rssi),
      count: signal(rec.count),
      seenAt: signal(rec.seenAt),
      flashing: signal(false),
      obj: signal(rec.obj),
      merged: signal(rec.merged),
    })
    devices.value = next
    trim()
  }
}

export function clearSource(base) {
  const next = new Map(devices.value)
  for (const key of next.keys()) {
    if (!isFeed(key) && key.startsWith(`${base} `)) { next.delete(key); onEvict(key) }
  }
  devices.value = next
}
