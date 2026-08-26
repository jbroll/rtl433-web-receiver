import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'

import mqtt from 'mqtt'

import { createCache } from '../src/cache.js'
import { BODY_LIMIT_BYTES, createBridge } from '../src/server.js'
import { startBridge, waitFor, withTimeout } from './helpers/bridge.js'
import { startBroker } from './helpers/broker.js'

test('a POST without a token is 401 when AUTH_TOKEN is set, and the topic is left alone', async () => {
  const bridge = await startBridge({ authToken: 's3cr3t' })
  try {
    const unauthed = await fetch(`${bridge.base}/src/Acurite/1234`, {
      method: 'POST',
      body: '{"a":1}',
    })
    assert.equal(unauthed.status, 401)
    assert.equal((await fetch(`${bridge.base}/src/Acurite/1234`)).status, 404)
  } finally {
    await bridge.close()
  }
})

test('a POST with the wrong token is 401', async () => {
  const bridge = await startBridge({ authToken: 's3cr3t' })
  try {
    const wrong = await fetch(`${bridge.base}/src/Acurite/1234`, {
      method: 'POST',
      body: '{"a":1}',
      headers: { authorization: 'Bearer wrong' },
    })
    assert.equal(wrong.status, 401)
  } finally {
    await bridge.close()
  }
})

test('a POST with the right bearer token is 204, same as with no AUTH_TOKEN configured', async () => {
  const bridge = await startBridge({ authToken: 's3cr3t' })
  try {
    const ok = await fetch(`${bridge.base}/src/Acurite/1234`, {
      method: 'POST',
      body: '{"a":1}',
      headers: { authorization: 'Bearer s3cr3t' },
    })
    assert.equal(ok.status, 204)
    assert.equal(await (await fetch(`${bridge.base}/src/Acurite/1234`)).text(), '{"a":1}')
  } finally {
    await bridge.close()
  }
})

test('GET is never gated, even with AUTH_TOKEN set', async () => {
  const bridge = await startBridge({ authToken: 's3cr3t' })
  try {
    await fetch(`${bridge.base}/src/Acurite/1234`, {
      method: 'POST',
      body: '{"a":1}',
      headers: { authorization: 'Bearer s3cr3t' },
    })
    const got = await fetch(`${bridge.base}/src/Acurite/1234`)
    assert.equal(got.status, 200)

    const stream = await fetch(`${bridge.base}/events`)
    assert.equal(stream.status, 200)
    await stream.body.cancel()
  } finally {
    await bridge.close()
  }
})

test('a topic with no message is 404, and a POST makes it readable byte for byte', async () => {
  const bridge = await startBridge()
  try {
    const body = '{"temperature_C":21.4,"humidity":48}'

    const missing = await fetch(`${bridge.base}/src/Acurite/1234`)
    assert.equal(missing.status, 404)

    const posted = await fetch(`${bridge.base}/src/Acurite/1234`, { method: 'POST', body })
    assert.equal(posted.status, 204)

    const got = await fetch(`${bridge.base}/src/Acurite/1234`)
    assert.equal(got.headers.get('content-type'), 'application/json')
    assert.equal(await got.text(), body)
  } finally {
    await bridge.close()
  }
})

test('a non-JSON body is 400 and leaves the retained message alone', async () => {
  const bridge = await startBridge()
  try {
    await fetch(`${bridge.base}/src/Acurite/1234`, { method: 'POST', body: '{"a":1}' })

    const bad = await fetch(`${bridge.base}/src/Acurite/1234`, { method: 'POST', body: 'not json' })
    assert.equal(bad.status, 400)

    const got = await fetch(`${bridge.base}/src/Acurite/1234`)
    assert.equal(await got.text(), '{"a":1}')
  } finally {
    await bridge.close()
  }
})

test('a wildcard in a topic is 400 and an unsupported method is 405', async () => {
  const bridge = await startBridge()
  try {
    assert.equal((await fetch(`${bridge.base}/src/+/1234`)).status, 400)
    assert.equal((await fetch(`${bridge.base}/`)).status, 400)
    const deleted = await fetch(`${bridge.base}/src/Acurite/1234`, { method: 'DELETE' })
    assert.equal(deleted.status, 405)
    assert.equal(deleted.headers.get('allow'), 'GET, POST')
  } finally {
    await bridge.close()
  }
})

