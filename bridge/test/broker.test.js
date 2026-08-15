import { test } from 'node:test'
import assert from 'node:assert/strict'

import mqtt from 'mqtt'

import { cacheMessage, connectBroker } from '../src/broker.js'
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

      assert.deepEqual(cache.get('src/Acurite/1'), Buffer.from('{"temperature_C":21.4}'))
      assert.deepEqual(seen, [['src/Acurite/1', Buffer.from('{"temperature_C":21.4}')]])
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
      assert.deepEqual(cache.get('src/Acurite/1'), Buffer.from('{"temperature_C":21.4}'))
    } finally {
      await second.end()
    }
  } finally {
    await broker.close()
  }
})

test('a zero-length publish deletes the cached message only when it is retained', () => {
  const cache = createCache()

  cache.set('src/Acurite/1', Buffer.from('{"t":1}'))
  cacheMessage(cache, 'src/Acurite/1', Buffer.alloc(0), { retain: false })
  assert.deepEqual(cache.get('src/Acurite/1'), Buffer.alloc(0))

  cacheMessage(cache, 'src/Acurite/1', Buffer.from('{"t":2}'), { retain: false })
  cacheMessage(cache, 'src/Acurite/1', Buffer.alloc(0), { retain: true })
  assert.equal(cache.get('src/Acurite/1'), undefined)
})

test('a broker that refuses the subscription is reported, and is not ready', async () => {
  const broker = await startBroker(0, { refuseSubscribe: true })
  try {
    const errors = []
    const client = connectBroker({
      url: broker.url,
      cache: createCache(),
      onMessage: () => {},
      onError: (err) => errors.push(err),
    })
    try {
      await waitFor(() => errors.length > 0)
      const ready = await Promise.race([
        client.subscribed.then(() => 'subscribed'),
        new Promise((resolve) => setTimeout(() => resolve('not subscribed'), 200)),
      ])
      assert.equal(ready, 'not subscribed')
    } finally {
      await client.end()
    }
  } finally {
    await broker.close()
  }
})

test('a subscribe error goes through the same dedup as any other error', async () => {
  const broker = await startBroker(0, { refuseSubscribe: true })
  try {
    const errors = []
    const client = connectBroker({
      url: broker.url,
      cache: createCache(),
      onMessage: () => {},
      onError: (err) => errors.push(err),
      reconnectMs: 30,
    })
    try {
      // aedes closes the connection outright on a refused subscription
      // rather than sending a SUBACK failure, so the error the subscribe
      // callback receives is the same 'Connection closed' the 'error' event
      // would report on any other broken connection; one report for it is
      // the same contract every other error gets.
      await waitFor(() => errors.length > 0)
      await new Promise((resolve) => setTimeout(resolve, 150))
      assert.equal(errors.length, 1)
    } finally {
      await client.end()
    }
  } finally {
    await broker.close()
  }
})

