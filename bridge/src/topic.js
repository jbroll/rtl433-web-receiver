export function validTopic(topic) {
  if (typeof topic !== 'string' || topic.length === 0) return false
  return (
    !topic.includes('+') &&
    !topic.includes('#') &&
    !topic.includes(' ') &&
    topic.split('/').every((segment) => segment.length > 0)
  )
}

export function validFilter(filter) {
  if (typeof filter !== 'string' || filter.length === 0) return false
  if (filter.includes(' ')) return false
  const segments = filter.split('/')
  return segments.every((segment, i) => {
    if (segment.length === 0) return false
    if (segment === '#') return i === segments.length - 1
    if (segment === '+') return true
    return !segment.includes('#') && !segment.includes('+')
  })
}

export function matchSplit(filterSegments, topicSegments) {
  for (let i = 0; i < filterSegments.length; i++) {
    if (filterSegments[i] === '#') return true
    if (i >= topicSegments.length) return false
    if (filterSegments[i] !== '+' && filterSegments[i] !== topicSegments[i]) return false
  }
  return filterSegments.length === topicSegments.length
}

export function matchFilter(filter, topic) {
  return matchSplit(filter.split('/'), topic.split('/'))
}
