import { signal, effect } from '@preact/signals'
import { tick } from './tick.js'

export const toast = signal(null)

export function showToast(msg, seconds = 3) {
  toast.value = { msg, until: Date.now() + seconds * 1000 }
}

// Rides tick rather than its own setTimeout, same as the feed scheduler in
// main.jsx -- tick is the app's only timer.
effect(() => {
  tick.value
  const t = toast.peek()
  if (t && Date.now() >= t.until) toast.value = null
})
