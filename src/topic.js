export function validTopic(topic) {
  if (typeof topic !== 'string' || topic.length === 0) return false
  return !topic.includes('+') && !topic.includes('#') && !topic.includes(' ')
}

export function validFilter(filter) {
  if (typeof filter !== 'string' || filter.length === 0) return false
  if (filter.includes(' ')) return false
  const segments = filter.split('/')
  return segments.every((segment, i) => {
    if (segment === '#') return i === segments.length - 1
    if (segment === '+') return true
    return !segment.includes('#') && !segment.includes('+')
  })
}

export function matchFilter(filter, topic) {
  const f = filter.split('/')
  const t = topic.split('/')
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true
    if (i >= t.length) return false
    if (f[i] !== '+' && f[i] !== t[i]) return false
  }
  return f.length === t.length
}
