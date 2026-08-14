#!/usr/bin/env node
import { connectBroker } from '../src/broker.js'
import { createCache } from '../src/cache.js'
import { readConfig } from '../src/config.js'
import { createBridge } from '../src/server.js'

const config = readConfig(process.env)
const cache = createCache()

let bridge
const broker = await connectBroker({
  url: config.mqttUrl,
  cache,
  // A broker with retained messages can deliver a publish while the
  // subscription await below is still pending, before `bridge` is assigned.
  // The cache has already recorded the message, and any subscriber that
  // connects later is replayed from it, so dropping this one is safe.
  onMessage: (topic, payload) => bridge?.broadcast(topic, payload),
  username: config.username,
  password: config.password,
})
bridge = createBridge({ broker, cache })

bridge.httpServer.listen(config.port, config.host, () => {
  console.log(`mqtt-http-bridge on http://${config.host}:${config.port}, broker ${config.mqttUrl}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    // httpServer.close() never completes while an SSE stream is attached,
    // so the streams have to be ended first to make the server closable.
    for (const client of bridge.clients) client.close()
    bridge.clients.clear()
    bridge.httpServer.close()
    broker.end().then(() => process.exit(0))
  })
}
