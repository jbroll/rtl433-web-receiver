import { spawn } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { waitFor } from './bridge.js'

export const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'mqtt-http-bridge.js')

// bin/mqtt-http-bridge.js logs config.port verbatim, not the port it bound,
// so PORT=0 can't be read back from stdout; pick a free one up front instead.
export async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

// authToken lets a caller that starts the child with an AUTH_TOKEN configured
// still clear the warmup probe, which POSTs like any other publisher.
export async function startChild(args = [], env = {}, { authToken } = {}) {
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, [BIN, ...args], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ...env },
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const exited = new Promise((resolve) => child.once('exit', resolve))
  const headers = authToken ? { authorization: `Bearer ${authToken}` } : undefined

  try {
    // The subscription this waits for is what lets a POST's echo ever
    // arrive; without it every publish in a test times out regardless of
    // the code under test.
    await waitFor(async () => {
      try {
        return (await fetch(`${base}/warmup/ready`, { method: 'POST', body: '{}', headers })).status === 204
      } catch {
        return false
      }
    }, 10000)
  } catch (err) {
    // Left running, this child keeps its stdio pipes open and hangs
    // `node --test` long after the test that spawned it has failed.
    child.kill('SIGKILL')
    throw err
  }

  return {
    base,
    exitCode: () => exited,
    stderr: () => stderr,
    kill: (signal) => child.kill(signal),
  }
}
