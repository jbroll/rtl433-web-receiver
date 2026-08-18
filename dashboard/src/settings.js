import { signal } from '@preact/signals'

export const SETTINGS_KEY = 'rtl433.settings.v1'

const PRESETS = {
  metric: { temp: 'C', rain: 'mm', wind: 'km/h', pressure: 'hPa' },
  imperial: { temp: 'F', rain: 'in', wind: 'mi/h', pressure: 'hPa' },
}

const CUSTOM_VALUES = {
  temp: new Set(['C', 'F']),
  rain: new Set(['mm', 'in']),
  wind: new Set(['km/h', 'mi/h', 'm/s']),
  pressure: new Set(['hPa', 'kPa']),
}

function blankLocation() {
  return { lat: null, lon: null, label: '', zone: '', zoom: 11 }
}

function fresh() {
  return { units: 'metric', decimals: 1, custom: { ...PRESETS.metric },
           location: blankLocation() }
}

function coord(v, limit) {
  return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= limit ? v : null
}

// Intl is the only authority on whether a zone name is real, and it throws
// rather than reporting.
function knownZone(z) {
  if (typeof z !== 'string' || !z) return false
  try { new Intl.DateTimeFormat(undefined, { timeZone: z }); return true }
  catch (e) { return false }
}

function cleanLocation(l) {
  if (!l || typeof l !== 'object') return blankLocation()
  const lat = coord(l.lat, 90)
  const lon = coord(l.lon, 180)
  return {
    // A half-set coordinate is no location at all.
    lat: lat === null || lon === null ? null : lat,
    lon: lat === null || lon === null ? null : lon,
    label: typeof l.label === 'string' ? l.label.slice(0, 120) : '',
    zone: knownZone(l.zone) ? l.zone : '',
    zoom: Number.isInteger(l.zoom) && l.zoom >= 1 && l.zoom <= 19 ? l.zoom : 11,
  }
}

export const settings = signal(fresh())

let storageBroken = false

export function loadSettings() {
  settings.value = fresh()
  // Reload re-tests storage rather than staying latched off after one throw,
  // matching loadAliases. A private-mode tab that gains quota still saves.
  storageBroken = false
  let raw
  try { raw = localStorage.getItem(SETTINGS_KEY) } catch (e) { storageBroken = true; return }
  if (!raw) return
  let s
  try { s = JSON.parse(raw) } catch (e) { return }
  if (!s || typeof s !== 'object') return
  const units = s.units === 'imperial' ? 'imperial' : s.units === 'custom' ? 'custom' : 'metric'
  const decimals = Number.isInteger(s.decimals) && s.decimals >= 0 && s.decimals <= 5 ? s.decimals : 1
  const custom = { ...PRESETS[units] }
  if (units === 'custom') {
    const c = s.custom && typeof s.custom === 'object' ? s.custom : {}
    for (const group of Object.keys(CUSTOM_VALUES)) {
      if (CUSTOM_VALUES[group].has(c[group])) custom[group] = c[group]
    }
  }
  settings.value = { units, decimals, custom, location: cleanLocation(s.location) }
}

export function saveSettings() {
  if (storageBroken) return
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings.value)) }
  catch (e) { storageBroken = true }
}

export function setUnits(u) {
  if (!(u in PRESETS) && u !== 'custom') return
  const custom = u === 'custom' ? { ...settings.value.custom } : { ...PRESETS[u] }
  settings.value = { ...settings.value, units: u, custom }
  saveSettings()
}

export function setDecimals(d) {
  if (!Number.isInteger(d) || d < 0 || d > 5) return
  settings.value = { ...settings.value, decimals: d }
  saveSettings()
}

export function setCustomField(group, value) {
  if (!CUSTOM_VALUES[group] || !CUSTOM_VALUES[group].has(value)) return
  settings.value = { ...settings.value, custom: { ...settings.value.custom, [group]: value } }
  saveSettings()
}

// The whole location moves at once: a lat without a lon is not a place, and
// the feeds must never see one half updated.
export function setLocation(next) {
  const clean = cleanLocation({ ...settings.value.location, ...next })
  settings.value = { ...settings.value, location: clean }
  saveSettings()
  return clean
}

export function clearLocation() {
  settings.value = { ...settings.value, location: blankLocation() }
  saveSettings()
}

export function hasLocation() {
  const l = settings.value.location
  return l.lat !== null && l.lon !== null
}

export function localZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' }
  catch (e) { return 'UTC' }
}

// The zone the feeds should use: the user's choice, else the browser's.
export function activeZone() {
  return settings.value.location.zone || localZone()
}
