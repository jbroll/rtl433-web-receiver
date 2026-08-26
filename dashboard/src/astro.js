// Every event is the one falling inside the given zone's calendar day for the
// Date passed in; zone defaults to UTC.

import { offsetMinutes } from './zone.js'

const RAD = Math.PI / 180
const DAY = 86400000
const AU = 149597870.7
const SYNODIC = 29.530588853
const MOON_HORIZON = 0.125

const sin = d => Math.sin(d * RAD)
const cos = d => Math.cos(d * RAD)
const norm = a => ((a % 360) + 360) % 360
const century = date => (julianDay(date) - 2451545) / 36525

export function julianDay (date) {
  return date.getTime() / DAY + 2440587.5
}

// Y-M-D of `date` as seen in `zone`, zero-padded so two keys compare
// correctly with plain string comparison.
function zoneDateKey (date, zone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(date)
  const p = Object.create(null)
  for (const { type, value } of parts) p[type] = value
  return `${p.year}-${p.month}-${p.day}`
}

// UTC midnight of the zone-local calendar day `date` falls on -- not the
// zone's own midnight. eventMinutes anchors to this and shifts back.
function zoneDayStart (date, zone) {
  const key = zoneDateKey(date, zone)
  const [y, mo, d] = key.split('-').map(Number)
  return Date.UTC(y, mo - 1, d)
}

function obliquity (t) {
  return 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60 +
    0.00256 * cos(125.04 - 1934.136 * t)
}

function sun (t) {
  const L0 = norm(280.46646 + t * (36000.76983 + t * 0.0003032))
  const M = 357.52911 + t * (35999.05029 - 0.0001537 * t)
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t)
  const C = sin(M) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    sin(2 * M) * (0.019993 - 0.000101 * t) + sin(3 * M) * 0.000289
  const lambda = L0 + C - 0.00569 - 0.00478 * sin(125.04 - 1934.136 * t)
  const R = 1.000001018 * (1 - e * e) / (1 + e * cos(M + C))
  return { L0, M, e, lambda, R }
}

export function solarPosition (date) {
  const t = century(date)
  const { L0, M, e, lambda } = sun(t)
  const eps = obliquity(t)
  const y = Math.tan(eps / 2 * RAD) ** 2
  const eqOfTime = 4 * (y * sin(2 * L0) - 2 * e * sin(M) + 4 * e * y * sin(M) * cos(2 * L0) -
    0.5 * y * y * sin(4 * L0) - 1.25 * e * e * sin(2 * M)) / RAD
  return { declination: Math.asin(sin(eps) * sin(lambda)) / RAD, eqOfTime }
}

function hourAngle (lat, decl, zenith) {
  const c = (cos(zenith) - sin(lat) * sin(decl)) / (cos(lat) * cos(decl))
  return c > 1 || c < -1 ? null : Math.acos(c) / RAD
}

// `m` is minutes since UTC midnight (zoneDayStart), so it can land on the
// wrong side of local midnight. When it does, the event that actually falls
// on the local day is a different instant, roughly a day away but not
// exactly one -- declination and the equation of time both drift over a day.
// So this re-solves `solve` at an anchor shifted a day earlier or later,
// rather than adding/subtracting 86400000 from the answer, and returns the
// result re-based to the original `start` so callers keep using one origin.
//
// The shifted solve is not trusted blindly: `solveEventMinutes` normalizes
// its result relative to whatever anchor it is given, so a shift can land
// close enough to the anchor's own start to wrap onto a third day's crossing,
// or find no crossing at all. Either way this falls back to the naive
// 86400000ms translation of the first solve, which is always on the right
// day (if imprecise), rather than risk returning a wrong day or a spurious
// null.
//
// `m0`, when passed, is the caller's own already-computed `solve(start)` --
// callers that need that value anyway (e.g. solar noon) pass it to avoid
// solving twice.
function inLocalDay (start, zone, dayKey, solve, m0 = solve(start)) {
  const m = m0
  if (m === null) return null
  const key = zoneDateKey(new Date(start + m * 60000), zone)
  if (key === dayKey) return m
  const shiftMs = key < dayKey ? DAY : -DAY
  const fallback = m + shiftMs / 60000
  const m2 = solve(start + shiftMs)
  if (m2 === null) return fallback
  const m2abs = m2 + shiftMs / 60000
  const key2 = zoneDateKey(new Date(start + m2abs * 60000), zone)
  return key2 === dayKey ? m2abs : fallback
}

