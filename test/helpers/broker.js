import net from 'node:net'

import Aedes from 'aedes'

// Every broker is reached through a proxy so a test can give the connection
// latency or make it swallow traffic without the client noticing. Setting
// MQTT_TEST_LATENCY_MS runs the whole suite over a slow link, which is what
// tells a timing-dependent test from a correct one.
const DEFAULT_DELAY_MS = Number(process.env.MQTT_TEST_LATENCY_MS ?? 0)

export async function startBroker(
  listenPort = 0,
  { delayMs = DEFAULT_DELAY_MS, refuseSubscribe = false } = {},
) {
  const aedes = new Aedes()
  if (refuseSubscribe) {
    aedes.authorizeSubscribe = (client, sub, done) => done(new Error('subscription refused'))
  }
  const server = net.createServer(aedes.handle)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

  const proxy = await startProxy({ target: server.address().port, listenPort, delayMs })

  return {
    url: `mqtt://127.0.0.1:${proxy.port}`,
    port: proxy.port,
    blackhole: proxy.blackhole,
    close: async () => {
      await proxy.close()
      await new Promise((resolve) => aedes.close(() => server.close(resolve)))
    },
  }
}

async function startProxy({ target, listenPort, delayMs }) {
  const sockets = new Set()
  let dropping = false

  const relay = (from, to) => {
    from.on('data', (chunk) => {
      if (dropping) return
      // Equal delays fire in the order they were set, so the byte stream
      // stays in order.
      if (delayMs > 0) setTimeout(() => forward(to, chunk), delayMs)
      else forward(to, chunk)
    })
    from.on('error', () => to.destroy())
    from.on('close', () => to.destroy())
  }

  const forward = (to, chunk) => {
    if (!dropping && to.writable) to.write(chunk)
  }

  const server = net.createServer((incoming) => {
    const outgoing = net.connect(target, '127.0.0.1')
    sockets.add(incoming).add(outgoing)
    incoming.on('close', () => sockets.delete(incoming))
    outgoing.on('close', () => sockets.delete(outgoing))
    relay(incoming, outgoing)
    relay(outgoing, incoming)
  })
  await new Promise((resolve) => server.listen(listenPort, '127.0.0.1', resolve))

  return {
    port: server.address().port,
    blackhole: () => {
      dropping = true
    },
    close: async () => {
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
