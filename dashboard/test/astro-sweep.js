// Sweeps sunEvents against an independent bisection of true solar altitude,
// over two years of local days at sites chosen to cover every latitude band
// and DST rule. Not a *.test.js: it takes minutes and is run by hand.
//
//   node test/astro-sweep.js [--module ../src/astro.js] [--years 2026,2027]
//
// A module under test may set globalThis.__sweepCounters to a counter object;
// whatever it holds is printed with the results, which is how the pre-fix
// anchor-and-correct fallback rate was measured.

import { offsetMinutes } from '../src/zone.js'

const DAY = 86400000
const RAD = Math.PI / 180
const rsin = d => Math.sin(d * RAD)
const rcos = d => Math.cos(d * RAD)

const argv = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = argv.indexOf('--' + name)
  return i === -1 ? dflt : argv[i + 1]
}
const modulePath = arg('module', '../src/astro.js')
const years = arg('years', '2026,2027').split(',').map(Number)

const { sunEvents, solarPosition } = await import(modulePath)

// Zeniths as altitudes, with the direction each event crosses in.
const EVENTS = [
  ['sunrise', -0.833, 1], ['sunset', -0.833, -1],
  ['civilDawn', -6, 1], ['civilDusk', -6, -1],
  ['nauticalDawn', -12, 1], ['nauticalDusk', -12, -1],
  ['astroDawn', -18, 1], ['astroDusk', -18, -1]
]

const SITES = [
  ['Svalbard', 78.22, 15.65, 'Arctic/Longyearbyen'],
  ['Alert', 82.5, -62.35, 'America/Toronto'],
  ['Nuuk', 64.18, -51.72, 'America/Nuuk'],
  ['Anchorage-north', 71.29, -156.79, 'America/Anchorage'],
  ['Anchorage', 61.22, -149.9, 'America/Anchorage'],
  ['Murmansk', 68.97, 33.08, 'Europe/Moscow'],
  ['Tromso', 69.65, 18.96, 'Europe/Oslo'],
  ['Reykjavik', 64.13, -21.9, 'Atlantic/Reykjavik'],
  ['Helsinki', 60.17, 24.94, 'Europe/Helsinki'],
  ['Stockholm', 59.33, 18.07, 'Europe/Stockholm'],
  ['Moscow', 55.76, 37.62, 'Europe/Moscow'],
  ['London', 51.51, -0.13, 'Europe/London'],
  ['Berlin', 52.52, 13.4, 'Europe/Berlin'],
  ['Lisbon', 38.72, -9.14, 'Europe/Lisbon'],
  ['Athens', 37.98, 23.73, 'Europe/Athens'],
  ['Reykjanes', 63.82, -22.7, 'Atlantic/Reykjavik'],
  ['StJohns', 47.56, -52.71, 'America/St_Johns'],
  ['NewYork', 40.71, -74.01, 'America/New_York'],
  ['Denver', 39.74, -104.99, 'America/Denver'],
  ['Phoenix', 33.45, -112.07, 'America/Phoenix'],
  ['LosAngeles', 34.05, -118.24, 'America/Los_Angeles'],
  ['Chicago', 41.88, -87.63, 'America/Chicago'],
  ['Honolulu', 21.31, -157.86, 'Pacific/Honolulu'],
  ['MexicoCity', 19.43, -99.13, 'America/Mexico_City'],
  ['Kathmandu', 27.72, 85.32, 'Asia/Kathmandu'],
  ['Kolkata', 22.57, 88.36, 'Asia/Kolkata'],
  ['Tehran', 35.69, 51.39, 'Asia/Tehran'],
  ['Dubai', 25.2, 55.27, 'Asia/Dubai'],
  ['Tokyo', 35.68, 139.69, 'Asia/Tokyo'],
  ['Beijing', 39.9, 116.41, 'Asia/Shanghai'],
  ['Singapore', 1.35, 103.82, 'Asia/Singapore'],
  ['Nairobi', -1.29, 36.82, 'Africa/Nairobi'],
  ['Lagos', 6.52, 3.38, 'Africa/Lagos'],
  ['Johannesburg', -26.2, 28.05, 'Africa/Johannesburg'],
  ['SaoPaulo', -23.55, -46.63, 'America/Sao_Paulo'],
  ['Santiago', -33.45, -70.67, 'America/Santiago'],
  ['PuntaArenas', -53.16, -70.91, 'America/Punta_Arenas'],
  ['Ushuaia', -54.8, -68.3, 'America/Argentina/Ushuaia'],
  ['Sydney', -33.87, 151.21, 'Australia/Sydney'],
  ['Auckland', -36.85, 174.76, 'Pacific/Auckland'],
  ['Chatham', -43.95, -176.55, 'Pacific/Chatham'],
  ['McMurdo', -77.85, 166.67, 'Antarctica/McMurdo'],
  ['Apia', -13.76, -171.78, 'Pacific/Apia'],
  ['Null', 0, 0, 'UTC']
]

