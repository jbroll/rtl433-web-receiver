import { matchSplit } from './topic.js'

const KEEPALIVE_MS = 15000

export function openStream(res, filters) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  })
  res.write(':open\n\n')

  let closed = false
  const keepalive = setInterval(() => {
    if (closed || !res.writable) return
    res.write(':keepalive\n\n')
  }, KEEPALIVE_MS)
  keepalive.unref()

  // Split once per connection rather than once per message: a stream's
  // filters never change (see architecture.md, "Filters are fixed per connection").
  const splitFilters = filters.map((filter) => filter.split('/'))

  const stream = {
    matches(topic) {
      const topicSegments = topic.split('/')
      return splitFilters.some((segments) => matchSplit(segments, topicSegments))
    },
    write(frame) {
      if (closed || !res.writable) return
      res.write(frame)
    },
    close() {
      if (closed) return
      closed = true
      clearInterval(keepalive)
      res.end()
    },
  }

  // The 'close' event only fires once Node notices the socket is gone, so a
  // write in between lands on a dead connection; an unhandled 'error' on the
  // response would otherwise crash the process.
  res.on('error', () => stream.close())

  return stream
}

// The frame is JSON, so this is the one place a payload has to become text.
// A payload that is not JSON is carried as the string it decodes to, so a
// foreign publisher on the broker cannot break the frame.
export function decode(payload) {
  const text = payload.toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
