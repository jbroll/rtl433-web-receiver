import http from 'node:http'

import mqtt from 'mqtt'

import { connectBroker } from '../../src/broker.js'
import { createCache } from '../../src/cache.js'
import { createBridge } from '../../src/server.js'
import { startEmbeddedBroker } from '../../src/embedded-broker.js'
import { waitFor } from './bridge.js'

// Bundles an in-process aedes broker with a real createBridge() and an mqtt
// publisher client, so a test drives the bridge the way production does:
// publish over MQTT, read back over HTTP.
export async function startTestBridge(opts = {}) {
  const embedded = await startEmbeddedBroker({ mqttPort: 0, mqttsPort: 0 })
  const cache = createCache()
  const brokerConn = connectBroker({
    url: embedded.url,
    cache,
    onMessage: opts.onMessage ?? (() => {}),
  })
  const bridge = createBridge({ broker: brokerConn, cache, authToken: opts.authToken })
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
  // way for an MQTT-side publish.
  async function publish(topic, json) {
    await publisher.publishAsync(topic, json, { qos: 0, retain: true })
    await waitFor(async () => (await get(topic)).body === json)
  }

  return {
    url: `http://127.0.0.1:${httpPort}/`,
    httpPort,
    publish,
    get,
    close: async () => {
      await publisher.endAsync()
      await new Promise((resolve) => bridge.httpServer.close(resolve))
      await brokerConn.end()
      await embedded.close()
    },
  }
}
