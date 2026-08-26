import http from 'node:http'

import { digestMatches } from './auth.js'
import { openStream } from './sse.js'
import { validFilter, validTopic } from './topic.js'
import { createTokenStore } from './token-store.js'

// A cap far above any real payload: the largest binding message, $layout,
// runs a few hundred bytes.
export const BODY_LIMIT_BYTES = 64 * 1024

// Counted from the last byte received, not the request start, so a slow but
// steady uplink is not punished for taking a while overall.
export const BODY_IDLE_TIMEOUT_MS = 30_000

export function createBridge({
  broker,
  cache,
  authToken,
  tokenStore,
  dashboardHtml,
  bodyLimitBytes = BODY_LIMIT_BYTES,
  bodyIdleTimeoutMs = BODY_IDLE_TIMEOUT_MS,
}) {
  const clients = new Set()
  const tokens = tokenStore ?? createTokenStore(authToken)

  const bridge = {
    httpServer: http.createServer((req, res) => {
      const ctx = { broker, cache, clients, tokens, dashboardHtml, bodyLimitBytes, bodyIdleTimeoutMs }
      handle(req, res, ctx).catch(() => {
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
    waiting: () => broker.waiting(),
  }
  return bridge
}

async function handle(
  req,
  res,
  { broker, cache, clients, tokens, dashboardHtml, bodyLimitBytes, bodyIdleTimeoutMs },
) {
  const url = new URL(req.url, 'http://bridge.invalid')

  // The dashboard is served from a different origin than any bridge it reads.
  // A wildcard origin adds nothing an attacker doesn't already lack: with
  // AUTH_TOKEN set, POST still requires the bearer token regardless of
  // origin, and a wildcard-origin caller has no way to know or attach it.
  res.setHeader('access-control-allow-origin', '*')

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization',
      'access-control-max-age': '600',
    })
    return res.end()
  }

  // '/' is never a valid topic (topic.js rejects the empty string), so this
  // cannot shadow any real topic GET, the same way the receiver firmware
  // special-cases "/" for its own embedded dashboard.
  if (url.pathname === '/' && (req.method === 'GET' || req.method === 'HEAD') && dashboardHtml) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    return res.end(req.method === 'HEAD' ? undefined : dashboardHtml)
  }

  if (url.pathname === '/events') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed', { allow: 'GET' })
    if (!broker.connected()) return send(res, 503, 'broker unavailable')
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
      return res.end()
    }
    return subscribe(req, res, { cache, clients, url })
  }

  // Reserved the same way '/events' is: never a topic a source publishes to
  // in practice, and gated ahead of topic parsing so it can't collide with one.
  if (url.pathname === '/auth/rotate') {
    if (req.method !== 'POST') return send(res, 405, 'method not allowed', { allow: 'POST' })
    // Nothing to rotate: a deployment with no AUTH_TOKEN has no auth surface
    // to expose here either, so this is "not found," not "not authorized."
    if (!tokens.get()) return send(res, 404, 'not found')
    if (!authorized(req, tokens.digest())) return send(res, 401, 'unauthorized')

    let body
    try {
      body = await readBody(req, { limitBytes: bodyLimitBytes, idleTimeoutMs: bodyIdleTimeoutMs })
    } catch (err) {
      return respondToBodyError(req, res, err)
    }
    let parsed
    try {
      parsed = parseJson(body)
    } catch (err) {
      return send(res, 400, err.message)
    }
    const hasToken = typeof parsed === 'object' && parsed !== null && typeof parsed.token === 'string'
    if (!hasToken || parsed.token.trim().length === 0) {
      return send(res, 400, 'token must be a non-empty string')
    }
    tokens.rotate(parsed.token)
    res.writeHead(204)
    return res.end()
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

  if (req.method === 'GET' || req.method === 'HEAD') {
    const payload = cache.get(topic)
    // An empty body is not the JSON the binding says a 200 carries, and a
    // retained delete the broker forwarded live is cached as exactly that.
    if (payload === undefined || payload.length === 0) return send(res, 404, 'no message')
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': payload.length })
    return res.end(req.method === 'HEAD' ? undefined : payload)
  }

  if (req.method === 'POST') {
    if (tokens.get() && !authorized(req, tokens.digest())) return send(res, 401, 'unauthorized')

    let body
    try {
      body = await readBody(req, { limitBytes: bodyLimitBytes, idleTimeoutMs: bodyIdleTimeoutMs })
    } catch (err) {
      return respondToBodyError(req, res, err)
    }
    try {
      parseJson(body)
    } catch (err) {
      return send(res, 400, err.message)
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

  return send(res, 405, 'method not allowed', { allow: 'GET, POST' })
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

class BodyTooLargeError extends Error {}
class BodyIdleTimeoutError extends Error {}

// req.destroy() closes the socket, so it runs after the response is written,
// not before: destroying first leaves nothing left to send the status on.
function respondToBodyError(req, res, err) {
  if (err instanceof BodyTooLargeError) {
    send(res, 413, 'body too large')
    return req.destroy()
  }
  if (err instanceof BodyIdleTimeoutError) {
    send(res, 408, 'request timed out')
    return req.destroy()
  }
  // The client hung up; there is no one left to answer.
}

// The body is kept as bytes: it is published and cached unchanged, and
// decoding it would replace any byte that is not valid UTF-8.
function readBody(req, { limitBytes, idleTimeoutMs }) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let length = 0
    let timer
    let settled = false

    const settle = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      req.pause()
      fn(value)
    }

    const armTimer = () => {
      clearTimeout(timer)
      timer = setTimeout(() => settle(reject, new BodyIdleTimeoutError()), idleTimeoutMs)
    }

    armTimer()
    req.on('data', (chunk) => {
      if (settled) return
      length += chunk.length
      if (length > limitBytes) return settle(reject, new BodyTooLargeError())
      chunks.push(chunk)
      armTimer()
    })
    req.on('end', () => settle(resolve, Buffer.concat(chunks)))
    req.on('error', (err) => settle(reject, err))
  })
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

function parseJson(body) {
  let text
  try {
    text = utf8Decoder.decode(body)
  } catch (err) {
    if (err instanceof TypeError) throw Object.assign(new Error('body is not UTF-8'), { cause: err })
    throw err
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('body is not JSON')
  }
}

function send(res, status, message, headers) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers })
  res.end(`${message}\n`)
}

function authorized(req, expectedDigest) {
  const header = req.headers['authorization']
  if (typeof header !== 'string' || !/^Bearer /i.test(header)) return false
  return digestMatches(header.slice('Bearer '.length), expectedDigest)
}
