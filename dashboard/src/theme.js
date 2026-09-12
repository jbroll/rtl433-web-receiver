import { computed } from '@preact/signals'
import { solarAltitude } from './astro.js'
import { settings, resolvedLocation } from './settings.js'
import { tick } from './tick.js'

// Civil twilight. Testing the altitude pointwise rather than comparing against
// the day's civilDawn and civilDusk avoids every case where those are absent:
// a polar day has no crossing to compare against.
export const CIVIL = -6

// null is no override, leaving `color-scheme: light dark` to follow the OS.
export const darkNow = computed(() => {
  const theme = settings.value.theme
  if (theme === 'light') return false
  if (theme === 'dark') return true
  if (theme !== 'auto') return null
  const { lat, lon } = resolvedLocation()
  if (lat === null || lon === null) return null
  tick.value
  return solarAltitude(Date.now(), lat, lon) < CIVIL
})
