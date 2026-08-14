import { matchFilter } from './topic.js'

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

  const stream = {
    filters,
    send(topic, payload) {
      if (closed || !res.writable) return
      if (!filters.some((filter) => matchFilter(filter, topic))) return
      res.write(`data: ${JSON.stringify({ topic, payload: decode(payload) })}\n\n`)
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

// A payload that is not JSON is carried as the string it is, so a foreign
// publisher on the broker cannot break the frame.
function decode(payload) {
  try {
    return JSON.parse(payload)
  } catch {
    return payload
  }
}
