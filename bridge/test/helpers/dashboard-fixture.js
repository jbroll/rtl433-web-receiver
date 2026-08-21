import http from 'node:http'

import mqtt from 'mqtt'

import { connectBroker } from '../../src/broker.js'
import { createCache } from '../../src/cache.js'
import { createBridge } from '../../src/server.js'
import { startEmbeddedBroker } from '../../src/embedded-broker.js'
import { waitFor } from './bridge.js'

// Long enough to outlast a loaded machine running the whole Playwright suite.
const LANDED_MS = 10000

// Bundles an in-process aedes broker with a real createBridge() and an mqtt
// publisher client, so a test drives the bridge the way production does:
// publish over MQTT, read back over HTTP.
export async function startTestBridge(opts = {}) {
  let closed = false
  const embedded = await startEmbeddedBroker({ mqttPort: 0, mqttsPort: 0 })
  const cache = createCache()
  let bridge
  const brokerConn = connectBroker({
    url: embedded.url,
    cache,
    // Broadcasting is what feeds /events; opts.onMessage only observes.
    onMessage: (topic, payload) => {
      bridge?.broadcast(topic, payload)
      opts.onMessage?.(topic, payload)
    },
  })
  bridge = createBridge({ broker: brokerConn, cache, authToken: opts.authToken })
  await new Promise((resolve) => bridge.httpServer.listen(0, '127.0.0.1', resolve))
  const { port: httpPort } = bridge.httpServer.address()

  const publisher = await mqtt.connectAsync(embedded.url)
  await brokerConn.subscribed

  function get(topic) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: httpPort,
          path: '/' + topic.split('/').map(encodeURIComponent).join('/'),
          method: 'GET',
        },
        (res) => {
          let body = ''
          res.setEncoding('utf8')
          res.on('data', (chunk) => (body += chunk))
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
        },
      )
      req.on('error', reject)
      req.end()
    })
  }

  // The publisher is a separate MQTT client from the bridge's own internal
  // one, so nothing else guarantees ordering between "publish returned" and
  // "the bridge's cache reflects it." Polling the bridge's own GET is what
  // bridge/src/broker.js's echo() solves for HTTP POST, solved here the same
  // way for an MQTT-side publish. A zero-length retained publish is a delete,
  // so there what proves it landed is the topic going away.
  //
  // Nothing is thrown once the fixture is closed: a caller that does not await
  // a publish would turn that into an unhandled rejection charged to whatever
  // test happens to be running by then.
  async function publish(topic, json) {
    if (closed) return
    await publisher.publishAsync(topic, json, { qos: 0, retain: true })
    const landed = async () => {
      if (closed) return true
      const res = await get(topic)
      return json.length === 0 ? res.status === 404 : res.body === json
    }
    try {
      await waitFor(landed, LANDED_MS)
    } catch (err) {
      if (closed) return
      if (err.message === 'timed out waiting for condition') {
        throw new Error(`the bridge never took a publish of ${topic}`)
      }
      throw err
    }
  }

  return {
    url: `http://127.0.0.1:${httpPort}/`,
    httpPort,
    publish,
    get,
    close: async () => {
      closed = true
      await publisher.endAsync()
      for (const client of bridge.clients) client.close()
      bridge.clients.clear()
      await new Promise((resolve) => bridge.httpServer.close(resolve))
      await brokerConn.end()
      await embedded.close()
    },
  }
}
