import mqtt from 'mqtt'

const RECONNECT_MS = 2000

// A broker on the same network echoes a publish back in a millisecond or two.
// The wait is long enough to cover a dropped connection being remade and the
// '#' subscription restored — one reconnect interval plus its round trips —
// so a blip answers 204 late rather than a false 503.
export const ECHO_TIMEOUT_MS = 5000

export function connectBroker({
  url,
  cache,
  onMessage,
  username,
  password,
  onConnect,
  onDisconnect,
  onError,
  echoTimeoutMs = ECHO_TIMEOUT_MS,
}) {
  const client = mqtt.connect(url, {
    username,
    password,
    reconnectPeriod: RECONNECT_MS,
    resubscribe: true,
  })

  // The client retries on its own, so a failed connection needs no handling
  // here. The listener stays because an 'error' event without one is thrown,
  // taking the process down whenever the broker refuses a connection.
  client.on('error', (err) => onError?.(err))

  let subscribed
  const ready = new Promise((resolve) => {
    subscribed = resolve
  })

  const waiting = new Map()
  let up = false

  client.on('connect', () => {
    up = true
    // What the cache holds came from the last connection. This one has its own
    // retained set, and anything missing from it no longer exists.
    cache.clear()
    onConnect?.()
    client.subscribe('#', { qos: 0 }, (err) => {
      if (err) onError?.(err)
      else subscribed()
    })
  })

  client.on('close', () => {
    if (!up) return
    up = false
    onDisconnect?.()
  })

  client.on('message', (topic, payload, packet) => {
    cacheMessage(cache, topic, payload, packet)
    onMessage(topic, payload)
    const waiters = waiting.get(topic)
    if (!waiters) return
    waiting.delete(topic)
    for (const waiter of waiters) waiter()
  })

  function echo(topic) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.get(topic)?.delete(arrived)
        reject(new Error(`the broker did not echo ${topic} within ${echoTimeoutMs} ms`))
      }, echoTimeoutMs)
      const arrived = () => {
        clearTimeout(timer)
        resolve()
      }
      const waiters = waiting.get(topic) ?? new Set()
      waiters.add(arrived)
      waiting.set(topic, waiters)
    })
  }

  return {
    subscribed: ready,
    // The bridge subscribes to '#', so its own publish comes back. Waiting for
    // it makes the broker the only writer of the cache, and is the only
    // evidence the broker took the message: publishing at QoS 0 does not fail
    // when the client is offline, it queues the packet and calls back whenever
    // a broker reappears.
    publish: (topic, payload) => {
      const echoed = echo(topic)
      client.publish(topic, payload, { qos: 0, retain: true }, () => {})
      return echoed
    },
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
