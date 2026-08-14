import { connectBroker } from '../../src/broker.js'
import { createCache } from '../../src/cache.js'
import { createBridge } from '../../src/server.js'
import { startBroker } from './broker.js'

export async function startBridge() {
  const mqttBroker = await startBroker()
  const cache = createCache()
  let bridge
  const broker = await connectBroker({
    url: mqttBroker.url,
    cache,
    onMessage: (topic, payload) => bridge.broadcast(topic, payload),
  })
  bridge = createBridge({ broker, cache })

  await new Promise((resolve) => bridge.httpServer.listen(0, '127.0.0.1', resolve))
  const { port } = bridge.httpServer.address()

  let brokerStopped = false
  const stopBroker = async () => {
    if (brokerStopped) return
    brokerStopped = true
    await mqttBroker.close()
  }

  return {
    base: `http://127.0.0.1:${port}`,
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

export async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for condition')
}
