import http from 'node:http'

import { openStream } from './sse.js'
import { validFilter, validTopic } from './topic.js'

export function createBridge({ broker, cache }) {
  const clients = new Set()

  const bridge = {
    httpServer: http.createServer((req, res) => {
      handle(req, res, { broker, cache, clients }).catch(() => {
        try {
          if (res.headersSent) res.end()
          else send(res, 500, 'internal error')
        } catch {
          // the socket is already gone; nothing left to do
        }
      })
    }),
    clients,
    broadcast(topic, payload) {
      for (const client of clients) client.send(topic, payload)
    },
  }
  return bridge
}

async function handle(req, res, { broker, cache, clients }) {
  const url = new URL(req.url, 'http://bridge.invalid')

  if (url.pathname === '/events') {
    if (req.method !== 'GET') return send(res, 405, 'method not allowed')
    if (!broker.connected()) return send(res, 503, 'broker unavailable')
    return subscribe(req, res, { cache, clients, url })
  }

  let topic
  try {
    topic = decodeURIComponent(url.pathname.slice(1))
  } catch (err) {
    if (err instanceof URIError) return send(res, 400, 'malformed topic')
    throw err
  }

  if (!validTopic(topic)) return send(res, 400, 'malformed topic')

  if (!broker.connected()) return send(res, 503, 'broker unavailable')

  if (req.method === 'GET') {
    const payload = cache.get(topic)
    if (payload === undefined) return send(res, 404, 'no message')
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(payload)
  }

  if (req.method === 'POST') {
    let body
    try {
      body = await readBody(req)
    } catch {
      return
    }
    try {
      JSON.parse(body)
    } catch {
      return send(res, 400, 'body is not JSON')
    }
    try {
      await broker.publish(topic, body)
    } catch {
      // connected() was true a moment ago; the binding has no code for a
      // publish that fails for any other reason.
      return send(res, 503, 'broker unavailable')
    }
    // The broker echoes the publish back over the '#' subscription a round
    // trip later; caching it here is what makes a GET right after a 204 hit.
    cache.set(topic, body)
    res.writeHead(204)
    return res.end()
  }

  return send(res, 405, 'method not allowed')
}

function subscribe(req, res, { cache, clients, url }) {
  const filters = url.searchParams.getAll('f')
  if (filters.length === 0) filters.push('#')
  if (!filters.every(validFilter)) return send(res, 400, 'malformed filter')

  const client = openStream(res, filters)
  clients.add(client)
  req.on('close', () => {
    clients.delete(client)
    client.close()
  })

  const replayed = new Set()
  for (const filter of filters) {
    for (const [topic, payload] of cache.match(filter)) {
      if (replayed.has(topic)) continue
      replayed.add(topic)
      client.send(topic, payload)
    }
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

function send(res, status, message) {
  res.writeHead(status, { 'content-type': 'text/plain' })
  res.end(`${message}\n`)
}
