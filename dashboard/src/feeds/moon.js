import { moonPhase, moonTimes } from '../astro.js'
import { hhmm } from '../zone.js'

export default {
  id: 'moon',
  topic: 'Moon',
  interval: 15 * 60000,
  stamped: false,

  // The disc already draws these. They stay available from the devices table.
  defaultHidden: ['moonrise', 'moonset', 'phase', 'illumination'],

  run(ctx) {
    const now = new Date()
    const p = moonPhase(now)
    const t = moonTimes(now, ctx.lat, ctx.lon, ctx.zone)
    const z = ctx.zone
    const pct = Math.round(p.illumination * 100)

    return {
      fields: {
        moon: {
          $r: 'moon',
          brief: `${p.name} ${pct}%`,
          riseText: hhmm(t.rise, z),
          setText: hhmm(t.set, z),
          illumination: p.illumination,
          phase: p.phase,
          waxing: p.waxing,
          name: p.name,
        },
        moonrise: hhmm(t.rise, z),
        moonset: hhmm(t.set, z),
        phase: p.name,
        moon_age: `${p.age.toFixed(1)} d`,
        // splitUnit only knows the % sign for `humidity`, so carry it in the string.
        illumination: `${pct}%`,
      },
    }
  },
}
