import { signal } from '@preact/signals'
import { offsetMinutes } from './feeds/zone.js'
import { sources } from './sources.js'

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

function cleanUnits(u) {
  const s = u && typeof u === 'object' ? u : {}
  const units = s.units === 'imperial' ? 'imperial' : s.units === 'custom' ? 'custom' : 'metric'
  const decimals = Number.isInteger(s.decimals) && s.decimals >= 0 && s.decimals <= 5 ? s.decimals : 1
  const custom = { ...PRESETS[units] }
  if (units === 'custom') {
    const c = s.custom && typeof s.custom === 'object' ? s.custom : {}
    for (const group of Object.keys(CUSTOM_VALUES)) {
      if (CUSTOM_VALUES[group].has(c[group])) custom[group] = c[group]
    }
  }
  return { units, decimals, custom }
}

export const settings = signal(fresh())

// base -> location object, the network fallback layer. Same structure
// layout_template.js's `layouts` map uses for $layout.
export const locations = signal(new Map())
// base -> raw UTC-offset minutes, the network fallback layer for $tz.
export const tzOffsets = signal(new Map())
// base -> cleaned units object, the network fallback layer for $units.
export const unitsBySource = signal(new Map())

// One-way latch for the lifetime of the page load, the same discipline
// layout_template.js uses for the site default layout: settings already in
// localStorage close it at boot, and so does the visitor's first unit change.
let unitsAuto = true

export function onLocationFrame(base, payload) {
  const next = new Map(locations.value)
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) next.set(base, cleanLocation(payload))
  else next.delete(base)
  locations.value = next
}

export function onUnitsFrame(base, payload) {
  const next = new Map(unitsBySource.value)
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) next.set(base, cleanUnits(payload))
  else next.delete(base)
  unitsBySource.value = next
  if (!unitsAuto) return
  // The origin probe only adds its base to sources once the stream is live,
  // so the frame's own source stands in until it is configured.
  const u = unitsForSources(next, sources.value) || next.get(base)
  // Never saved: nothing local means nothing local, so a later reload takes
  // whatever the receiver publishes then.
  if (u) settings.value = { ...settings.value, ...u }
}

export function onTzFrame(base, payload) {
  const next = new Map(tzOffsets.value)
  if (typeof payload === 'number' && Number.isFinite(payload)) next.set(base, payload)
  else next.delete(base)
  tzOffsets.value = next
}

// Load has no write, so it carries none of Save's same-origin trust boundary --
// any connected source's published location is fair game. Picks the first
// configured source (in sources.value order) that has one, same convention
// layoutForSources() established for $layout.
export function locationForSources(locationsMap, srcs) {
  for (const base of srcs) {
    const l = locationsMap.get(base)
    // A coordinate-less entry is not a candidate: taking it would shadow a
    // later source that has a real one.
    if (l && l.lat !== null && l.lon !== null) return l
  }
  return null
}

export function unitsForSources(unitsMap, srcs) {
  for (const base of srcs) {
    const u = unitsMap.get(base)
    if (u) return u
  }
  return null
}

// The zone published alongside a network location is an IANA name, usable
// directly by Intl -- $tz's own network value is a raw UTC-offset in
// minutes, which Intl's timeZone option cannot consume, so it does not
// feed this resolution; tzOffsets exists for the receiver's own round trip.
export function resolvedLocation() {
  const l = settings.value.location
  if (l.lat !== null && l.lon !== null) return l
  return locationForSources(locations.value, sources.value) || blankLocation()
}

let storageBroken = false

export function loadSettings() {
  settings.value = fresh()
  // Reload re-tests storage rather than staying latched off after one throw,
  // matching loadAliases. A private-mode tab that gains quota still saves.
  storageBroken = false
  unitsAuto = true
  let raw
  try { raw = localStorage.getItem(SETTINGS_KEY) } catch (e) { storageBroken = true; return }
  if (!raw) return
  let s
  try { s = JSON.parse(raw) } catch (e) { return }
  if (!s || typeof s !== 'object') return
  // A blob written before $units existed carries no marker, so it counts as a
  // choice: an upgrade must not override units someone already picked. Saving
  // a location alone leaves the marker false and adoption open.
  unitsAuto = s.unitsChosen === false
  settings.value = { ...cleanUnits(s), location: cleanLocation(s.location) }
}

export function saveSettings() {
  if (storageBroken) return
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...settings.value, unitsChosen: !unitsAuto })) }
  catch (e) { storageBroken = true }
}

// Gated the same way setLocation()'s POSTs are: publishing to a source is only
// meaningful when this page is served by that source. Also called by the Save
// button, so a receiver whose units nobody has changed still gets some.
export function publishUnits() {
  if (!sources.value.includes(location.origin)) return
  const { units, decimals, custom } = settings.value
  fetch(`${location.origin}/$units`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ units, decimals, custom }),
  }).catch(err => console.error(`POST $units failed: ${err.message || err}`))
}

// The visitor's own choice ends any claim the receiver's units have on this
// browser.
function unitsChanged() {
  unitsAuto = false
  publishUnits()
}

export function setUnits(u) {
  if (!(u in PRESETS) && u !== 'custom') return
  const custom = u === 'custom' ? { ...settings.value.custom } : { ...PRESETS[u] }
  settings.value = { ...settings.value, units: u, custom }
  unitsChanged()
  saveSettings()
}

export function setDecimals(d) {
  if (!Number.isInteger(d) || d < 0 || d > 5) return
  settings.value = { ...settings.value, decimals: d }
  unitsChanged()
  saveSettings()
}

export function setCustomField(group, value) {
  if (!CUSTOM_VALUES[group] || !CUSTOM_VALUES[group].has(value)) return
  settings.value = { ...settings.value, custom: { ...settings.value.custom, [group]: value } }
  unitsChanged()
  saveSettings()
}

// The whole location moves at once: a lat without a lon is not a place, and
// the feeds must never see one half updated.
export function setLocation(next) {
  const clean = cleanLocation({ ...settings.value.location, ...next })
  settings.value = { ...settings.value, location: clean }
  saveSettings()
  // Gated the same way the $layout Save button is: publishing to a source is
  // only meaningful when this page is served by that source. The value gate is
  // `clean` itself, never hasLocation() -- that resolves through the network
  // fallback, so a blank local edit would publish over the receiver's own
  // stored location.
  if (clean.lat !== null && clean.lon !== null && sources.value.includes(location.origin)) {
    const offset = offsetMinutes(new Date(), clean.zone || localZone())
    fetch(`${location.origin}/$tz`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(offset),
    }).catch(err => console.error(`POST $tz failed: ${err.message || err}`))
    fetch(`${location.origin}/$location`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(clean),
    }).catch(err => console.error(`POST $location failed: ${err.message || err}`))
  }
  return clean
}

export function clearLocation() {
  settings.value = { ...settings.value, location: blankLocation() }
  saveSettings()
}

export function hasLocation() {
  const l = resolvedLocation()
  return l.lat !== null && l.lon !== null
}

export function localZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' }
  catch (e) { return 'UTC' }
}

// The zone the feeds should use: the user's choice, else the browser's.
export function activeZone() {
  return resolvedLocation().zone || localZone()
}
