import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'

import mqtt from 'mqtt'

import { closeStream, readEvents, startBridge, waitFor } from './helpers/bridge.js'

// Reads raw frame text rather than parsed JSON, so a test can compare wire
// bytes across clients or see frames readEvents skips, like ':keepalive'.
async function readRawFrames(response, count, { matching = (frame) => frame.startsWith('data: ') } = {}) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const frames = []
  let buffer = ''

  while (frames.length < count) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let split
    while ((split = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, split)
      buffer = buffer.slice(split + 2)
      if (matching(frame)) frames.push(frame)
    }
  }

  await reader.cancel()
  return frames
}

test('retained messages arrive on connect, live ones after', async () => {
  const bridge = await startBridge()
  try {
    await fetch(`${bridge.base}/src/Acurite/1`, { method: 'POST', body: '{"t":1}' })

    const stream = await fetch(`${bridge.base}/events?f=src/%23`)
    try {
      assert.equal(stream.headers.get('content-type'), 'text/event-stream')
      const reading = readEvents(stream, 2)

      await fetch(`${bridge.base}/src/Acurite/2`, { method: 'POST', body: '{"t":2}' })
      const events = await reading

      assert.deepEqual(events, [
        { topic: 'src/Acurite/1', payload: { t: 1 } },
        { topic: 'src/Acurite/2', payload: { t: 2 } },
      ])
    } finally {
      await closeStream(stream)
    }
  } finally {
    await bridge.close()
  }
})

test('repeated f delivers from every filter, and a topic matching two arrives once', async () => {
  const bridge = await startBridge()
  try {
    const stream = await fetch(`${bridge.base}/events?f=src/Acurite/%2B&f=src/%23`)
    try {
      const reading = readEvents(stream, 2)

      await fetch(`${bridge.base}/src/Acurite/1`, { method: 'POST', body: '{"t":1}' })
      await fetch(`${bridge.base}/src/Other/1`, { method: 'POST', body: '{"t":2}' })
      const events = await reading

      assert.deepEqual(events, [
        { topic: 'src/Acurite/1', payload: { t: 1 } },
        { topic: 'src/Other/1', payload: { t: 2 } },
      ])
    } finally {
      await closeStream(stream)
    }
  } finally {
    await bridge.close()
  }
})

test('a filter matching nothing opens and stays empty', async () => {
  const bridge = await startBridge()
  try {
    const stream = await fetch(`${bridge.base}/events?f=nothing/%23`)
    assert.equal(stream.status, 200)

    const raced = await Promise.race([
      readEvents(stream, 1).then(() => 'event'),
      new Promise((resolve) => setTimeout(() => resolve('quiet'), 300)),
    ])
    assert.equal(raced, 'quiet')
  } finally {
    await bridge.close()
  }
})

test('a retained delete seen live carries deleted: true, an ordinary empty message does not', async () => {
  const bridge = await startBridge()
  const foreign = await mqtt.connectAsync(bridge.mqttUrl)
  try {
    await fetch(`${bridge.base}/src/Acurite/1`, { method: 'POST', body: '{"t":1}' })

    const stream = await fetch(`${bridge.base}/events?f=src/%23`)
    try {
      const reading = readEvents(stream, 3)

      await foreign.publishAsync('src/Acurite/1', '', { qos: 0, retain: true })
      await foreign.publishAsync('src/Marker/1', '', { qos: 0, retain: false })
      const events = await reading

      assert.deepEqual(events, [
        { topic: 'src/Acurite/1', payload: { t: 1 } },
        { topic: 'src/Acurite/1', payload: '', deleted: true },
        { topic: 'src/Marker/1', payload: '' },
      ])
    } finally {
      await closeStream(stream)
    }
  } finally {
    await foreign.endAsync()
    await bridge.close()
  }
})

test('a topic gone at reconnect is announced deleted to an already open subscriber', async () => {
  const bridge = await startBridge({ reconnectMs: 30, cacheSettleMs: 1000 })
  try {
    await fetch(`${bridge.base}/src/Acurite/1`, { method: 'POST', body: '{"t":1}' })
    await fetch(`${bridge.base}/src/Acurite/2`, { method: 'POST', body: '{"t":2}' })

    const stream = await fetch(`${bridge.base}/events?f=src/%23`)
    try {
      const reading = readEvents(stream, 4, { timeoutMs: 5000 })

      // ready() can flip true then false again mid-restart, so the republish
      // retries past a stray 503 instead of trusting one ready() check.
      await bridge.restartBroker()
      await waitFor(async () => {
        const res = await fetch(`${bridge.base}/src/Acurite/2`, { method: 'POST', body: '{"t":2}' })
        return res.status === 204
      })
      const events = await reading

      // The initial replay (from the cache at connect time) arrives in
      // insertion order and always precedes the reconnect; the republish
      // echo and the deleted announcement race each other, so compare those
      // two as a set rather than depending on which lands first.
      assert.deepEqual(events.slice(0, 2), [
        { topic: 'src/Acurite/1', payload: { t: 1 } },
        { topic: 'src/Acurite/2', payload: { t: 2 } },
      ])
      assert.deepEqual(new Set(events.slice(2).map((event) => JSON.stringify(event))), new Set([
        JSON.stringify({ topic: 'src/Acurite/2', payload: { t: 2 } }),
        JSON.stringify({ topic: 'src/Acurite/1', payload: '', deleted: true }),
      ]))
    } finally {
      await closeStream(stream)
    }
  } finally {
    await bridge.close()
  }
})

