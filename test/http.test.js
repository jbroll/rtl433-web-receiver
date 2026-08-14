import { test } from 'node:test'
import assert from 'node:assert/strict'

import { startBridge, waitFor } from './helpers/bridge.js'

test('a topic with no message is 404, and a POST makes it readable byte for byte', async () => {
  const bridge = await startBridge()
  const body = '{"temperature_C":21.4,"humidity":48}'

  const missing = await fetch(`${bridge.base}/src/Acurite/1234`)
  assert.equal(missing.status, 404)

  const posted = await fetch(`${bridge.base}/src/Acurite/1234`, { method: 'POST', body })
  assert.equal(posted.status, 204)

  await waitFor(async () => (await fetch(`${bridge.base}/src/Acurite/1234`)).status === 200)
  const got = await fetch(`${bridge.base}/src/Acurite/1234`)
  assert.equal(got.headers.get('content-type'), 'application/json')
  assert.equal(await got.text(), body)

  await bridge.close()
})

test('a non-JSON body is 400 and leaves the retained message alone', async () => {
  const bridge = await startBridge()
  await fetch(`${bridge.base}/src/Acurite/1234`, { method: 'POST', body: '{"a":1}' })
  await waitFor(async () => (await fetch(`${bridge.base}/src/Acurite/1234`)).status === 200)

  const bad = await fetch(`${bridge.base}/src/Acurite/1234`, { method: 'POST', body: 'not json' })
  assert.equal(bad.status, 400)

  const got = await fetch(`${bridge.base}/src/Acurite/1234`)
  assert.equal(await got.text(), '{"a":1}')

  await bridge.close()
})

test('a wildcard in a topic is 400 and an unsupported method is 405', async () => {
  const bridge = await startBridge()

  assert.equal((await fetch(`${bridge.base}/src/+/1234`)).status, 400)
  assert.equal((await fetch(`${bridge.base}/`)).status, 400)
  assert.equal((await fetch(`${bridge.base}/src/Acurite/1234`, { method: 'DELETE' })).status, 405)

  await bridge.close()
})

test('an alias round-trips, and a device without one has no alias topic', async () => {
  const bridge = await startBridge()

  const unnamed = await fetch(`${bridge.base}/src/Acurite/1234/$alias`)
  assert.equal(unnamed.status, 404)

  await fetch(`${bridge.base}/src/Acurite/1234/$alias`, { method: 'POST', body: '"Back fence"' })
  await waitFor(async () => (await fetch(`${bridge.base}/src/Acurite/1234/$alias`)).status === 200)

  const got = await fetch(`${bridge.base}/src/Acurite/1234/$alias`)
  assert.equal(await got.text(), '"Back fence"')

  await bridge.close()
})

test('every request is 503 once the broker is gone', async () => {
  const bridge = await startBridge()
  await fetch(`${bridge.base}/src/Acurite/1234`, { method: 'POST', body: '{"a":1}' })
  await waitFor(async () => (await fetch(`${bridge.base}/src/Acurite/1234`)).status === 200)

  await bridge.stopBroker()
  await waitFor(async () => (await fetch(`${bridge.base}/src/Acurite/1234`)).status === 503)

  assert.equal((await fetch(`${bridge.base}/events`)).status, 503)

  await bridge.close()
})