test('a 405 carries Allow naming the methods that endpoint does offer', async () => {
  const bridge = await startBridge()
  try {
    const events = await fetch(`${bridge.base}/events`, { method: 'POST' })
    assert.equal(events.status, 405)
    assert.equal(events.headers.get('allow'), 'GET')

    const rotate = await fetch(`${bridge.base}/auth/rotate`, { method: 'GET' })
    assert.equal(rotate.status, 405)
    assert.equal(rotate.headers.get('allow'), 'POST')
  } finally {
    await bridge.close()
  }
})

test('HEAD matches GET status for a topic, with an empty body and no stream registered', async () => {
  const bridge = await startBridge()
  try {
    const missing = await fetch(`${bridge.base}/src/Acurite/1234`, { method: 'HEAD' })
    assert.equal(missing.status, 404)
    assert.equal(await missing.text(), '')

    await fetch(`${bridge.base}/src/Acurite/1234`, { method: 'POST', body: '{"a":1}' })

    const got = await fetch(`${bridge.base}/src/Acurite/1234`, { method: 'HEAD' })
    assert.equal(got.status, 200)
    assert.equal(got.headers.get('content-length'), '7')
    assert.equal(await got.text(), '')
  } finally {
    await bridge.close()
  }
})

test('HEAD / serves the dashboard headers with an empty body', async () => {
  const bridge = await startBridge({ dashboardHtml: '<html>dashboard</html>' })
  try {
    const head = await fetch(`${bridge.base}/`, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.headers.get('content-type'), 'text/html; charset=utf-8')
    assert.equal(await head.text(), '')
  } finally {
    await bridge.close()
  }
})

