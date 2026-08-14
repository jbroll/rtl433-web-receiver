import mqtt from 'mqtt'

export function connectBroker({ url, cache, onMessage, username, password }) {
  const client = mqtt.connect(url, {
    username,
    password,
    reconnectPeriod: 2000,
    resubscribe: true,
  })

  // The client retries on its own, so a failed connection needs no handling.
  // An 'error' event with no listener would be thrown instead, taking the
  // process down whenever the broker is not there yet.
  client.on('error', () => {})

  let subscribed
  const ready = new Promise((resolve) => {
    subscribed = resolve
  })

  client.on('connect', () => {
    client.subscribe('#', { qos: 0 }, () => subscribed())
  })

  client.on('message', (topic, payload) => {
    // A zero-length retained publish is how MQTT deletes a retained message.
    // Caching the empty payload would serve a 200 for something the broker no
    // longer holds.
    if (payload.length === 0) cache.delete(topic)
    else cache.set(topic, payload)
    onMessage(topic, payload)
  })

  return {
    subscribed: ready,
    publish: (topic, payload) => client.publishAsync(topic, payload, { qos: 0, retain: true }),
    connected: () => client.connected,
    end: () => client.endAsync(),
  }
}
