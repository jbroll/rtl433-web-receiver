// Intl reports a zone's offset only by formatting a date in it, so read the
// formatted parts back as if they were UTC and difference the two.
export function offsetMinutes(date, zone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date)
  const p = Object.create(null)
  for (const { type, value } of parts) p[type] = value
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second)
  return Math.round((asUTC - date.getTime()) / 60000)
}

export function offsetText(minutes) {
  const sign = minutes < 0 ? '-' : '+'
  const abs = Math.abs(minutes)
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
}

// There is no API for "is DST in effect". Comparing this offset against the
// smallest the zone uses across the year is right for the common cases and
// wrong for a zone that changed its rules mid-year, so the card shows the
// offset, which is always exact, and treats this as secondary.
export function isDST(date, zone) {
  const y = date.getUTCFullYear()
  const jan = offsetMinutes(new Date(Date.UTC(y, 0, 1)), zone)
  const jul = offsetMinutes(new Date(Date.UTC(y, 6, 1)), zone)
  return offsetMinutes(date, zone) > Math.min(jan, jul)
}

export function formatTime(date, zone, opts) {
  return new Intl.DateTimeFormat(undefined, { timeZone: zone, ...opts }).format(date)
}

export function hhmm(date, zone) {
  return date === null ? '—'
    : formatTime(date, zone, { hour: '2-digit', minute: '2-digit', hour12: false })
}
