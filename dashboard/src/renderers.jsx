import { registerValue } from './render-values.js'
import { tick } from './tick.js'
import { displayValue } from './units.js'
import { settings } from './settings.js'
import { glyphOf } from './feeds/wx-icons.js'

// Imported for its registrations, so a renderer is reachable by tag before the
// first card renders. Components live here rather than beside the registry so
// the registry stays plain JS that `node --test` can import.

registerValue('text', ({ v }) => (
  <>
    {v.label && <div class="cfn">{v.label}</div>}
    <div class="ctext">{v.text}</div>
  </>
))

// Seconds come off the shared tick rather than a timer of this component's
// own, so the whole page still runs on one interval.
registerValue('clock', ({ v }) => {
  tick.value
  const now = new Date()
  return (
    <>
      <div class="cfn">{v.zone}</div>
      <div class="big">{new Intl.DateTimeFormat(undefined, {
        timeZone: v.zone, hour: '2-digit', minute: '2-digit', hour12: false }).format(now)}</div>
      <div class="csub">{new Intl.DateTimeFormat(undefined, {
        timeZone: v.zone, second: '2-digit' }).format(now)}s</div>
    </>
  )
})

const DAY = 86400000
const CX = 50, CY = 46, R = 38

// Where the sun sits on the dial: 180°..360° tracks sunrise to sunset over the
// top, 0°..180° tracks the night under the horizon.
function sunAngle(v, now) {
  if (v.alwaysUp) return 270
  if (v.alwaysDown) return 90
  if (v.sunrise === null || !v.dayLength) return 90
  const into = ((now - v.sunrise) % DAY + DAY) % DAY
  if (into <= v.dayLength) return 180 + 180 * (into / v.dayLength)
  return 180 * (into - v.dayLength) / (DAY - v.dayLength)
}

registerValue('sun', ({ v }) => {
  tick.value
  const a = sunAngle(v, Date.now()) * Math.PI / 180
  const x = CX + R * Math.cos(a)
  const y = CY + R * Math.sin(a)
  const up = y <= CY

  return (
    <>
      <div class="dialbox">
        <svg class="dial" viewBox="0 0 100 64" preserveAspectRatio="xMidYMid meet">
          <rect x="8" y={CY} width="84" height="18" fill="#8883" />
          <rect x="8" y={CY} width="84" height={R * 12 / 90} fill="#8883" />
          <rect x="8" y={CY} width="84" height={R * 6 / 90} fill="#8883" />
          <path d={`M ${CX - R} ${CY} A ${R} ${R} 0 0 1 ${CX + R} ${CY}`}
                fill="none" stroke="currentColor" stroke-width="1.2" opacity=".7" />
          <line x1="4" y1={CY} x2="96" y2={CY} stroke="currentColor" stroke-width="1" opacity=".5" />
          <circle cx={x} cy={y} r="5" fill={up ? 'currentColor' : 'none'}
                  stroke="currentColor" stroke-width="1.4" />
        </svg>
      </div>
      <div class="csub">{v.brief}</div>
    </>
  )
})

// The terminator is a half ellipse whose width falls to zero at the quarters;
// its sweep flips at half illumination, where the shape turns from crescent
// to gibbous.
function moonPath(k, waxing) {
  const r = 46, cx = 50, cy = 50
  const rx = Math.max(0.01, r * Math.abs(1 - 2 * k))
  const outer = waxing ? 1 : 0
  const inner = k > 0.5 ? outer : 1 - outer
  return `M ${cx} ${cy - r} A ${r} ${r} 0 0 ${outer} ${cx} ${cy + r}` +
         ` A ${rx} ${r} 0 0 ${inner} ${cx} ${cy - r} Z`
}

registerValue('moon', ({ v }) => (
  <>
    <div class="dialbox">
      <svg class="dial disc" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet">
        <circle cx="50" cy="50" r="46" fill="#8883" />
        <path d={moonPath(v.illumination, v.waxing)} fill="currentColor" />
        <circle cx="50" cy="50" r="46" fill="none" stroke="currentColor"
                stroke-width="1.2" opacity=".6" />
      </svg>
    </div>
    <div class="csub">{v.brief}</div>
  </>
))

// NWS reports a period in whichever unit its office uses, so the value carries
// its own unit and the display setting converts from there.
function temp(v, unit, s) {
  if (v === null || v === undefined) return '—'
  const d = displayValue('temperature_' + unit, v, s)
  return d.num + d.unit
}

registerValue('forecastDay', ({ v }) => {
  const s = settings.value
  return (
    <>
      <div class="cfn">{v.label}</div>
      <div class="wx">
        <span class="glyph">{glyphOf(v.sky, v.night)}</span>
        <span class="hilo">
          <span class="hi">{temp(v.hi, v.unit, s)}</span>
          <span class="lo">{temp(v.lo, v.unit, s)}</span>
        </span>
      </div>
      <div class="csub">{v.pop > 0 ? `${v.pop}% rain` : v.text}</div>
    </>
  )
})

registerValue('now', ({ v }) => {
  const s = settings.value
  return (
    <>
      {v.place && <div class="cfn">{v.place}</div>}
      <div class="wx">
        <span class="glyph">{glyphOf(v.sky, v.night)}</span>
        <span class="big">{temp(v.temp, v.unit, s)}</span>
      </div>
      <div class="csub">{v.text}</div>
    </>
  )
})