function solveEventMinutes (start, lat, lon, zenith, dir) {
  const noon = solarPosition(new Date(start + 43200000))
  let ha = hourAngle(lat, noon.declination, zenith)
  if (ha === null) return null
  let m = 720 - 4 * (lon + dir * ha) - noon.eqOfTime
  m -= 1440 * Math.floor(m / 1440)
  for (let i = 0; i < 2; i++) {
    const sp = solarPosition(new Date(start + m * 60000))
    ha = hourAngle(lat, sp.declination, zenith)
    if (ha === null) return null
    const next = 720 - 4 * (lon + dir * ha) - sp.eqOfTime
    m = next + 1440 * Math.round((m - next) / 1440)
  }
  return m
}

function eventMinutes (start, lat, lon, zenith, dir, zone, dayKey) {
  return inLocalDay(start, zone, dayKey, anchor => solveEventMinutes(anchor, lat, lon, zenith, dir))
}

export function sunEvents (date, lat, lon, zone = 'UTC') {
  const start = zoneDayStart(date, zone)
  const dayKey = zoneDateKey(date, zone)
  const at = m => m === null ? null : new Date(start + m * 60000)
  const solveNoon = anchor => {
    const noon = solarPosition(new Date(anchor + 43200000))
    let mid = 720 - 4 * lon - noon.eqOfTime
    mid -= 1440 * Math.floor(mid / 1440)
    const midday = solarPosition(new Date(anchor + mid * 60000))
    mid = 720 - 4 * lon - midday.eqOfTime
    mid -= 1440 * Math.floor(mid / 1440)
    return mid
  }
  const mid0 = solveNoon(start)
  const midday = solarPosition(new Date(start + mid0 * 60000))
  const mid = inLocalDay(start, zone, dayKey, solveNoon, mid0)

  const rise = eventMinutes(start, lat, lon, 90.833, 1, zone, dayKey)
  const set = eventMinutes(start, lat, lon, 90.833, -1, zone, dayKey)
  const up = rise === null && sin(lat) * sin(midday.declination) + cos(lat) * cos(midday.declination) > cos(90.833)
  const events = {
    sunrise: at(rise),
    sunset: at(set),
    solarNoon: at(mid),
    civilDawn: at(eventMinutes(start, lat, lon, 96, 1, zone, dayKey)),
    civilDusk: at(eventMinutes(start, lat, lon, 96, -1, zone, dayKey)),
    nauticalDawn: at(eventMinutes(start, lat, lon, 102, 1, zone, dayKey)),
    nauticalDusk: at(eventMinutes(start, lat, lon, 102, -1, zone, dayKey)),
    astroDawn: at(eventMinutes(start, lat, lon, 108, 1, zone, dayKey)),
    astroDusk: at(eventMinutes(start, lat, lon, 108, -1, zone, dayKey)),
    dayLength: null,
    alwaysUp: up,
    alwaysDown: rise === null && !up
  }
  if (rise !== null && set !== null) {
    let len = (set - rise) * 60000
    if (len < 0) len += DAY
    events.dayLength = len
  } else events.dayLength = up ? DAY : 0
  return events
}

// Meeus, Astronomical Algorithms ch. 47, tables 47.A and 47.B truncated.
const LON = [
  0, 0, 1, 0, 6288774, -20905355, 2, 0, -1, 0, 1274027, -3699111,
  2, 0, 0, 0, 658314, -2955968, 0, 0, 2, 0, 213618, -569925,
  0, 1, 0, 0, -185116, 48888, 0, 0, 0, 2, -114332, -3149,
  2, 0, -2, 0, 58793, 246158, 2, -1, -1, 0, 57066, -152138,
  2, 0, 1, 0, 53322, -170733, 2, -1, 0, 0, 45758, -204586,
  0, 1, -1, 0, -40923, -129620, 1, 0, 0, 0, -34720, 108743,
  0, 1, 1, 0, -30383, 104755, 2, 0, 0, -2, 15327, 10321,
  0, 0, 1, 2, -12528, 0, 0, 0, 1, -2, 10980, 79661,
  4, 0, -1, 0, 10675, -34782, 0, 0, 3, 0, 10034, -23210,
  4, 0, -2, 0, 8548, -21636, 2, 1, -1, 0, -7888, 24208,
  2, 1, 0, 0, -6766, 30824, 1, 0, -1, 0, -5163, -8379,
  1, 1, 0, 0, 4987, -16675, 2, -1, 1, 0, 4036, -12831,
  2, 0, 2, 0, 3994, -10445, 4, 0, 0, 0, 3861, -11650,
  2, 0, -3, 0, 3665, 14403
]
const LAT = [
  0, 0, 0, 1, 5128122, 0, 0, 1, 1, 280602, 0, 0, 1, -1, 277693,
  2, 0, 0, -1, 173237, 2, 0, -1, 1, 55413, 2, 0, -1, -1, 46271,
  2, 0, 0, 1, 32573, 0, 0, 2, 1, 17198, 2, 0, 1, -1, 9266,
  0, 0, 2, -1, 8822, 2, -1, 0, -1, 8216, 2, 0, -2, -1, 4324,
  2, 0, 1, 1, 4200
]

