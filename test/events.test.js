import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'

import { readEvents, startBridge, waitFor } from './helpers/bridge.js'

test('retained messages arrive on connect, live ones after', async () => {
  const bridge = await startBridge()
  await fetch(`${bridge.base}/src/Acurite/1`, { method: 'POST', body: '{"t":1}' })
  await waitFor(() => bridge.cache.get('src/Acurite/1') !== undefined)

  const stream = await fetch(`${bridge.base}/events?f=src/%23`)
  assert.equal(stream.headers.get('content-type'), 'text/event-stream')
  const reading = readEvents(stream, 2)

  await fetch(`${bridge.base}/src/Acurite/2`, { method: 'POST', body: '{"t":2}' })
  const events = await reading

  assert.deepEqual(events, [
    { topic: 'src/Acurite/1', payload: { t: 1 } },
    { topic: 'src/Acurite/2', payload: { t: 2 } },
  ])

  await bridge.close()
})

test('repeated f delivers from every filter, and a topic matching two arrives once', async () => {
  const bridge = await startBridge()
  const stream = await fetch(`${bridge.base}/events?f=src/Acurite/%2B&f=src/%23`)
  const reading = readEvents(stream, 2)

  await fetch(`${bridge.base}/src/Acurite/1`, { method: 'POST', body: '{"t":1}' })
  await fetch(`${bridge.base}/src/Other/1`, { method: 'POST', body: '{"t":2}' })
  const events = await reading

  assert.deepEqual(events, [
    { topic: 'src/Acurite/1', payload: { t: 1 } },
    { topic: 'src/Other/1', payload: { t: 2 } },
  ])

  await bridge.close()
})

test('a filter matching nothing opens and stays empty', async () => {
  const bridge = await startBridge()
  const stream = await fetch(`${bridge.base}/events?f=nothing/%23`)
  assert.equal(stream.status, 200)

  const raced = await Promise.race([
    readEvents(stream, 1).then(() => 'event'),
    new Promise((resolve) => setTimeout(() => resolve('quiet'), 300)),
  ])
  assert.equal(raced, 'quiet')

  await bridge.close()
})

test('omitting f subscribes to everything, and a malformed filter is 400', async () => {
  const bridge = await startBridge()

  const all = await fetch(`${bridge.base}/events`)
  assert.equal(all.status, 200)
  await all.body.cancel()

  const bad = await fetch(`${bridge.base}/events?f=a/%23/c`)
  assert.equal(bad.status, 400)

  await bridge.close()
})

test('an alias reaches a subscriber like any other topic', async () => {
  const bridge = await startBridge()
  const stream = await fetch(`${bridge.base}/events?f=src/%23`)
  const reading = readEvents(stream, 1)

  await fetch(`${bridge.base}/src/Acurite/1/$alias`, { method: 'POST', body: '"Back fence"' })

  assert.deepEqual(await reading, [{ topic: 'src/Acurite/1/$alias', payload: 'Back fence' }])

  await bridge.close()
})

test('a subscriber whose connection dies does not take the bridge down with it', async () => {
  const bridge = await startBridge()
  const { hostname, port } = new URL(bridge.base)

  const socket = net.connect(Number(port), hostname)
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

  // Kill the socket without a clean FIN, so the server only learns of it
  // when a write to the response fails.
  socket.resetAndDestroy ? socket.resetAndDestroy() : socket.destroy()

  await fetch(`${bridge.base}/src/Acurite/1`, { method: 'POST', body: '{"t":1}' })

  const after = await fetch(`${bridge.base}/src/Acurite/1`)
  assert.equal(after.status, 200)

  await bridge.close()
})
