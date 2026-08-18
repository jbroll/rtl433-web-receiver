import { sunEvents } from '../astro.js'
import { hhmm } from './zone.js'

// The scheduler caches fields through JSON, so a Date in a rich value would
// come back a string. Events ride as epoch ms instead.
const ms = d => (d === null ? null : d.getTime())

function lengthText(len) {
  const total = Math.round(len / 60000)
  return `${Math.floor(total / 60)}h ${total % 60}m`
}

export default {
  id: 'sun',
  topic: 'Sun',
  interval: 15 * 60000,
  stamped: false,

  run(ctx) {
    const e = sunEvents(new Date(), ctx.lat, ctx.lon)
    const z = ctx.zone
    const brief = e.alwaysUp ? 'up all day'
      : e.alwaysDown ? 'down all day'
        : `${hhmm(e.sunrise, z)} / ${hhmm(e.sunset, z)}`

    return {
      fields: {
        sun: {
          $r: 'sun',
          brief,
          sunrise: ms(e.sunrise),
          sunset: ms(e.sunset),
          solarNoon: ms(e.solarNoon),
          civilDawn: ms(e.civilDawn),
          civilDusk: ms(e.civilDusk),
          nauticalDawn: ms(e.nauticalDawn),
          nauticalDusk: ms(e.nauticalDusk),
          astroDawn: ms(e.astroDawn),
          astroDusk: ms(e.astroDusk),
          dayLength: e.dayLength,
          alwaysUp: e.alwaysUp,
          alwaysDown: e.alwaysDown,
        },
        sunrise: hhmm(e.sunrise, z),
        sunset: hhmm(e.sunset, z),
        solar_noon: hhmm(e.solarNoon, z),
        civil_dawn: hhmm(e.civilDawn, z),
        civil_dusk: hhmm(e.civilDusk, z),
        nautical_dawn: hhmm(e.nauticalDawn, z),
        nautical_dusk: hhmm(e.nauticalDusk, z),
        astro_dawn: hhmm(e.astroDawn, z),
        astro_dusk: hhmm(e.astroDusk, z),
        day_length: lengthText(e.dayLength),
      },
    }
  },
}
