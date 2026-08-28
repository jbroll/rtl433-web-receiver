import { registerValue } from './render-values.js'
import { tick } from './tick.js'
import { displayValue, fmtValue } from './units.js'
import { settings } from './settings.js'
import { glyphOf } from './feeds/wx-icons.js'
import { textWidthEm } from './grid.js'
import { zoneFormatter } from './zone.js'

// Imported for its registrations, so a renderer is reachable by tag before the
// first card renders. Components live here rather than beside the registry so
// the registry stays plain JS that `node --test` can import.

// A rich cell sizes its own type instead of joining the page-wide fit, so it
// fills its cell the way the dials do. The height term is the slot's share of
// the cell; the width term is what the measured string costs at that size.
// Whichever runs out first sets the size.
function fitFont(heightCqh, widthEm) {
  return `max(11px,min(${heightCqh}cqh,${(96 / widthEm).toFixed(1)}cqw))`
}

// Emoji come from a fallback font the probe cannot measure reliably, so hold
// the result to the range a weather glyph actually occupies.
function glyphEm(g) {
  return Math.min(1.4, Math.max(0.9, textWidthEm(g)))
}

registerValue('text', ({ v }) => (
  <>
    {v.label && <div class="cfn">{v.label}</div>}
    <div class="ctext">{v.text}</div>
  </>
))

// The shared tick keeps the displayed minute current without a separate timer.
registerValue('clock', ({ v }) => {
  tick.value
  const now = new Date()
  const parts = zoneFormatter(v.zone, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: v.format === '12',
  }).formatToParts(now)

  const time = parts
    .filter(p => p.type === 'hour' || p.type === 'literal' || p.type === 'minute')
    .map(p => p.value)
    .join('')

  const ampm = parts.find(p => p.type === 'dayPeriod')?.value

  return (
    <>
      <div class="cfn">
        <span>{v.label}</span>
        {ampm && <span>{ampm}</span>}
      </div>
      {/* A trailing literal from the 12-hour format collapses when drawn, so
          the measured string has to drop it too. */}
      <div class="big" style={{ fontSize: fitFont(76, textWidthEm(time.trim())) }}>{time}</div>
    </>
  )
})

const DAY = 86400000
const CX = 50, CY = 38, R = 30

// Where the sun sits on the dial: 180°..360° tracks sunrise to sunset over the
// top, 0°..180° tracks the night under the horizon.
function sunAngle(v, now) {
  if (v.alwaysUp) return 270
  if (v.alwaysDown) return 90
  if (!v.dayLength) return 90
  // A day whose sunrise fell before local midnight still has a sunset and a
  // daylight span, so the arc can be walked back from its end.
  const rise = v.sunrise === null
    ? (v.sunset === null ? null : v.sunset - v.dayLength)
    : v.sunrise
  if (rise === null) return 90
  const into = ((now - rise) % DAY + DAY) % DAY
  if (into <= v.dayLength) return 180 + 180 * (into / v.dayLength)
  return 180 * (into - v.dayLength) / (DAY - v.dayLength)
}

// Both dials draw their times inside the SVG rather than beside it, so the
// whole composite scales as one unit and one cell tells the whole story. Type
// sizes are set so the longest string each slot can hold still fits the
// viewBox; overflow would be clipped by the cell, not scaled away.
registerValue('sun', ({ v }) => {
  tick.value
  const a = sunAngle(v, Date.now()) * Math.PI / 180
  const x = CX + R * Math.cos(a)
  const y = CY + R * Math.sin(a)
  const up = y <= CY
  const band = deg => R * deg / 90

  return (
    <div class="dialbox">
      <svg class="dial" viewBox="0 0 100 58" preserveAspectRatio="xMidYMid meet">
        <rect x="4" y={CY} width="92" height={band(18)} fill="#8882" />
        <rect x="4" y={CY} width="92" height={band(12)} fill="#8882" />
        <rect x="4" y={CY} width="92" height={band(6)} fill="#8882" />
        <path d={`M ${CX - R} ${CY} A ${R} ${R} 0 0 1 ${CX + R} ${CY}`}
              fill="none" stroke="currentColor" stroke-width="1.2" opacity=".55" />
        <line x1="4" y1={CY} x2="96" y2={CY} stroke="currentColor" stroke-width="1" opacity=".5" />
        {/* Only when there is no rise or set to name: otherwise this sits in
            the sun marker's path across the arc. */}
        {!v.riseText && (
          <text x={CX} y="32" font-size="9" fill="currentColor" opacity=".6" text-anchor="middle">
            {v.brief}
          </text>
        )}
        <circle cx={x} cy={y} r="4.5" fill={up ? 'currentColor' : 'none'}
                stroke="currentColor" stroke-width="1.4" />
        <text x="4" y="54" font-size="10" fill="currentColor">
          {v.riseText && `\u2191 ${v.riseText}`}
        </text>
        <text x="96" y="54" font-size="10" fill="currentColor" text-anchor="end">
          {v.setText && `\u2193 ${v.setText}`}
        </text>
      </svg>
    </div>
  )
})

