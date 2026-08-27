// Every event is the one falling inside the given zone's calendar day for the
// Date passed in; zone defaults to UTC.

import { offsetMinutes } from './zone.js'

const RAD = Math.PI / 180
const DAY = 86400000
const AU = 149597870.7
const SYNODIC = 29.530588853
const MOON_HORIZON = 0.125
const SAMPLE = 60000

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
// zone's own midnight. moonTimes anchors to this and shifts back.
function zoneDayStart (date, zone) {
  const key = zoneDateKey(date, zone)
  const [y, mo, d] = key.split('-').map(Number)
  return Date.UTC(y, mo - 1, d)
}

// The instant the zone-local day y-mo-d begins. The offset read at UTC
// midnight is the wrong one within an hour of a transition, so it is read
// again at the instant that first guess names; on a day whose local midnight
// does not exist this settles on the instant the day does start.
function localMidnight (y, mo, d, zone) {
  const utcMidnight = Date.UTC(y, mo - 1, d)
  const guess = utcMidnight - offsetMinutes(new Date(utcMidnight), zone) * 60000
  return utcMidnight - offsetMinutes(new Date(guess), zone) * 60000
}

// [start, end) of the zone-local day `date` falls on. 23 to 25 hours long
// across a DST transition.
function dayWindow (date, zone) {
  const [y, mo, d] = zoneDateKey(date, zone).split('-').map(Number)
  return [localMidnight(y, mo, d, zone), localMidnight(y, mo, d + 1, zone)]
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

// Altitude of the sun's centre above the horizon, in degrees.
function solarAltitude (t, lat, lon) {
  const { declination, eqOfTime } = solarPosition(new Date(t))
  const minutes = ((t / 60000) % 1440 + 1440) % 1440
  const h = (minutes + 4 * lon + eqOfTime) / 4 - 180
  return Math.asin(sin(lat) * sin(declination) + cos(lat) * cos(declination) * cos(h)) / RAD
}

// The first crossing of `target` altitude inside the sampled window, rising
// (dir 1) or falling (dir -1), bisected within the minute that brackets it.
// A crossing outside the window has no representation, so no event can be
// reported on a day that does not contain one.
function crossing (alt, times, lat, lon, target, dir) {
  for (let i = 1; i < alt.length; i++) {
    const a = alt[i - 1] - target
    const b = alt[i] - target
    if (dir === 1 ? !(a <= 0 && b > 0) : !(a > 0 && b <= 0)) continue
    let lo = times[i - 1], hi = times[i]
    for (let k = 0; k < 32; k++) {
      const mid = (lo + hi) / 2
      if ((solarAltitude(mid, lat, lon) - target <= 0) === (a <= 0)) lo = mid
      else hi = mid
    }
    return (lo + hi) / 2
  }
  return null
}

// Solar transit is where the hour angle is zero, so it is solved rather than
// searched; the candidate UTC days on either side cover a longitude far from
// its zone and a window stretched by a DST transition.
function solarTransit (from, to, lon) {
  const first = Math.floor(from / DAY) - 1
  for (let d = first; d <= Math.floor(to / DAY) + 1; d++) {
    const base = d * DAY
    let mid = 720 - 4 * lon - solarPosition(new Date(base + 43200000)).eqOfTime
    mid = 720 - 4 * lon - solarPosition(new Date(base + mid * 60000)).eqOfTime
    const t = base + mid * 60000
    if (t >= from && t < to) return t
  }
  return null
}

export function sunEvents (date, lat, lon, zone = 'UTC') {
  const [from, to] = dayWindow(date, zone)
  const steps = Math.ceil((to - from) / SAMPLE)
  const times = new Float64Array(steps + 1)
  const alt = new Float64Array(steps + 1)
  let peak = -Infinity
  for (let i = 0; i <= steps; i++) {
    times[i] = Math.min(from + i * SAMPLE, to)
    alt[i] = solarAltitude(times[i], lat, lon)
    peak = Math.max(peak, alt[i])
  }
  const at = t => t === null ? null : new Date(Math.round(t))
  const event = (target, dir) => crossing(alt, times, lat, lon, target, dir)

  const rise = event(-0.833, 1)
  const set = event(-0.833, -1)
  const up = rise === null && set === null && peak > -0.833
  const events = {
    sunrise: at(rise),
    sunset: at(set),
    solarNoon: at(solarTransit(from, to, lon)),
    civilDawn: at(event(-6, 1)),
    civilDusk: at(event(-6, -1)),
    nauticalDawn: at(event(-12, 1)),
    nauticalDusk: at(event(-12, -1)),
    astroDawn: at(event(-18, 1)),
    astroDusk: at(event(-18, -1)),
    dayLength: null,
    alwaysUp: up,
    alwaysDown: rise === null && set === null && !up
  }
  if (rise !== null && set !== null) {
    let len = set - rise
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
