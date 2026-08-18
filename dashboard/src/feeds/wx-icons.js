// NWS names the condition in its icon URL rather than in a field, e.g.
// .../icons/land/day/bkn/tsra_hi,30?size=medium. The first condition after the
// day or night segment is the one the card shows. Hotlinking their PNGs would
// break the self-contained page and cost an image request per period.

export function skyOf(icon) {
  if (typeof icon !== 'string') return ''
  const path = icon.split('/land/')[1]
  if (!path) return ''
  const parts = path.split('?')[0].split('/')
  const cond = parts[1] || parts[0]
  return cond ? cond.split(',')[0] : ''
}

export function isNight(icon) {
  return typeof icon === 'string' && icon.includes('/land/night/')
}

const GLYPH = {
  skc: '☀', few: '🌤', sct: '⛅', bkn: '🌥', ovc: '☁',
  wind_skc: '☀', wind_few: '🌤', wind_sct: '⛅', wind_bkn: '🌥', wind_ovc: '☁',
  rain: '🌧', rain_showers: '🌦', rain_showers_hi: '🌦', rain_sleet: '🌨',
  rain_snow: '🌨', rain_fzra: '🌧', snow_fzra: '🌨', fzra: '🌧', sleet: '🌨',
  snow: '❄', blizzard: '❄',
  tsra: '⛈', tsra_sct: '⛈', tsra_hi: '⛈', tornado: '🌪', hurricane: '🌀', tropical_storm: '🌀',
  dust: '😶‍🌫️', smoke: '🌫', haze: '🌫', fog: '🌫',
  hot: '🌡', cold: '🌡',
}

const NIGHT = { skc: '🌙', few: '🌙', sct: '☁', bkn: '☁', ovc: '☁' }

export function glyphOf(sky, night) {
  if (night && NIGHT[sky]) return NIGHT[sky]
  return GLYPH[sky] || '·'
}
