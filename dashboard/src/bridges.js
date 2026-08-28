import { signal } from '@preact/signals'

// null = not yet loaded, or /$mqtt isn't served here (e.g. the standalone
// bridge). [] = loaded and there are none configured. Never mixed with
// localStorage: this mirrors the receiver's own table, there's nothing to
// cache client-side.
export const bridges = signal(null)

// A newer loadBridges() call can have its fetch settle before an older one's,
// so a stale response arriving last would otherwise clobber the fresh one.
let seq = 0

export async function loadBridges() {
  const id = ++seq
  try {
    const res = await fetch(`${location.origin}/$mqtt`)
    if (!res.ok) { if (id === seq) bridges.value = null; return }
    const list = await res.json()
    if (id === seq) bridges.value = Array.isArray(list) ? list : null
  } catch (e) {
    if (id === seq) bridges.value = null
  }
}

export async function addBridge(url, token) {
  try {
    const res = await fetch(`${location.origin}/$mqtt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, token: token || '' }),
    })
    if (!res.ok) return false
  } catch (e) {
    return false
  }
  await loadBridges()
  return true
}

// /$mqtt/remove answers 404 when it removed nothing (including a rare
// NVS-persist failure after rollback, where the bridge is still live) and
// 204 when it removed something -- callers must not read a 404 as proof.
export async function removeBridge(url) {
  try {
    const res = await fetch(`${location.origin}/$mqtt/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    })
    if (!res.ok) return false
  } catch (e) {
    return false
  }
  await loadBridges()
  return true
}