test('omitting f subscribes to everything, and a malformed filter is 400', async () => {
  const bridge = await startBridge()
  try {
    const all = await fetch(`${bridge.base}/events`)
    try {
      assert.equal(all.status, 200)
    } finally {
      await all.body.cancel()
    }

    const bad = await fetch(`${bridge.base}/events?f=a/%23/c`)
    assert.equal(bad.status, 400)
  } finally {
    await bridge.close()
  }
})

test('an alias reaches a subscriber like any other topic', async () => {
  const bridge = await startBridge()
  try {
    const stream = await fetch(`${bridge.base}/events?f=src/%23`)
    try {
      const reading = readEvents(stream, 1)

      await fetch(`${bridge.base}/src/Acurite/1/$alias`, { method: 'POST', body: '"Back fence"' })

      assert.deepEqual(await reading, [{ topic: 'src/Acurite/1/$alias', payload: 'Back fence' }])
    } finally {
      await closeStream(stream)
    }
  } finally {
    await bridge.close()
  }
})

test('a subscriber whose connection dies does not take the bridge down with it', async () => {
  const bridge = await startBridge()
  try {
    const { hostname, port } = new URL(bridge.base)

    const socket = net.connect(Number(port), hostname)
    try {
      await new Promise((resolve, reject) => {
        socket.once('connect', resolve)
        socket.once('error', reject)
      })
      socket.write(`GET /events HTTP/1.1\r\nHost: ${hostname}\r\nConnection: keep-alive\r\n\r\n`)

      // Wait for the ':open' frame so the server has registered the client
      // before the socket dies, otherwise there is nothing to reproduce.
      await new Promise((resolve) => {
        let buffer = ''
        socket.on('data', function onData(chunk) {
          buffer += chunk.toString()
          if (buffer.includes(':open\n\n')) {
            socket.off('data', onData)
            resolve()
          }
        })
      })
    } finally {
      // Kill the socket without a clean FIN, so the server only learns of it
      // when a write to the response fails.
      socket.resetAndDestroy ? socket.resetAndDestroy() : socket.destroy()
    }

    await fetch(`${bridge.base}/src/Acurite/1`, { method: 'POST', body: '{"t":1}' })

    const after = await fetch(`${bridge.base}/src/Acurite/1`)
    assert.equal(after.status, 200)
  } finally {
    await bridge.close()
  }
})

test('a retained topic matching two filters is replayed once', async () => {
  const bridge = await startBridge()
  try {
    await fetch(`${bridge.base}/src/Acurite/1`, { method: 'POST', body: '{"t":1}' })

    const stream = await fetch(`${bridge.base}/events?f=src/Acurite/%2B&f=src/%23`)
    try {
      const reading = readEvents(stream, 2)

      await fetch(`${bridge.base}/src/Other/1`, { method: 'POST', body: '{"t":2}' })

      assert.deepEqual(await reading, [
        { topic: 'src/Acurite/1', payload: { t: 1 } },
        { topic: 'src/Other/1', payload: { t: 2 } },
      ])
    } finally {
      await closeStream(stream)
    }
  } finally {
    await bridge.close()
  }
})

test('two clients with different filters get the byte-identical frame for one message', async () => {
  const bridge = await startBridge()
  try {
    const a = await fetch(`${bridge.base}/events?f=src/%23`)
    const b = await fetch(`${bridge.base}/events?f=%23`)
    try {
      const readingA = readRawFrames(a, 1)
      const readingB = readRawFrames(b, 1)

      await fetch(`${bridge.base}/src/Acurite/1`, { method: 'POST', body: '{"t":1}' })

      const [framesA, framesB] = await Promise.all([readingA, readingB])
      assert.equal(framesA[0], framesB[0])
    } finally {
      try {
        await a.body.cancel()
      } catch {
        // readRawFrames already cancelled the reader
      }
      try {
        await b.body.cancel()
      } catch {
        // readRawFrames already cancelled the reader
      }
    }
  } finally {
    await bridge.close()
  }
})

test('replay follows cache insertion order, not filter order', async () => {
  const bridge = await startBridge()
  try {
    await fetch(`${bridge.base}/src/Other/1`, { method: 'POST', body: '{"t":1}' })
    await fetch(`${bridge.base}/src/Acurite/1`, { method: 'POST', body: '{"t":2}' })

    const stream = await fetch(`${bridge.base}/events?f=src/Acurite/%2B&f=src/%23`)
    try {
      const events = await readEvents(stream, 2)
      assert.deepEqual(events.map((e) => e.topic), ['src/Other/1', 'src/Acurite/1'])
    } finally {
      await closeStream(stream)
    }
  } finally {
    await bridge.close()
  }
})

