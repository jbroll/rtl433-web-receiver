import mqtt from 'mqtt'

import { brokerLabel } from './config.js'

const RECONNECT_MS = 2000

// '#' never matches a topic whose first segment starts with '$' (src/topic.js
// enforces the same rule), so a $-leading topic name the binding uses has to
// be subscribed to explicitly. $tz is the only one today.
const DOLLAR_TOPICS = ['$tz']

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
  reconnectMs = RECONNECT_MS,
  tls,
}) {
  const label = brokerLabel(url)

  const client = mqtt.connect(url, {
    username,
    password,
    reconnectPeriod: reconnectMs,
    // mqtt.js's own resubscribe would race the manual client.subscribe below
    // and land a second, redundant SUBSCRIBE.
    resubscribe: false,
    // Only set for the embedded broker's own internal TLS connection in
    // src/embedded-broker.js: a loopback self-connection to a certificate
    // issued for the public domain, not 127.0.0.1, which Node's default
    // hostname check would otherwise reject. Every other caller leaves this
    // undefined and gets today's behavior unchanged.
    ...(tls ?? {}),
  })

  let ending = false

  // Swallowing these left a bridge that answered 503 to everything and said
  // nothing about why, for a wrong password as much as a missing broker. The
  // listener also has to exist: an 'error' event with none is thrown.
  // Reporting each retry instead filled a log with the same line every two
  // seconds, so an error is reported only when it is not the one already
  // reported, and a successful subscription clears what was. A subscribe
  // failure goes through the same path: TCP connects fine on every retry, so
  // clearing on 'connect' instead would let an unchanging subscribe refusal
  // print once per reconnect forever.
  let reported = null
  let lastError = null
  const report = (err) => {
    if (ending || err.message === reported) return
    reported = err.message
    lastError = redact(err.message, { username, password })
    onError?.(err)
  }
  client.on('error', report)

  let subscribed
  const subscribedOnce = new Promise((resolve) => {
    subscribed = resolve
  })

  const waiting = new Map()
  let up = false
  let ready = false

  client.on('connect', () => {
    up = true
    // What the cache holds came from the last connection. This one has its own
    // retained set, and anything missing from it no longer exists.
    cache.clear()
    onConnect?.()
    client.subscribe(['#', ...DOLLAR_TOPICS], { qos: 0 }, (err) => {
      if (err) {
        ready = false
        report(err)
      } else {
        reported = null
        ready = true
        subscribed()
      }
    })
  })

  // 'close' fires on every failed retry, the loss itself, and the shutdown
  // that asked for it; the subscription is gone in every case.
  client.on('close', () => {
    ready = false
    if (!up || ending) return
    up = false
    onDisconnect?.()
  })

  client.on('message', (topic, payload, packet) => {
    const result = cacheMessage(cache, topic, payload, packet)
    onMessage(topic, payload, result === 'deleted')
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
    subscribed: subscribedOnce,
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
    // True from CONNACK to the next 'close', regardless of the subscription.
    connected: () => client.connected,
    // True only once '#' is subscribed, false again on 'close' or a subscribe
    // error. What the HTTP 503 gates use.
    ready: () => ready,
    label,
    lastError: () => lastError,
    end: () => {
      ending = true
      return client.endAsync()
    },
  }
}

// A username or password echoed into an error message would otherwise reach
// GET /-/status, which is unauthenticated.
//
// Two sequential .split/.join passes break when one credential is a
// substring of the other: replacing the first fractures the second so it no
// longer matches, and the leftover fragment survives in plaintext (username
// "joe" against password "joepass123" leaves "***pass123"). Sorting
// longest-first doesn't fix partially overlapping credentials that share no
// containment either way (username "abc", password "cde", message "abcde").
//
// A single left-to-right scan is correct for every case: at each position,
// try every credential and take the longest one that matches there, emit
// "***" and skip past it; otherwise emit the character and advance by one.
// Because the scan only ever advances past text it has already decided on,
// nothing already emitted can be disturbed by a later match — unlike
// sequential whole-message replacement passes.
export function redact(message, { username, password } = {}) {
  const credentials = [username, password].filter((credential) => credential)
  if (credentials.length === 0) return message

  let redacted = ''
  let i = 0
  while (i < message.length) {
    let matchLength = 0
    for (const credential of credentials) {
      if (
        credential.length > matchLength &&
        message.startsWith(credential, i)
      ) {
        matchLength = credential.length
      }
    }
    if (matchLength > 0) {
      redacted += '***'
      i += matchLength
    } else {
      redacted += message[i]
      i += 1
    }
  }
  return redacted
}

// A zero-length publish carrying the retain flag deletes a retained message
// outright. A broker clears the retain flag on anything it forwards to an
// already-established subscription, so a live-seen delete cannot be told
// from an ordinary empty message that way; the cached message being
// non-empty just before is the only signal left, and it is what a foreign
// publisher's non-retained empty message is mistaken for too (see
// docs/architecture.md, "Payloads stay bytes"). Either way the cache holds
// the empty payload, not a missing entry, so GET still 404s.
export function cacheMessage(cache, topic, payload, packet) {
  if (payload.length === 0 && packet?.retain) {
    cache.delete(topic)
    return 'deleted'
  }
  const hadMessage = cache.get(topic)?.length > 0
  cache.set(topic, payload)
  return payload.length === 0 && hadMessage ? 'deleted' : 'set'
}
