import { matchFilter } from './topic.js'

const KEEPALIVE_MS = 15000

export function openStream(res, filters) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  })
  res.write(':open\n\n')

  const keepalive = setInterval(() => res.write(':keepalive\n\n'), KEEPALIVE_MS)
  keepalive.unref()

  return {
    filters,
    send(topic, payload) {
      if (!filters.some((filter) => matchFilter(filter, topic))) return
      res.write(`data: ${JSON.stringify({ topic, payload: decode(payload) })}\n\n`)
    },
    close() {
      clearInterval(keepalive)
      res.end()
    },
  }
}

// A payload that is not JSON is carried as the string it is, so a foreign
// publisher on the broker cannot break the frame.
function decode(payload) {
  try {
    return JSON.parse(payload)
  } catch {
    return payload
  }
}
