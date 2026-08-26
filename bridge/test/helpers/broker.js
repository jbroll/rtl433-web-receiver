import net from 'node:net'

import Aedes from 'aedes'

// Every broker is reached through a proxy so a test can give the connection
// latency or make it swallow traffic without the client noticing. Setting
// MQTT_TEST_LATENCY_MS runs the whole suite over a slow link, which is what
// tells a timing-dependent test from a correct one.
const DEFAULT_DELAY_MS = Number(process.env.MQTT_TEST_LATENCY_MS ?? 0)

const MQTT_SUBSCRIBE = 8

// A minimal MQTT fixed-header parser, enough to tell packet types apart.
// Buffers across chunks so a packet split by TCP is counted once, not twice.
function countMqttPacketTypes(onType) {
  let buffer = Buffer.alloc(0)
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    for (;;) {
      if (buffer.length < 2) return
      let multiplier = 1
      let remainingLength = 0
      let i = 1
      let byte
      do {
        if (i >= buffer.length) return
        byte = buffer[i]
        remainingLength += (byte & 0x7f) * multiplier
        multiplier *= 128
        i += 1
      } while ((byte & 0x80) !== 0)
      const packetLength = i + remainingLength
      if (buffer.length < packetLength) return
      onType(buffer[0] >> 4)
      buffer = buffer.subarray(packetLength)
    }
  }
}

// A test that names its own delay needs at least that much; the setting is a
// floor under the whole suite, so no test runs on a faster link than it asks
// for.
export async function startBroker(listenPort = 0, { delayMs = 0, refuseSubscribe = false } = {}) {
  const delay = Math.max(delayMs, DEFAULT_DELAY_MS)
  const aedes = new Aedes()
  if (refuseSubscribe) {
    aedes.authorizeSubscribe = (client, sub, done) => done(new Error('subscription refused'))
  }
  const server = net.createServer(aedes.handle)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

  const proxy = await startProxy({ target: server.address().port, listenPort, delayMs: delay })

  return {
    url: `mqtt://127.0.0.1:${proxy.port}`,
    // Reaches the broker without the proxy, so a client here keeps talking
    // while the proxied one is cut off.
    directUrl: `mqtt://127.0.0.1:${server.address().port}`,
    port: proxy.port,
    blackhole: proxy.blackhole,
    dropConnections: proxy.dropConnections,
    subscribeCount: proxy.subscribeCount,
    close: async () => {
      await proxy.close()
      await new Promise((resolve) => aedes.close(() => server.close(resolve)))
    },
  }
}

async function startProxy({ target, listenPort, delayMs }) {
  const sockets = new Set()
  let dropping = 'nothing'

  const drops = (direction) => dropping === 'both' || dropping === direction

  const forward = (to, chunk, direction) => {
    if (!drops(direction) && to.writable) to.write(chunk)
  }

  let subscribeCount = 0

  const server = net.createServer((incoming) => {
    const outgoing = net.connect(target, '127.0.0.1')
    sockets.add(incoming).add(outgoing)
    incoming.on('close', () => sockets.delete(incoming))
    outgoing.on('close', () => sockets.delete(outgoing))

    // Counts only what the client sends, so a reconnect after a dropped
    // connection starts this proxy connection's count fresh rather than
    // carrying a partial MQTT packet over from the last one.
    const countUp = countMqttPacketTypes((type) => {
      if (type === MQTT_SUBSCRIBE) subscribeCount += 1
    })

    const relay = (from, to, direction) => {
      from.on('data', (chunk) => {
        if (drops(direction)) return
        if (direction === 'up') countUp(chunk)
        // Equal delays fire in the order they were set, so the byte stream
        // stays in order.
        if (delayMs > 0) setTimeout(() => forward(to, chunk, direction), delayMs)
        else forward(to, chunk, direction)
      })
      from.on('error', () => to.destroy())
      from.on('close', () => to.destroy())
    }

    relay(incoming, outgoing, 'up')
    relay(outgoing, incoming, 'down')
  })
  await new Promise((resolve) => server.listen(listenPort, '127.0.0.1', resolve))

  return {
    port: server.address().port,
    // 'up' drops what the client sends and leaves what the broker sends
    // coming, which is a publish the broker never took on a live connection.
    blackhole: (direction = 'both') => {
      dropping = direction
    },
    // Severs every socket without closing the listener, forcing the mqtt
    // client to reconnect and run its 'connect' handler a second time.
    dropConnections: () => {
      for (const socket of sockets) socket.destroy()
    },
    subscribeCount: () => subscribeCount,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
