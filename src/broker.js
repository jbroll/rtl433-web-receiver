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

  // Swallowing these left a bridge that answered 503 to everything and said
  // nothing about why, for a wrong password as much as a missing broker. The
  // listener also has to exist: an 'error' event with none is thrown.
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
    // Waking on the topic alone answered a publish with someone else's
    // message. The same bytes from another publisher are still an answer:
    // the cache then holds exactly what this waiter published.
    for (const waiter of waiting.get(topic) ?? []) {
      if (waiter.payload.equals(payload)) waiter.arrived()
    }
  })

  function echo(topic, payload) {
    const expected = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
    return new Promise((resolve, reject) => {
      const waiter = {
        payload: expected,
        arrived: () => {
          clearTimeout(timer)
          forget()
          resolve()
        },
      }
      const timer = setTimeout(() => {
        forget()
        reject(new Error(`the broker did not echo ${topic} within ${echoTimeoutMs} ms`))
      }, echoTimeoutMs)
      // An empty Set left behind is a topic's worth of memory per publish
      // that ever timed out.
      const forget = () => {
        const waiters = waiting.get(topic)
        if (!waiters) return
        waiters.delete(waiter)
        if (waiters.size === 0) waiting.delete(topic)
      }
      const waiters = waiting.get(topic) ?? new Set()
      waiters.add(waiter)
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
      const echoed = echo(topic, payload)
      client.publish(topic, payload, { qos: 0, retain: true }, () => {})
      return echoed
    },
    waiting: () => waiting.size,
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