test('a request opening one more than MAX_SSE_CLIENTS streams gets 503, and the earlier streams stay open', async () => {
  const bridge = await startBridge({ maxSseClients: 2 })
  try {
    const a = await fetch(`${bridge.base}/events`)
    const b = await fetch(`${bridge.base}/events`)
    try {
      assert.equal(a.status, 200)
      assert.equal(b.status, 200)
      assert.equal(bridge.clients.size, 2)

      const refused = await fetch(`${bridge.base}/events`)
      assert.equal(refused.status, 503)
      assert.equal(bridge.clients.size, 2)

      await fetch(`${bridge.base}/src/Acurite/1`, { method: 'POST', body: '{"t":1}' })
      const [eventsA, eventsB] = await Promise.all([readEvents(a, 1), readEvents(b, 1)])
      assert.deepEqual(eventsA, [{ topic: 'src/Acurite/1', payload: { t: 1 } }])
      assert.deepEqual(eventsB, [{ topic: 'src/Acurite/1', payload: { t: 1 } }])
    } finally {
      await closeStream(a)
      await closeStream(b)
    }
  } finally {
    await bridge.close()
  }
})

test('a request with more than MAX_SSE_FILTERS f parameters is 400 and registers no client', async () => {
  const bridge = await startBridge({ maxSseFilters: 2 })
  try {
    const filters = ['f=a/%23', 'f=b/%23', 'f=c/%23'].join('&')
    const refused = await fetch(`${bridge.base}/events?${filters}`)
    assert.equal(refused.status, 400)
    assert.equal(await refused.text(), 'too many filters\n')
    assert.equal(bridge.clients.size, 0)
  } finally {
    await bridge.close()
  }
})

test('a slow reader that falls a buffer cap behind is dropped', async () => {
  const bridge = await startBridge({ maxBufferedBytes: 1024 })
  try {
    const { hostname, port } = new URL(bridge.base)

    // A raw socket that is never read from: fetch()'s body reader would
    // drain the response itself, defeating the point of a slow reader.
    const socket = net.connect(Number(port), hostname)
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
    socket.write(`GET /events HTTP/1.1\r\nHost: ${hostname}\r\nConnection: keep-alive\r\n\r\n`)
    await new Promise((resolve) => {
      let buffer = ''
      socket.on('data', function onData(chunk) {
        buffer += chunk.toString()
        if (buffer.includes(':open\n\n')) {
          socket.off('data', onData)
          resolve()
        }
      })
    })
    socket.pause()

    // Under the 64 KiB POST body cap, so each publish itself succeeds; sent
    // concurrently so they queue on the stalled connection faster than the
    // kernel can drain them, rather than one at a time with room to flush
    // between requests.
    const big = JSON.stringify({ pad: 'x'.repeat(60 * 1024) })
    const posts = []
    for (let i = 0; i < 200; i++) {
      posts.push(fetch(`${bridge.base}/src/Acurite/${i}`, { method: 'POST', body: big }))
    }
    await Promise.allSettled(posts)

    try {
      await waitFor(() => bridge.clients.size === 0)
    } finally {
      socket.destroy()
    }
  } finally {
    await bridge.close()
  }
})

test('the keepalive interval sends :keepalive frames on its own schedule', async () => {
  const bridge = await startBridge({ keepaliveMs: 5 })
  try {
    const stream = await fetch(`${bridge.base}/events?f=src/%23`)
    try {
      const start = Date.now()
      const frames = await readRawFrames(stream, 2, { matching: (frame) => frame === ':keepalive' })
      const elapsedMs = Date.now() - start
      assert.deepEqual(frames, [':keepalive', ':keepalive'])
      // keepaliveMs is 5 here; without the passthrough readRawFrames falls back
      // to the production keepalive interval (tens of seconds) and this bound
      // catches that rather than just running slow.
      assert.ok(elapsedMs < 500, `expected both keepalives within 500ms, took ${elapsedMs}ms`)
    } finally {
      await closeStream(stream)
    }
  } finally {
    await bridge.close()
  }
})

test('a subscriber connecting after a POST is sent that message once', async () => {
  const bridge = await startBridge({ delayMs: 40 })
  try {
    await fetch(`${bridge.base}/src/Acurite/1`, { method: 'POST', body: '{"t":1}' })

    const stream = await fetch(`${bridge.base}/events?f=src/%23`)
    try {
      const events = await readEvents(stream, 2, { timeoutMs: 400 })
      assert.deepEqual(events, [{ topic: 'src/Acurite/1', payload: { t: 1 } }])
    } finally {
      await closeStream(stream)
    }
  } finally {
    await bridge.close()
  }
})
