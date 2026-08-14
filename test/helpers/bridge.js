import { connectBroker } from '../../src/broker.js'
import { createCache } from '../../src/cache.js'
import { createBridge } from '../../src/server.js'
import { startBroker } from './broker.js'

// Given a url, the bridge is pointed at that address and started without
// waiting for anything there: that is the unreachable-broker case.
export async function startBridge({ url } = {}) {
  const mqttBroker = url ? null : await startBroker()
  const cache = createCache()
  let bridge
  const broker = connectBroker({
    url: url ?? mqttBroker.url,
    cache,
    onMessage: (topic, payload) => bridge.broadcast(topic, payload),
  })
  bridge = createBridge({ broker, cache })
  if (mqttBroker) await broker.subscribed

  await new Promise((resolve) => bridge.httpServer.listen(0, '127.0.0.1', resolve))
  const { port } = bridge.httpServer.address()

  let brokerStopped = false
  const stopBroker = async () => {
    if (brokerStopped || !mqttBroker) return
    brokerStopped = true
    await mqttBroker.close()
  }

  return {
    base: `http://127.0.0.1:${port}`,
    mqttUrl: url ?? mqttBroker.url,
    broker,
    cache,
    stopBroker,
    close: async () => {
      for (const client of bridge.clients) client.close()
      bridge.clients.clear()
      await new Promise((resolve) => bridge.httpServer.close(resolve))
      await broker.end()
      await stopBroker()
    },
  }
}

export async function readEvents(response, count) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const events = []
  let buffer = ''

  while (events.length < count) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let split
    while ((split = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, split)
      buffer = buffer.slice(split + 2)
      if (frame.startsWith('data: ')) events.push(JSON.parse(frame.slice(6)))
    }
  }

  await reader.cancel()
  return events
}

export async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for condition')
}
