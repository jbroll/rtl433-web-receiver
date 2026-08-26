import { offsetMinutes, offsetText, isDST, formatTime } from '../zone.js'

function zoneLabel(date, zone) {
  const part = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    timeZoneName: 'short',
  }).formatToParts(date).find(p => p.type === 'timeZoneName')
  return part ? part.value : zone
}

export default {
  id: 'clock',
  topic: 'Clock',
  // The renderer reads the shared tick for seconds; this only has to keep the
  // date, offset and DST flag honest.
  interval: 60000,
  stamped: false,

  // Show the 12-hour clock by default; the 24-hour value is available from the devices table.
  defaultHidden: ['local_time_24'],

  run(ctx) {
    const now = new Date()
    const zone = ctx.zone
    const offset = offsetMinutes(now, zone)
    const label = zoneLabel(now, zone)

    return {
      fields: {
        local_time_12: {
          $r: 'clock',
          format: '12',
          label,
          zone,
          brief: formatTime(now, zone, { hour: '2-digit', minute: '2-digit', hour12: true }),
        },
        local_time_24: {
          $r: 'clock',
          format: '24',
          label,
          zone,
          brief: formatTime(now, zone, { hour: '2-digit', minute: '2-digit', hour12: false }),
        },
        date: formatTime(now, zone, { weekday: 'short', month: 'short', day: 'numeric' }),
        time_zone: zone,
        utc_offset: offsetText(offset),
        dst: isDST(now, zone) ? 'yes' : 'no',
      },
    }
  },
}