test('HEAD /events does not leave a stream registered', async () => {
  const bridge = await startBridge()
  try {
    const head = await fetch(`${bridge.base}/events`, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(bridge.clients.size, 0)
  } finally {
    await bridge.close()
  }
})

test('GET / serves the dashboard when configured, and topic routing is unaffected', async () => {
  const bridge = await startBridge({ dashboardHtml: '<html>dashboard</html>' })
  try {
    const root = await fetch(`${bridge.base}/`)
    assert.equal(root.status, 200)
    assert.equal(root.headers.get('content-type'), 'text/html; charset=utf-8')
    assert.equal(await root.text(), '<html>dashboard</html>')

    assert.equal((await fetch(`${bridge.base}/`, { method: 'POST', body: '{}' })).status, 400)
    assert.equal((await fetch(`${bridge.base}/src/Acurite/1234`)).status, 404)
  } finally {
    await bridge.close()
  }
})

test('an alias round-trips, and a device without one has no alias topic', async () => {
  const bridge = await startBridge()
  try {
    const unnamed = await fetch(`${bridge.base}/src/Acurite/1234/$alias`)
    assert.equal(unnamed.status, 404)

    await fetch(`${bridge.base}/src/Acurite/1234/$alias`, { method: 'POST', body: '"Back fence"' })

    const got = await fetch(`${bridge.base}/src/Acurite/1234/$alias`)
    assert.equal(await got.text(), '"Back fence"')
  } finally {
    await bridge.close()
  }
})

test('a malformed percent-escape in the path is 400, and the bridge survives to serve the next request', async () => {
  const bridge = await startBridge()
  try {
    const malformed = await fetch(`${bridge.base}/%E0%A4%A`)
    assert.equal(malformed.status, 400)

    const missing = await fetch(`${bridge.base}/src/Acurite/1234`)
    assert.equal(missing.status, 404)
  } finally {
    await bridge.close()
  }
})

test('a client that hangs up mid-body does not take the bridge down with it', async () => {
  const bridge = await startBridge()
  try {
    const { hostname, port } = new URL(bridge.base)

    const socket = net.connect(Number(port), hostname)
    try {
      await new Promise((resolve, reject) => {
        socket.once('connect', resolve)
        socket.once('error', reject)
      })

      const body = '{"a":1}'
      socket.write(
        `POST /src/Acurite/1234 HTTP/1.1\r\n` +
          `Host: ${hostname}\r\n` +
          `Content-Length: ${body.length + 10}\r\n` +
          `Connection: close\r\n\r\n` +
          body.slice(0, 3),
      )
    } finally {
      socket.destroy()
    }

    const after = await fetch(`${bridge.base}/src/Acurite/1234`)
    assert.equal(after.status, 404)
  } finally {
    await bridge.close()
  }
})

test('every request is 503 once the broker is gone', async () => {
  const bridge = await startBridge()
  try {
    await fetch(`${bridge.base}/src/Acurite/1234`, { method: 'POST', body: '{"a":1}' })

    await bridge.stopBroker()
    await waitFor(async () => (await fetch(`${bridge.base}/src/Acurite/1234`)).status === 503)

    assert.equal((await fetch(`${bridge.base}/events`)).status, 503)
  } finally {
    await bridge.close()
  }
})

test('a malformed percent-escape is 400 even when the broker is down', async () => {
  const bridge = await startBridge()
  try {
    await bridge.stopBroker()

    const malformed = await fetch(`${bridge.base}/%E0%A4%A`)
    assert.equal(malformed.status, 400)
  } finally {
    await bridge.close()
  }
})

test('a publish the broker rejects is 503, and caches nothing', async () => {
  const cache = createCache()
  const bridge = createBridge({
    broker: {
      connected: () => true,
      publish: () => Promise.reject(new Error('broker went away mid-publish')),
    },
    cache,
  })
  await new Promise((resolve) => bridge.httpServer.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${bridge.httpServer.address().port}`
  try {
    const posted = await fetch(`${base}/src/Acurite/1234`, { method: 'POST', body: '{"a":1}' })
    assert.equal(posted.status, 503)
    assert.equal((await fetch(`${base}/src/Acurite/1234`)).status, 404)
  } finally {
    await new Promise((resolve) => bridge.httpServer.close(resolve))
  }
})

test('an unreachable broker at startup serves 503, then serves once it appears', async () => {
  const port = await freePort()
  const bridge = await startBridge({ url: `mqtt://127.0.0.1:${port}` })
  let mqttBroker
  try {
    assert.equal((await fetch(`${bridge.base}/src/Acurite/1234`)).status, 503)
    assert.equal((await fetch(`${bridge.base}/events`)).status, 503)

    mqttBroker = await startBroker(port)
    await withTimeout(bridge.broker.subscribed, 5000, 'the # subscription')

    const posted = await fetch(`${bridge.base}/src/Acurite/1234`, { method: 'POST', body: '{"a":1}' })
    assert.equal(posted.status, 204)
    assert.equal((await fetch(`${bridge.base}/src/Acurite/1234`)).status, 200)
  } finally {
    await bridge.close()
    if (mqttBroker) await mqttBroker.close()
  }
})

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

test('a retained delete seen live leaves the topic 404, not an empty 200', async () => {
  const bridge = await startBridge()
  const foreign = await mqtt.connectAsync(bridge.mqttUrl)
  try {
    await fetch(`${bridge.base}/src/Acurite/1234`, { method: 'POST', body: '{"a":1}' })
    assert.equal((await fetch(`${bridge.base}/src/Acurite/1234`)).status, 200)

    await foreign.publishAsync('src/Acurite/1234', '', { qos: 0, retain: true })
    // The empty publish is in flight; a later publish the bridge can see
    // arriving is what says the first one has been handled too.
    await foreign.publishAsync('src/Marker/1', '{"seen":true}', { qos: 0, retain: false })
    await waitFor(async () => (await fetch(`${bridge.base}/src/Marker/1`)).status === 200)

    // The broker cleared the retain flag on the way out, so the bridge cached
    // an empty message rather than dropping the topic.
    assert.deepEqual(bridge.cache.get('src/Acurite/1234'), Buffer.alloc(0))
    assert.equal((await fetch(`${bridge.base}/src/Acurite/1234`)).status, 404)
  } finally {
    await foreign.endAsync()
    await bridge.close()
  }
})

test('a payload with a non-UTF-8 byte comes back byte for byte', async () => {
  const bridge = await startBridge()
  try {
    const payload = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d])

    await bridge.broker.publish('src/Acurite/1234', payload)
    // Nothing local wrote this one; it arrives on the '#' subscription.
    await waitFor(async () => (await fetch(`${bridge.base}/src/Acurite/1234`)).status === 200)

    const got = await fetch(`${bridge.base}/src/Acurite/1234`)
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), payload)
  } finally {
    await bridge.close()
  }
})

test('a POST body over the cap is 413, and the topic is left alone', async () => {
  const bridge = await startBridge()
  try {
    const oversized = Buffer.alloc(BODY_LIMIT_BYTES + 1, 0x61)
    const posted = await fetch(`${bridge.base}/src/Acurite/1234`, { method: 'POST', body: oversized })
    assert.equal(posted.status, 413)
    assert.equal((await fetch(`${bridge.base}/src/Acurite/1234`)).status, 404)
  } finally {
    await bridge.close()
  }
})

