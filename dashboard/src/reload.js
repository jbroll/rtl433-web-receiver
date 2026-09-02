// The receiver embeds the dashboard in its firmware, so a build id different
// from the one that served this page means the page is stale and reloads.
//
// The build is remembered per device, not once for the page. A bridge relays
// several receivers under one origin and they report different ids, so a
// single slot flipped between them on every message and reloaded in a loop.
const seen = new Map()

export function resetBuilds() { seen.clear() }

// True when this device has reported a build before and now reports a
// different one. The new value is recorded before returning, so a reload that
// takes a moment to happen does not see the same change again.
export function buildChanged(key, build) {
  if (typeof build !== 'string') return false
  const prev = seen.get(key)
  seen.set(key, build)
  return prev !== undefined && prev !== build
}
