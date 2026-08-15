#!/usr/bin/env node
import { connectBroker } from '../src/broker.js'
import { createCache } from '../src/cache.js'
import { brokerLabel, readConfig } from '../src/config.js'
import { createBridge } from '../src/server.js'

const config = readConfig(process.env)
const brokerName = brokerLabel(config.mqttUrl)
const cache = createCache()

let bridge
const broker = connectBroker({
  url: config.mqttUrl,
  cache,
  // A message delivered before `bridge` is assigned is already in the cache,
  // and any subscriber connecting later is replayed from it, so it is safe
  // to drop.
  onMessage: (topic, payload) => bridge?.broadcast(topic, payload),
  username: config.username,
  password: config.password,
  onConnect: () => console.log(`broker ${brokerName} connected`),
  onDisconnect: () => console.error(`broker ${brokerName} disconnected, retrying`),
  onError: (err) => console.error(`broker ${brokerName}: ${err.message}`),
})
bridge = createBridge({ broker, cache })

bridge.httpServer.listen(config.port, config.host, () => {
  console.log(`mqtt-http-bridge on http://${config.host}:${config.port}, broker ${brokerName}`)
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