test('a POST body sent as a slow drip past the idle timeout is 408', async () => {
  const bridge = await startBridge({ bodyIdleTimeoutMs: 100 })
  try {
    const { port } = new URL(bridge.base)
    const status = await new Promise((resolve, reject) => {
      const socket = net.connect(Number(port), '127.0.0.1', () => {
        socket.write('POST /src/Acurite/1234 HTTP/1.1\r\nHost: x\r\nContent-Length: 20\r\n\r\n')
        socket.write('{"a":')
      })
      let response = ''
      socket.on('data', (chunk) => (response += chunk.toString()))
      socket.on('close', () => resolve(response.split(' ')[1]))
      socket.on('error', reject)
    })
    assert.equal(status, '408')
  } finally {
    await bridge.close()
  }
})

test('a body with a stray non-UTF-8 byte is 400 and nothing reaches the cache', async () => {
  const bridge = await startBridge()
  try {
    const body = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0x80, 0x22, 0x7d])
    const posted = await fetch(`${bridge.base}/src/Acurite/1234`, { method: 'POST', body })
    assert.equal(posted.status, 400)
    assert.equal((await fetch(`${bridge.base}/src/Acurite/1234`)).status, 404)
  } finally {
    await bridge.close()
  }
})

test('a second POST to a topic is what a GET returns, on a slow link', async () => {
  const bridge = await startBridge({ delayMs: 40 })
  try {
    await fetch(`${bridge.base}/src/Acurite/1234`, { method: 'POST', body: '{"t":1}' })
    await fetch(`${bridge.base}/src/Acurite/1234`, { method: 'POST', body: '{"t":2}' })

    for (let i = 0; i < 5; i++) {
      const got = await fetch(`${bridge.base}/src/Acurite/1234`)
      assert.equal(await got.text(), '{"t":2}')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  } finally {
    await bridge.close()
  }
})

test('a POST is 503 when the broker takes the publish but never echoes it', async () => {
  const bridge = await startBridge({ echoTimeoutMs: 300 })
  try {
    bridge.blackhole()

    const started = Date.now()
    const posted = await fetch(`${bridge.base}/src/Acurite/1234`, { method: 'POST', body: '{"a":1}' })
    assert.equal(posted.status, 503)
    assert.ok(Date.now() - started < 2000, 'the POST waited far longer than the echo timeout')
  } finally {
    await bridge.close()
  }
})

test('a topic the old broker held is not served after a reconnect to an empty one', async () => {
  const bridge = await startBridge()
  try {
    await fetch(`${bridge.base}/src/Acurite/1234`, { method: 'POST', body: '{"a":1}' })
    assert.equal((await fetch(`${bridge.base}/src/Acurite/1234`)).status, 200)

    await bridge.restartBroker()

    await waitFor(async () => (await fetch(`${bridge.base}/src/Acurite/1234`)).status === 404, 8000)
  } finally {
    await bridge.close()
  }
})

test('a POST the broker never took is 503, even when another publisher writes that topic', async () => {
  const bridge = await startBridge({ echoTimeoutMs: 500 })
  const foreign = await mqtt.connectAsync(bridge.directUrl())
  try {
    bridge.blackhole('up')
    const posting = fetch(`${bridge.base}/src/Acurite/1234`, {
      method: 'POST',
      body: '{"mine":true}',
    })
    await foreign.publishAsync('src/Acurite/1234', '{"foreign":true}', { qos: 0, retain: true })

    assert.equal((await posting).status, 503)
  } finally {
    await foreign.endAsync()
    await bridge.close()
  }
})

test('every response allows any origin', async () => {
  const bridge = await startBridge()
  try {
    const get = await fetch(`${bridge.base}/nothing/here/1`)
    assert.equal(get.headers.get('access-control-allow-origin'), '*')

    const stream = await fetch(`${bridge.base}/events?f=%23`, { headers: { accept: 'text/event-stream' } })
    assert.equal(stream.headers.get('access-control-allow-origin'), '*')
    await stream.body.cancel()

    const pre = await fetch(`${bridge.base}/a/b/1`, { method: 'OPTIONS' })
    assert.equal(pre.status, 204)
    assert.equal(pre.headers.get('access-control-allow-origin'), '*')
    assert.match(pre.headers.get('access-control-allow-methods'), /POST/)
    assert.match(pre.headers.get('access-control-allow-headers'), /content-type/i)
  } finally {
    await bridge.close()
  }
})
