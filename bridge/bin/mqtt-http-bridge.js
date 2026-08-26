#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { readFileSync } from 'node:fs'

import { connectBroker, ECHO_TIMEOUT_MS } from '../src/broker.js'
import { createCache } from '../src/cache.js'
import { brokerLabel, readConfig } from '../src/config.js'
import { startEmbeddedBroker } from '../src/embedded-broker.js'
import { createBridge } from '../src/server.js'
import { createTokenStore } from '../src/token-store.js'

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
    'auth-token-path': { type: 'string' },
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
  authTokenPath: values['auth-token-path'],
  dashboardHtml: values['dashboard-html'],
})

// One store shared by the embedded broker's MQTT CONNECT check and the
// HTTP bridge's bearer check, so a POST /auth/rotate through the HTTP side
// takes effect for MQTT immediately, with no restart.
const tokenStore = createTokenStore(config.authToken, { path: config.authTokenPath })

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
    tokenStore,
  })
  brokerUrl = embedded.url
  brokerTls = embedded.tlsOptions
  if (embedded.tlsOptions) {
    // TLS mode: the embedded aedes's authenticate hook (src/embedded-broker.js)
    // accepts any username and checks only the password against the current
    // token. MQTT_USERNAME/MQTT_PASSWORD are for dialing an external broker
    // (EMBED_BROKER=false) and are not relevant to this self-connection.
    // A username has to be sent regardless of its value: mqtt.js's
    // mqtt-packet encoder refuses to send a password with no username.
    // This CONNECT happens once at boot, so a later rotation does not
    // reconnect it — the same "leave existing connections alone" rule
    // POST /auth/rotate applies to every other MQTT client.
    brokerUsername = 'bridge'
    brokerPassword = tokenStore.get()
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
bridge = createBridge({ broker, cache, tokenStore, dashboardHtml })

bridge.httpServer.listen(config.port, config.host, () => {
  console.log(`mqtt-http-bridge on http://${config.host}:${config.port}, broker ${brokerName}`)
})

// A few seconds past the longest thing shutdown waits on: the grace period
// below is bounded by ECHO_TIMEOUT_MS, so the watchdog has to clear that
// plus whatever httpServer.close() and broker.end() take on top of it.
const SHUTDOWN_TIMEOUT_MS = ECHO_TIMEOUT_MS + 5000

let shuttingDown = false

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (shuttingDown) return
    shuttingDown = true

    // Armed before teardown starts: an await below hanging is exactly the
    // failure this exists to catch, so it can't depend on teardown reaching
    // its own end to get scheduled.
    const watchdog = setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS)
    watchdog.unref()

    try {
      // httpServer.close() never completes while an SSE stream is attached,
      // so the streams have to be ended first to make the server closable.
      for (const client of bridge.clients) client.close()
      bridge.clients.clear()

      await new Promise((resolve, reject) => {
        bridge.httpServer.close((err) => (err ? reject(err) : resolve()))
      })

      // A POST waiting on broker.publish gets dropped with no status if the
      // broker ends under it; give it a chance to get its own 503 from the
      // echo timeout instead.
      const deadline = Date.now() + ECHO_TIMEOUT_MS
      while (bridge.waiting() > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }

      await broker.end()
      await embedded?.close()
      process.exit(0)
    } catch (err) {
      console.error('shutdown failed:', err.message)
      process.exit(1)
    }
  })
}
