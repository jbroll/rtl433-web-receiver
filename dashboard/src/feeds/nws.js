import { Unsupported } from './feed.js'
import { skyOf, isNight } from './wx-icons.js'

const API = 'https://api.weather.gov'

// api.weather.gov 301-redirects anything finer than four decimals, so round
// before asking and the grid lookup is cached against a stable key.
function round(v) { return Number(v.toFixed(4)) }

// NWS documents a required identifying User-Agent, which a browser refuses to
// send: it is a forbidden header name and fetch drops it. Nothing else is sent
// either, because a non-safelisted header would force a preflight this API
// does not answer.
async function get(url) {
  const res = await fetch(url, { headers: { Accept: 'application/geo+json' } })
  if (res.status === 404) throw new Unsupported('No NWS forecast for this location (United States only)')
  if (!res.ok) {
    const err = new Error(`weather.gov returned ${res.status}`)
    err.retryAfter = Number(res.headers.get('Retry-After')) * 1000 || 0
    throw err
  }
  return res.json()
}

export function parsePoints(json) {
  const p = json && json.properties
  if (!p || !p.forecast) throw new Unsupported('No NWS forecast for this location (United States only)')
  const rel = (p.relativeLocation && p.relativeLocation.properties) || {}
  return {
    forecast: p.forecast,
    hourly: p.forecastHourly || '',
    stations: p.observationStations || '',
    zone: typeof p.timeZone === 'string' ? p.timeZone : '',
    city: rel.city || '',
    state: rel.state || '',
  }
}

export function parseStations(json) {
  const f = json && json.features
  if (!Array.isArray(f)) return ''
  for (const s of f) {
    const id = s && s.properties && s.properties.stationIdentifier
    if (id) return id
  }
  return ''
}

function pop(period) {
  const v = period.probabilityOfPrecipitation
  return v && Number.isFinite(v.value) ? v.value : 0
}

// Periods alternate day and night, but the run starts at whatever period is
// current, so it may open on a night with no day in front of it. That orphan
// becomes tonight's low rather than a day of its own.
export function parseForecast(json) {
  const periods = json && json.properties && json.properties.periods
  if (!Array.isArray(periods) || !periods.length) throw new Error('no forecast periods')

  const days = []
  let i = 0
  if (!periods[0].isDaytime) {
    const n = periods[0]
    days.push({
      $r: 'forecastDay', label: n.name, unit: n.temperatureUnit,
      hi: null, lo: n.temperature, pop: pop(n),
      sky: skyOf(n.icon), night: true, text: n.shortForecast,
      brief: `${n.name} ${n.temperature}°`,
    })
    i = 1
  }
  for (; i < periods.length; i++) {
    const d = periods[i]
    if (!d.isDaytime) continue
    const n = periods[i + 1] && !periods[i + 1].isDaytime ? periods[i + 1] : null
    days.push({
      $r: 'forecastDay', label: d.name, unit: d.temperatureUnit,
      hi: d.temperature, lo: n ? n.temperature : null, pop: pop(d),
      sky: skyOf(d.icon), night: false, text: d.shortForecast,
      brief: n ? `${d.name} ${d.temperature}/${n.temperature}°` : `${d.name} ${d.temperature}°`,
    })
  }
  return { days, first: periods[0] }
}

function q(v) { return v && Number.isFinite(v.value) ? v.value : null }

export function parseObservation(json) {
  const p = json && json.properties
  if (!p) return null
  const at = Date.parse(p.timestamp)
  const fields = {}
  const set = (name, v, scale) => { if (v !== null) fields[name] = scale ? v * scale : v }

  set('temperature_C', q(p.temperature))
  set('dewpoint_C', q(p.dewpoint))
  // NWS reports relative humidity to twelve decimals, which is noise.
  const rh = q(p.relativeHumidity)
  set('humidity', rh === null ? null : Math.round(rh * 10) / 10)
  set('wind_avg_km_h', q(p.windSpeed))
  set('wind_max_km_h', q(p.windGust))
  set('wind_dir_deg', q(p.windDirection))
  // UNITS in units.js has no pascal, and hPa is what a barometer reads.
  set('pressure_hPa', q(p.barometricPressure), 0.01)

  return {
    at: Number.isFinite(at) ? at : Date.now(),
    text: typeof p.textDescription === 'string' ? p.textDescription : '',
    sky: skyOf(p.icon),
    night: isNight(p.icon),
    fields,
  }
}

export default {
  id: 'weather',
  topic: 'Weather',
  interval: 15 * 60000,
  stamped: true,

  async run(ctx) {
    let meta = ctx.meta
    if (!meta || !meta.forecast) {
      meta = parsePoints(await get(`${API}/points/${round(ctx.lat)},${round(ctx.lon)}`))
      meta.station = meta.stations ? parseStations(await get(meta.stations)) : ''
    }

    const { days } = parseForecast(await get(meta.forecast))

    let obs = null
    if (meta.station) {
      // A station can be offline while the forecast is fine, so the current
      // conditions are optional and never fail the whole feed.
      try { obs = parseObservation(await get(`${API}/stations/${meta.station}/observations/latest`)) }
      catch (e) { obs = null }
    }

    const fields = {}
    const lead = days[0]
    fields.now = {
      $r: 'now',
      text: (obs && obs.text) || (lead && lead.text) || '',
      sky: obs ? obs.sky : (lead ? lead.sky : ''),
      night: obs ? obs.night : false,
      temp: obs && obs.fields.temperature_C !== undefined ? obs.fields.temperature_C
            : (lead && lead.hi !== null ? lead.hi : null),
      unit: obs && obs.fields.temperature_C !== undefined ? 'C' : (lead ? lead.unit : 'F'),
      place: meta.city ? `${meta.city}, ${meta.state}` : '',
      brief: (obs && obs.text) || (lead && lead.text) || '',
    }
    days.forEach((d, i) => { fields['day' + i] = d })
    if (obs) Object.assign(fields, obs.fields)

    return { fields, at: obs ? obs.at : Date.now(), meta }
  },
}