function moonPos (t) {
  const L = 218.3164477 + t * (481267.88123421 + t * (-0.0015786 + t / 538841))
  const D = 297.8501921 + t * (445267.1114034 + t * (-0.0018819 + t / 545868))
  const M = 357.5291092 + t * (35999.0502909 + t * (-0.0001536 + t / 24490000))
  const Mp = 134.9633964 + t * (477198.8675055 + t * (0.0087414 + t / 69699))
  const F = 93.2720950 + t * (483202.0175233 + t * (-0.0036539 - t / 3526000))
  const E = 1 - t * (0.002516 + 0.0000074 * t)
  let sl = 0, sr = 0, sb = 0
  for (let i = 0; i < LON.length; i += 6) {
    const m = LON[i + 1]
    const e = m === 0 ? 1 : (m === 1 || m === -1 ? E : E * E)
    const a = LON[i] * D + m * M + LON[i + 2] * Mp + LON[i + 3] * F
    sl += LON[i + 4] * e * sin(a)
    sr += LON[i + 5] * e * cos(a)
  }
  for (let i = 0; i < LAT.length; i += 5) {
    const m = LAT[i + 1]
    const e = m === 0 ? 1 : (m === 1 || m === -1 ? E : E * E)
    sb += LAT[i + 4] * e * sin(LAT[i] * D + m * M + LAT[i + 2] * Mp + LAT[i + 3] * F)
  }
  const lambda = norm(L + sl / 1e6)
  const beta = sb / 1e6
  const eps = obliquity(t)
  const ra = Math.atan2(sin(lambda) * cos(eps) - Math.tan(beta * RAD) * sin(eps), cos(lambda)) / RAD
  const dec = Math.asin(sin(beta) * cos(eps) + cos(beta) * sin(eps) * sin(lambda)) / RAD
  return { lambda, beta, dist: 385000.56 + sr / 1000, ra, dec }
}

function moonAltitude (date, lat, lon) {
  const { ra, dec } = moonPos(century(date))
  const gmst = norm(280.46061837 + 360.98564736629 * (julianDay(date) - 2451545))
  const h = gmst + lon - ra
  return Math.asin(sin(lat) * sin(dec) + cos(lat) * cos(dec) * cos(h)) / RAD
}

export function moonPhase (date) {
  const t = century(date)
  const s = sun(t)
  const m = moonPos(t)
  const rkm = s.R * AU
  const psi = Math.acos(cos(m.beta) * cos(m.lambda - s.lambda)) / RAD
  const i = Math.atan2(rkm * sin(psi), m.dist - rkm * cos(psi)) / RAD
  const phase = norm(m.lambda - s.lambda) / 360
  const waxing = phase < 0.5
  const k = (1 + cos(i)) / 2
  const name = k < 0.02 ? 'New Moon'
    : k > 0.98 ? 'Full Moon'
      : Math.abs(k - 0.5) < 0.02 ? (waxing ? 'First Quarter' : 'Last Quarter')
        : k < 0.5 ? (waxing ? 'Waxing Crescent' : 'Waning Crescent')
          : (waxing ? 'Waxing Gibbous' : 'Waning Gibbous')
  return { age: phase * SYNODIC, phase, illumination: k, name, waxing }
}

// This scans a fixed window rather than solving a formula, so the window
// itself has to start at local midnight, not be shifted after the fact.
export function moonTimes (date, lat, lon, zone = 'UTC') {
  const start = zoneDayStart(date, zone) - offsetMinutes(date, zone) * 60000
  const step = 600000
  const steps = DAY / step
  let rise = null, set = null, lo = Infinity, hi = -Infinity
  let prev = moonAltitude(new Date(start), lat, lon) - MOON_HORIZON
  for (let i = 1; i <= steps; i++) {
    const alt = moonAltitude(new Date(start + i * step), lat, lon) - MOON_HORIZON
    lo = Math.min(lo, prev, alt)
    hi = Math.max(hi, prev, alt)
    if (prev <= 0 && alt > 0 && rise === null) {
      rise = new Date(start + (i - 1 - prev / (alt - prev)) * step)
    } else if (prev > 0 && alt <= 0 && set === null) {
      set = new Date(start + (i - 1 - prev / (alt - prev)) * step)
    }
    prev = alt
  }
  return { rise, set, alwaysUp: lo > 0, alwaysDown: hi <= 0 }
}
