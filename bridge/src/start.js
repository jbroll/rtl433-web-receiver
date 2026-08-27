import { connectBroker } from './broker.js'
import { createCache } from './cache.js'
import { createBridge } from './server.js'

// Startup happens in two phases so the `bridge?.broadcast` guard below has a
// caller-visible seam: a message delivered between connectStartupBroker and
// finishStartupBridge finds `bridge` unset and is dropped, safely, because it
// is already in the cache and any later subscriber is replayed from there.
// Both phases run synchronously back to back in production
// (bin/mqtt-http-bridge.js); do not await anything between them, or the
// window this guard exists for stops matching production's.
export function connectStartupBroker(brokerOptions) {
  const cache = createCache()
  let bridge
  const broker = connectBroker({
    ...brokerOptions,
    cache,
    onMessage: (topic, payload, deleted) => bridge?.broadcast(topic, payload, deleted),
  })
  return { broker, cache, setBridge: (value) => { bridge = value } }
}

export function finishStartupBridge({ broker, cache, setBridge }, bridgeOptions) {
  const bridge = createBridge({ broker, cache, ...bridgeOptions })
  setBridge(bridge)
  return bridge
}