// The terminator is a half ellipse whose width falls to zero at the quarters;
// its sweep flips at half illumination, where the shape turns from crescent
// to gibbous.
function moonPath(k, waxing, cx, cy, r) {
  const rx = Math.max(0.01, r * Math.abs(1 - 2 * k))
  const outer = waxing ? 1 : 0
  const inner = k > 0.5 ? outer : 1 - outer
  return `M ${cx} ${cy - r} A ${r} ${r} 0 0 ${outer} ${cx} ${cy + r}` +
         ` A ${rx} ${r} 0 0 ${inner} ${cx} ${cy - r} Z`
}

const MCX = 22, MCY = 24, MR = 19

// A cached value outlives the code that wrote it, so a field added later can
// be missing here. Reading around it beats printing "undefined" on the card.
const timeOf = t => (typeof t === 'string' && t ? t : '\u2014')

registerValue('moon', ({ v }) => (
  <div class="dialbox">
    <svg class="dial disc" viewBox="0 0 100 58" preserveAspectRatio="xMidYMid meet">
      {/* Heavier than the #8883 used elsewhere, so the lit limb reads
          against it on a light background as well as a dark one. */}
      <circle cx={MCX} cy={MCY} r={MR} fill="#8889" />
      {/* The lit limb is a fixed pale colour, not currentColor: the moon is
          pale under either theme, and drawing the lit part in the text
          colour makes it read as the shadow on a light background. */}
      <path d={moonPath(v.illumination, v.waxing, MCX, MCY, MR)} fill="#e8e3d6" />
      <circle cx={MCX} cy={MCY} r={MR} fill="none" stroke="currentColor"
              stroke-width="1.2" opacity=".6" />
      <text x="48" y="20" font-size="11" fill="currentColor">{`\u2191 ${timeOf(v.riseText)}`}</text>
      <text x="48" y="36" font-size="11" fill="currentColor">{`\u2193 ${timeOf(v.setText)}`}</text>
      <text x="50" y="54" font-size="8" fill="currentColor" opacity=".7" text-anchor="middle">
        {`${v.name || ''} ${Math.round((v.illumination || 0) * 100)}%`.trim()}
      </text>
    </svg>
  </div>
))

// NWS reports a period in whichever unit its office uses, so the value carries
// its own unit and the display setting converts from there.
function temp(v, unit, s) {
  if (v === null || v === undefined) return '—'
  const d = displayValue('temperature_' + unit, v, s)
  return d.num + d.unit
}

// The glyph and the hi/lo stack share the row, and the stack's own two lines
// set its height, so both terms carry the sizes the CSS gives those parts.
const fcEm = (g, hi, lo) =>
  glyphEm(g) + 0.4 + Math.max(0.8 * textWidthEm(hi), 0.55 * textWidthEm(lo))

const nowEm = (g, t) => 0.9 * glyphEm(g) + 0.4 + textWidthEm(t)

registerValue('forecastDay', ({ v }) => {
  const s = settings.value
  const g = glyphOf(v.sky, v.night)
  const hi = temp(v.hi, v.unit, s)
  const lo = temp(v.lo, v.unit, s)
  return (
    <>
      <div class="cfn">{v.label}</div>
      <div class="wx" style={{ fontSize: fitFont(48, fcEm(g, hi, lo)) }}>
        <span class="glyph">{g}</span>
        <span class="hilo">
          <span class="hi">{hi}</span>
          <span class="lo">{lo}</span>
        </span>
      </div>
      <div class="csub">{v.pop > 0 ? `${v.pop}% rain` : v.text || ''}</div>
    </>
  )
})

// The station a point resolves to can be a long way off; the distance the
// stations lookup already carries is what makes that legible at a glance.
function stationText(v, s) {
  if (!v.station) return ''
  if (typeof v.stationDistanceM !== 'number') return v.station
  const mi = s && s.custom && s.custom.wind === 'mi/h'
  const dist = mi ? v.stationDistanceM / 1609.344 : v.stationDistanceM / 1000
  return `${v.station} · ${fmtValue(dist, 0)} ${mi ? 'mi' : 'km'}`
}

registerValue('now', ({ v }) => {
  const s = settings.value
  const g = glyphOf(v.sky, v.night)
  const t = temp(v.temp, v.unit, s)
  const station = stationText(v, s)
  return (
    <>
      {v.place && <div class="cfn">{v.place}</div>}
      <div class="wx now" style={{ fontSize: fitFont(62, nowEm(g, t)) }}>
        <span class="glyph">{g}</span>
        <span class="big">{t}</span>
      </div>
      <div class="csub">{v.text || ''}</div>
      {station && <div class="csub station">{station}</div>}
    </>
  )
})