function zoneKey (t, zone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(t))
  const p = Object.create(null)
  for (const { type, value } of parts) p[type] = value
  return `${p.year}-${p.month}-${p.day}`
}

function refAltitude (t, lat, lon) {
  const date = new Date(t)
  const { declination, eqOfTime } = solarPosition(date)
  const utcMinutes = date.getUTCHours() * 60 + date.getUTCMinutes() +
    date.getUTCSeconds() / 60 + date.getUTCMilliseconds() / 60000
  let h = (utcMinutes + 4 * lon + eqOfTime) / 4 - 180
  h = ((h + 180) % 360 + 360) % 360 - 180
  return Math.asin(rsin(lat) * rsin(declination) + rcos(lat) * rcos(declination) * rcos(h)) / RAD
}

function refMidnight (y, mo, d, zone) {
  const utcMidnight = Date.UTC(y, mo - 1, d)
  const guess = utcMidnight - offsetMinutes(new Date(utcMidnight), zone) * 60000
  return utcMidnight - offsetMinutes(new Date(guess), zone) * 60000
}

// Every crossing of `target` in the local day, from an independent
// 20-second scan plus bisection. A day near the polar summer boundary can
// hold two in the same direction.
function refCrossings (from, to, lat, lon, target, dir) {
  const step = 20000
  const found = []
  let prevT = from
  let prev = refAltitude(from, lat, lon) - target
  for (let t = from + step; t <= to; t = Math.min(t + step, to)) {
    const alt = refAltitude(t, lat, lon) - target
    if (dir === 1 ? (prev <= 0 && alt > 0) : (prev > 0 && alt <= 0)) {
      let lo = prevT, hi = t
      const loSign = prev <= 0
      for (let i = 0; i < 45; i++) {
        const mid = (lo + hi) / 2
        if ((refAltitude(mid, lat, lon) - target <= 0) === loSign) lo = mid
        else hi = mid
      }
      found.push((lo + hi) / 2)
    }
    prevT = t
    prev = alt
    if (t >= to) break
  }
  return found
}

let calls = 0, emitted = 0, wrongDay = 0, spurious = 0, missed = 0
let over1s = 0, over60s = 0, worst = null, alternate = 0, ambiguous = 0
const worstPerSite = new Map()

for (const [name, lat, lon, zone] of SITES) {
  for (const y of years) {
    for (let day = Date.UTC(y, 0, 1); day < Date.UTC(y + 1, 0, 1); day += DAY) {
      const d = new Date(day)
      const [yy, mm, dd] = [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()]
      const key = `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`
      const from = refMidnight(yy, mm, dd, zone)
      const to = refMidnight(yy, mm, dd + 1, zone)
      const e = sunEvents(new Date(from + (to - from) / 2), lat, lon, zone)
      calls++
      for (const [event, target, dir] of EVENTS) {
        const got = e[event]
        const all = refCrossings(from, to, lat, lon, target, dir)
        const want = all.length ? all[0] : null
        if (all.length > 1) ambiguous++
        if (got === null && want === null) continue
        if (got === null) { missed++; continue }
        emitted++
        if (zoneKey(got.getTime(), zone) !== key) wrongDay++
        if (want === null) { spurious++; continue }
        const err = Math.abs(got.getTime() - want) / 1000
        // A day holding two crossings of one direction: reporting the other
        // one is a different choice, not a mistimed event.
        if (err > 40000 && all.length > 1) { alternate++; continue }
        if (err > 1) over1s++
        if (err > 60) over60s++
        if (worst === null || err > worst.err) worst = { err, name, lat, event, key }
        const w = worstPerSite.get(name)
        if (!w || err > w.err) worstPerSite.set(name, { err, event, key })
      }
    }
  }
}

const counters = globalThis.__sweepCounters
console.log(`module        ${modulePath}`)
console.log(`years         ${years.join(', ')}`)
console.log(`sites         ${SITES.length}`)
console.log(`sunEvents     ${calls} calls`)
console.log(`events        ${emitted} emitted`)
console.log(`wrong day     ${wrongDay}`)
console.log(`spurious      ${spurious} (emitted where the local day has no crossing)`)
console.log(`missed        ${missed} (crossing in the local day reported as null)`)
console.log(`over 1s       ${over1s} (${(100 * over1s / emitted).toFixed(3)}%)`)
console.log(`over 60s      ${over60s}`)
console.log(`two-crossing  ${ambiguous} events on a day holding two crossings of that direction`)
console.log(`alternate     ${alternate} of those reported as the later crossing`)
if (worst) console.log(`worst         ${worst.err.toFixed(1)}s  ${worst.name} ${worst.lat} ${worst.event} ${worst.key}`)
if (counters) for (const [k, v] of Object.entries(counters)) console.log(`counter ${k}  ${v}`)
const ranked = [...worstPerSite].sort((a, b) => b[1].err - a[1].err).slice(0, 8)
for (const [name, w] of ranked) console.log(`  ${name.padEnd(16)} ${w.err.toFixed(1)}s  ${w.event} ${w.key}`)
