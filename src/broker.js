import mqtt from 'mqtt'

export async function connectBroker({ url, cache, onMessage, username, password }) {
  const client = await mqtt.connectAsync(url, {
    username,
    password,
    reconnectPeriod: 2000,
    resubscribe: true,
  })

  client.on('message', (topic, payload) => {
    const text = payload.toString('utf8')
    cache.set(topic, text)
    onMessage(topic, text)
  })

  await client.subscribeAsync('#', { qos: 0 })

  return {
    publish: (topic, payload) => client.publishAsync(topic, payload, { qos: 0, retain: true }),
    connected: () => client.connected,
    end: () => client.endAsync(),
  }
}
