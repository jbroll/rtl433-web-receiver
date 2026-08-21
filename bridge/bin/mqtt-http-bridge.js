#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { readFileSync } from 'node:fs'

import { connectBroker } from '../src/broker.js'
import { createCache } from '../src/cache.js'
import { brokerLabel, readConfig } from '../src/config.js'
import { startEmbeddedBroker } from '../src/embedded-broker.js'
import { createBridge } from '../src/server.js'

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    'no-embed-broker': { type: 'boolean' },
    'broker-url': { type: 'string' },
    'mqtt-port': { type: 'string' },
    'mqtts-port': { type: 'string' },
    'tls-cert': { type: 'string' },
    'tls-key': { type: 'string' },
    'auth-token': { type: 'string' },
    'dashboard-html': { type: 'string' },
  },
  strict: true,
})

const config = readConfig(process.env, {
  noEmbedBroker: values['no-embed-broker'],
  brokerUrl: values['broker-url'],
  mqttPort: values['mqtt-port'],
  mqttsPort: values['mqtts-port'],
  tlsCert: values['tls-cert'],
  tlsKey: values['tls-key'],
  authToken: values['auth-token'],
  dashboardHtml: values['dashboard-html'],
})

// When embedding, this is the only place a public, unauthenticated broker
// could start silently — startEmbeddedBroker throws before listening if
// TLS is configured without AUTH_TOKEN, so that failure happens here,
// before anything else comes up.
let embedded
let brokerUrl = config.mqttUrl
let brokerTls
let brokerUsername = config.username
let brokerPassword = config.password
if (config.embedBroker) {
  embedded = await startEmbeddedBroker({
    mqttPort: config.mqttPort,
    mqttsPort: config.mqttsPort,
    tlsCert: config.tlsCert,
    tlsKey: config.tlsKey,
    authToken: config.authToken,
  })
  brokerUrl = embedded.url
  brokerTls = embedded.tlsOptions
  if (embedded.tlsOptions) {
    // TLS mode: the embedded aedes's authenticate hook (src/embedded-broker.js)
    // accepts any username and checks only the password against AUTH_TOKEN.
    // MQTT_USERNAME/MQTT_PASSWORD are for dialing an external broker
    // (EMBED_BROKER=false) and are not relevant to this self-connection.
    // A username has to be sent regardless of its value: mqtt.js's
    // mqtt-packet encoder refuses to send a password with no username.
    brokerUsername = 'bridge'
    brokerPassword = config.authToken
  }
}

const brokerName = brokerLabel(brokerUrl)
const cache = createCache()

let bridge
const broker = connectBroker({
  url: brokerUrl,
  tls: brokerTls,
  cache,
  // A message delivered before `bridge` is assigned is already in the cache,
  // and any subscriber connecting later is replayed from it, so it is safe
  // to drop.
  onMessage: (topic, payload) => bridge?.broadcast(topic, payload),
  username: brokerUsername,
  password: brokerPassword,
  onConnect: () => console.log(`broker ${brokerName} connected`),
  onDisconnect: () => console.error(`broker ${brokerName} disconnected, retrying`),
  onError: (err) => console.error(`broker ${brokerName}: ${err.message}`),
})
const dashboardHtml = config.dashboardHtmlPath ? readFileSync(config.dashboardHtmlPath, 'utf8') : undefined
bridge = createBridge({ broker, cache, authToken: config.authToken, dashboardHtml })

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
    broker
      .end()
      .then(() => embedded?.close())
      .then(() => process.exit(0))
  })
}
