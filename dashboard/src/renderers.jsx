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
const CX = 50, CY = 38, R = 30

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
      <div class="csub">{v.pop > 0 ? `${v.pop}% rain` : v.text || ''}</div>
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
      <div class="csub">{v.text || ''}</div>
    </>
  )
})
