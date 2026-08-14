import { test } from 'node:test'
import assert from 'node:assert/strict'

import { connectBroker } from '../src/broker.js'
import { createCache } from '../src/cache.js'
import { waitFor } from './helpers/bridge.js'
import { startBroker } from './helpers/broker.js'

test('a published message reaches the cache and the callback', async () => {
  const broker = await startBroker()
  try {
    const cache = createCache()
    const seen = []
    const client = connectBroker({
      url: broker.url,
      cache,
      onMessage: (topic, payload) => seen.push([topic, payload]),
    })
    try {
      await client.subscribed
      await client.publish('src/Acurite/1', '{"temperature_C":21.4}')
      await waitFor(() => cache.get('src/Acurite/1') !== undefined)

      assert.equal(cache.get('src/Acurite/1'), '{"temperature_C":21.4}')
      assert.deepEqual(seen, [['src/Acurite/1', '{"temperature_C":21.4}']])
      assert.equal(client.connected(), true)
    } finally {
      await client.end()
    }
  } finally {
    await broker.close()
  }
})

test('a publish is retained, so a later connection is replayed it', async () => {
  const broker = await startBroker()
  try {
    const first = connectBroker({ url: broker.url, cache: createCache(), onMessage: () => {} })
    try {
      await first.subscribed
      await first.publish('src/Acurite/1', '{"temperature_C":21.4}')
    } finally {
      await first.end()
    }

    const cache = createCache()
    const second = connectBroker({ url: broker.url, cache, onMessage: () => {} })
    try {
      await second.subscribed
      await waitFor(() => cache.get('src/Acurite/1') !== undefined)
      assert.equal(cache.get('src/Acurite/1'), '{"temperature_C":21.4}')
    } finally {
      await second.end()
    }
  } finally {
    await broker.close()
  }
})
