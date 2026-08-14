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

  client.on('message', (topic, payload, packet) => {
    cacheMessage(cache, topic, payload, packet)
    onMessage(topic, payload)
  })

  return {
    subscribed: ready,
    publish: (topic, payload) => client.publishAsync(topic, payload, { qos: 0, retain: true }),
    connected: () => client.connected,
    end: () => client.endAsync(),
  }
}

// Only a zero-length publish carrying the retain flag deletes a retained
// message. A zero-length publish without it is an ordinary message with an
// empty body, and dropping the topic for one would answer 404 for a topic the
// broker still holds.
export function cacheMessage(cache, topic, payload, packet) {
  if (payload.length === 0 && packet?.retain) cache.delete(topic)
  else cache.set(topic, payload)
}
