import http from 'node:http'

import { tokenMatches } from './auth.js'
import { openStream } from './sse.js'
import { validFilter, validTopic } from './topic.js'

export function createBridge({ broker, cache, authToken }) {
  const clients = new Set()

  const bridge = {
    httpServer: http.createServer((req, res) => {
      handle(req, res, { broker, cache, clients, authToken }).catch(() => {
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

async function handle(req, res, { broker, cache, clients, authToken }) {
  const url = new URL(req.url, 'http://bridge.invalid')

  // The dashboard is served from a different origin than any bridge it reads,
  // and there is no authentication here for an origin check to protect.
  res.setHeader('access-control-allow-origin', '*')

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '600',
    })
    return res.end()
  }

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
    // An empty body is not the JSON the binding says a 200 carries, and a
    // retained delete the broker forwarded live is cached as exactly that.
    if (payload === undefined || payload.length === 0) return send(res, 404, 'no message')
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(payload)
  }

  if (req.method === 'POST') {
    if (authToken && !authorized(req, authToken)) return send(res, 401, 'unauthorized')

    let body
    try {
      body = await readBody(req)
    } catch {
      return
    }
    try {
      JSON.parse(body.toString('utf8'))
    } catch {
      return send(res, 400, 'body is not JSON')
    }
    try {
      // This resolves when the broker has echoed the publish back, which is
      // what has written it to the cache. Nothing is written here: a second
      // writer lets a late echo of an earlier publish overwrite a newer one.
      await broker.publish(topic, body)
    } catch {
      // The publish never came back, so the broker did not take it.
      return send(res, 503, 'broker unavailable')
    }
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

// The body is kept as bytes: it is published and cached unchanged, and
// decoding it would replace any byte that is not valid UTF-8.
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function send(res, status, message) {
  res.writeHead(status, { 'content-type': 'text/plain' })
  res.end(`${message}\n`)
}

function authorized(req, authToken) {
  const header = req.headers['authorization']
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false
  return tokenMatches(header.slice('Bearer '.length), authToken)
}
