import http from 'node:http'

import { validTopic } from './topic.js'

export function createBridge({ broker, cache }) {
  const bridge = {
    httpServer: http.createServer((req, res) => handle(req, res, { broker, cache })),
    clients: new Set(),
    broadcast() {},
  }
  return bridge
}

async function handle(req, res, { broker, cache }) {
  const url = new URL(req.url, 'http://bridge.invalid')
  const topic = decodeURIComponent(url.pathname.slice(1))

  if (!broker.connected()) return send(res, 503, 'broker unavailable')
  if (!validTopic(topic)) return send(res, 400, 'malformed topic')

  if (req.method === 'GET') {
    const payload = cache.get(topic)
    if (payload === undefined) return send(res, 404, 'no message')
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(payload)
  }

  if (req.method === 'POST') {
    const body = await readBody(req)
    try {
      JSON.parse(body)
    } catch {
      return send(res, 400, 'body is not JSON')
    }
    await broker.publish(topic, body)
    res.writeHead(204)
    return res.end()
  }

  return send(res, 405, 'method not allowed')
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
