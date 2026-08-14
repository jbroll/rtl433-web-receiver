import { test } from 'node:test'
import assert from 'node:assert/strict'

import { connectBroker } from '../src/broker.js'
import { createCache } from '../src/cache.js'
import { startBroker } from './helpers/broker.js'

test('a published message reaches the cache and the callback', async () => {
  const broker = await startBroker()
  const cache = createCache()
  const seen = []
  const client = await connectBroker({
    url: broker.url,
    cache,
    onMessage: (topic, payload) => seen.push([topic, payload]),
  })

  await client.publish('src/Acurite/1', '{"temperature_C":21.4}')
  await waitFor(() => cache.get('src/Acurite/1') !== undefined)

  assert.equal(cache.get('src/Acurite/1'), '{"temperature_C":21.4}')
  assert.deepEqual(seen, [['src/Acurite/1', '{"temperature_C":21.4}']])
  assert.equal(client.connected(), true)

  await client.end()
  await broker.close()
})

test('a publish is retained, so a later connection is replayed it', async () => {
  const broker = await startBroker()
  const first = await connectBroker({ url: broker.url, cache: createCache(), onMessage: () => {} })
  await first.publish('src/Acurite/1', '{"temperature_C":21.4}')
  await first.end()

  const cache = createCache()
  const second = await connectBroker({ url: broker.url, cache, onMessage: () => {} })
  await waitFor(() => cache.get('src/Acurite/1') !== undefined)
  assert.equal(cache.get('src/Acurite/1'), '{"temperature_C":21.4}')

  await second.end()
  await broker.close()
})

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for condition')
}
