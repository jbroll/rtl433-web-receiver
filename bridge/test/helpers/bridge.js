import { connectStartupBroker, finishStartupBridge } from '../../src/start.js'
import { startBroker } from './broker.js'

// Split from startBridge below so a test can hold the gap between this and
// finishBridge open: the window bin/mqtt-http-bridge.js's `bridge?.broadcast`
// guard (src/start.js) exists for, where a message can arrive before the
// `bridge` variable wiring it to broadcast is assigned. Mirrors
// connectStartupBroker/finishStartupBridge exactly, with no await between
// them, so that window matches production's.
export async function connectBridgeBroker({
  url,
  delayMs,
  echoTimeoutMs,
  reconnectMs,
  cacheSettleMs,
  username,
  password,
} = {}) {
  const mqttBroker = url ? null : await startBroker(0, { delayMs })
  const started = connectStartupBroker({
    url: url ?? mqttBroker.url,
    echoTimeoutMs,
    reconnectMs,
    cacheSettleMs,
    username,
    password,
  })

  return {
    ...started,
    mqttBroker,
    mqttUrl: url ?? mqttBroker.url,
  }
}

export async function finishBridge(built, {
  delayMs,
  authToken,
  dashboardHtml,
  bodyLimitBytes,
  bodyIdleTimeoutMs,
  maxSseClients,
  maxSseFilters,
  maxBufferedBytes,
  keepaliveMs,
} = {}) {
  const { broker, cache, mqttBroker, mqttUrl } = built
  let currentMqttBroker = mqttBroker
  const bridge = finishStartupBridge(built, {
    authToken,
    dashboardHtml,
    bodyLimitBytes,
    bodyIdleTimeoutMs,
    maxSseClients,
    maxSseFilters,
    maxBufferedBytes,
    keepaliveMs,
  })

  // Unbounded, a subscription that never lands hangs `node --test` instead of
  // failing it. Waited here, after the bridge is built, so this safety net
  // does not delay bridge creation past connectBridgeBroker the way
  // production's bin/mqtt-http-bridge.js never does either.
  if (mqttBroker) await withTimeout(broker.subscribed, 5000, 'the # subscription')

  await new Promise((resolve) => bridge.httpServer.listen(0, '127.0.0.1', resolve))
  const { port } = bridge.httpServer.address()

  let brokerStopped = false
  const stopBroker = async () => {
    if (brokerStopped || !currentMqttBroker) return
    brokerStopped = true
    await currentMqttBroker.close()
  }

  return {
    base: `http://127.0.0.1:${port}`,
    mqttUrl,
    broker,
    cache,
    clients: bridge.clients,
    stopBroker,
    blackhole: (direction) => currentMqttBroker?.blackhole(direction),
    directUrl: () => currentMqttBroker?.directUrl,
    restartBroker: async () => {
      const brokerPort = currentMqttBroker.port
      await stopBroker()
      currentMqttBroker = await startBroker(brokerPort, { delayMs })
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

// Given a url, the bridge is pointed at that address and started without
// waiting for anything there: that is the unreachable-broker case.
export async function startBridge(options = {}) {
  const built = await connectBridgeBroker(options)
  return finishBridge(built, options)
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

// readEvents already cancelled the reader when it read the stream to
// completion, so a second cancel from a test's cleanup throws; swallow it.
export async function closeStream(stream) {
  try {
    await stream.body.cancel()
  } catch {
    // readEvents already cancelled the reader
  }
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
