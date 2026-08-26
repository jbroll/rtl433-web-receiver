import { connectBroker } from '../../src/broker.js'
import { createCache } from '../../src/cache.js'
import { createBridge } from '../../src/server.js'
import { startBroker } from './broker.js'

// Given a url, the bridge is pointed at that address and started without
// waiting for anything there: that is the unreachable-broker case.
export async function startBridge({
  url,
  delayMs,
  echoTimeoutMs,
  authToken,
  dashboardHtml,
  bodyLimitBytes,
  bodyIdleTimeoutMs,
} = {}) {
  let mqttBroker = url ? null : await startBroker(0, { delayMs })
  const cache = createCache()
  let bridge
  const broker = connectBroker({
    url: url ?? mqttBroker.url,
    cache,
    onMessage: (topic, payload) => bridge.broadcast(topic, payload),
    echoTimeoutMs,
  })
  bridge = createBridge({ broker, cache, authToken, dashboardHtml, bodyLimitBytes, bodyIdleTimeoutMs })
  // Unbounded, a subscription that never lands hangs `node --test` instead of
  // failing it.
  if (mqttBroker) await withTimeout(broker.subscribed, 5000, 'the # subscription')

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
    clients: bridge.clients,
    stopBroker,
    blackhole: (direction) => mqttBroker?.blackhole(direction),
    directUrl: () => mqttBroker?.directUrl,
    restartBroker: async () => {
      const brokerPort = mqttBroker.port
      await stopBroker()
      mqttBroker = await startBroker(brokerPort, { delayMs })
      brokerStopped = false
    },
    close: async () => {
      for (const client of bridge.clients) client.close()
      bridge.clients.clear()
      await new Promise((resolve) => bridge.httpServer.close(resolve))
      await broker.end()
      await stopBroker()
    },
  }
}

// With a timeoutMs, this returns whatever has arrived when it expires, which
// is how a test asserts that nothing more is coming.
export async function readEvents(response, count, { timeoutMs } = {}) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const events = []
  let buffer = ''
  const deadline = timeoutMs === undefined ? null : Date.now() + timeoutMs

  while (events.length < count) {
    const read = deadline === null ? reader.read() : untilDeadline(reader.read(), deadline)
    const { value, done, expired } = await read
    if (done || expired) break
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

function untilDeadline(promise, deadline) {
  let timer
  const expiry = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ expired: true }), Math.max(0, deadline - Date.now()))
  })
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer))
}

export async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for condition')
}

export function withTimeout(promise, timeoutMs, what) {
  let timer
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), timeoutMs)
  })
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer))
}