test('a subscribe error arriving after shutdown begins is not reported', async () => {
  const broker = await startBroker(0, { refuseSubscribe: true })
  try {
    const errors = []
    const client = connectBroker({
      url: broker.url,
      cache: createCache(),
      onMessage: () => {},
      // Fires before `client.subscribe` is called for this connection, so
      // shutdown is already under way by the time the refusal comes back.
      onConnect: () => client.end(),
      onError: (err) => errors.push(err),
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.deepEqual(errors, [])
  } finally {
    await broker.close()
  }
})

test('a broker that refuses the connection is reported rather than swallowed', async () => {
  const broker = await startBroker()
  const url = broker.url
  await broker.close()

  const errors = []
  const client = connectBroker({
    url,
    cache: createCache(),
    onMessage: () => {},
    onError: (err) => errors.push(err),
  })
  try {
    await waitFor(() => errors.length > 0, 5000)
    assert.match(errors[0].message, /ECONNREFUSED/)
  } finally {
    await client.end()
  }
})

test('a foreign publish of a different payload does not answer a waiting publish', async () => {
  const broker = await startBroker()
  const foreign = await mqtt.connectAsync(broker.directUrl)
  try {
    const cache = createCache()
    const client = connectBroker({ url: broker.url, cache, onMessage: () => {}, echoTimeoutMs: 500 })
    try {
      await client.subscribed

      // The publish leaves the bridge and never reaches the broker; what the
      // broker sends still arrives.
      broker.blackhole('up')
      const posting = client.publish('src/Acurite/1', '{"mine":true}')
      await foreign.publishAsync('src/Acurite/1', '{"foreign":true}', { qos: 0, retain: true })
      await waitFor(() => cache.get('src/Acurite/1') !== undefined)

      await assert.rejects(posting, /did not echo/)
      assert.deepEqual(cache.get('src/Acurite/1'), Buffer.from('{"foreign":true}'))
    } finally {
      await client.end()
    }
  } finally {
    await foreign.endAsync()
    await broker.close()
  }
})

test('two publishes to one topic each wait for their own echo', async () => {
  const broker = await startBroker(0, { delayMs: 40 })
  try {
    const seen = []
    const client = connectBroker({
      url: broker.url,
      cache: createCache(),
      onMessage: (topic, payload) => seen.push(payload.toString()),
    })
    try {
      await client.subscribed

      // Both are in flight at once, but far enough apart that their echoes
      // arrive in separate reads: batched into one, either echo wakes both.
      const first = client.publish('src/Acurite/1', '{"t":1}').then(() => seen.slice())
      await new Promise((resolve) => setTimeout(resolve, 20))
      const second = client.publish('src/Acurite/1', '{"t":2}').then(() => seen.slice())
      const [afterFirst, afterSecond] = await Promise.all([first, second])

      assert.ok(afterFirst.includes('{"t":1}'), 'the first publish resolved before its own echo')
      assert.ok(afterSecond.includes('{"t":2}'), 'the second publish resolved before its own echo')
    } finally {
      await client.end()
    }
  } finally {
    await broker.close()
  }
})

test('a publish that times out leaves nothing waiting behind it', async () => {
  const broker = await startBroker()
  try {
    const client = connectBroker({
      url: broker.url,
      cache: createCache(),
      onMessage: () => {},
      echoTimeoutMs: 100,
    })
    try {
      await client.subscribed
      broker.blackhole()
      await assert.rejects(client.publish('src/Acurite/1', '{"t":1}'), /did not echo/)
      assert.equal(client.waiting(), 0)
    } finally {
      await client.end()
    }
  } finally {
    await broker.close()
  }
})

test('a connection and the loss of it are each reported once, however many retries follow', async () => {
  const broker = await startBroker()
  const connects = []
  const disconnects = []
  const errors = []
  const client = connectBroker({
    url: broker.url,
    cache: createCache(),
    onMessage: () => {},
    onConnect: () => connects.push(Date.now()),
    onDisconnect: () => disconnects.push(Date.now()),
    onError: (err) => errors.push(err),
    reconnectMs: 50,
  })
  try {
    await client.subscribed
    assert.equal(connects.length, 1)
    assert.deepEqual(disconnects, [])

    await broker.close()
    await waitFor(() => disconnects.length > 0)
    await new Promise((resolve) => setTimeout(resolve, 400))

    assert.equal(disconnects.length, 1, 'every failed retry reported the disconnect again')
    const refused = errors.filter((err) => /ECONNREFUSED/.test(err.message))
    assert.equal(refused.length, 1, 'the same error was reported on every retry')
  } finally {
    await client.end()
  }
})

test('an error is reported again once something has changed', async () => {
  const broker = await startBroker()
  const port = broker.port
  await broker.close()

  const errors = []
  const client = connectBroker({
    url: `mqtt://127.0.0.1:${port}`,
    cache: createCache(),
    onMessage: () => {},
    onError: (err) => errors.push(err),
    reconnectMs: 50,
  })
  let again
  try {
    await waitFor(() => errors.length > 0)
    assert.equal(errors.length, 1)

    again = await startBroker(port)
    await client.subscribed
    await again.close()

    await waitFor(() => errors.filter((err) => /ECONNREFUSED/.test(err.message)).length === 2)
  } finally {
    await client.end()
    if (again) await again.close()
  }
})

test('a shutdown reports neither the disconnect nor the error it causes', async () => {
  const broker = await startBroker()
  try {
    const disconnects = []
    const errors = []
    const client = connectBroker({
      url: broker.url,
      cache: createCache(),
      onMessage: () => {},
      onDisconnect: () => disconnects.push(Date.now()),
      onError: (err) => errors.push(err),
    })
    await client.subscribed
    await client.end()
    await broker.close()
    await new Promise((resolve) => setTimeout(resolve, 200))

    assert.deepEqual(disconnects, [])
    assert.deepEqual(errors, [])
  } finally {
    await broker.close()
  }
})
