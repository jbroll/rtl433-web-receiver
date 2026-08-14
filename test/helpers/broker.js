import { createServer } from 'node:net'

import Aedes from 'aedes'

export async function startBroker() {
  const aedes = new Aedes()
  const server = createServer(aedes.handle)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  return {
    url: `mqtt://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => aedes.close(resolve))
      }),
  }
}
