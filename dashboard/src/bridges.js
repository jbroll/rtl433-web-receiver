import { signal } from '@preact/signals'

// null = not yet loaded, or /$mqtt isn't served here (e.g. the standalone
// bridge). [] = loaded and there are none configured. Never mixed with
// localStorage: this mirrors the receiver's own table, there's nothing to
// cache client-side.
export const bridges = signal(null)

export async function loadBridges() {
  try {
    const res = await fetch(`${location.origin}/$mqtt`)
    if (!res.ok) { bridges.value = null; return }
    const list = await res.json()
    bridges.value = Array.isArray(list) ? list : null
  } catch (e) {
    bridges.value = null
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
