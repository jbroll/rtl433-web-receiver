export const devices = new Map()

function trim() {
  if (devices.size <= DEVICE_MAX) return
  const stale = [...devices.values()].sort((a, b) => b.seenAt - a.seenAt).slice(DEVICE_MAX)
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
