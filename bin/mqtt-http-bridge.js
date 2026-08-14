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
  onMessage: (topic, payload) => bridge.broadcast(topic, payload),
  username: config.username,
  password: config.password,
})
bridge = createBridge({ broker, cache })

bridge.httpServer.listen(config.port, config.host, () => {
  console.log(`mqtt-http-bridge on http://${config.host}:${config.port}, broker ${config.mqttUrl}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    bridge.httpServer.close()
    broker.end().then(() => process.exit(0))
  })
}
