import { offsetMinutes, offsetText, isDST, formatTime } from './zone.js'

export default {
  id: 'clock',
  topic: 'Clock',
  // The renderer reads the shared tick for seconds; this only has to keep the
  // date, offset and DST flag honest.
  interval: 60000,
  stamped: false,

  run(ctx) {
    const now = new Date()
    const zone = ctx.zone
    const offset = offsetMinutes(now, zone)

    return {
      fields: {
        local_time: { $r: 'clock', zone, brief: formatTime(now, zone, { hour: '2-digit', minute: '2-digit' }) },
        date: formatTime(now, zone, { weekday: 'short', month: 'short', day: 'numeric' }),
        time_zone: zone,
        utc_offset: offsetText(offset),
        dst: isDST(now, zone) ? 'yes' : 'no',
      },
    }
  },
}
