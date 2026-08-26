import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { waitFor } from './helpers/bridge.js'
import { startBroker } from './helpers/broker.js'

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mqtt-http-bridge.js')

// bin/mqtt-http-bridge.js logs config.port verbatim, not the port it bound,
// so PORT=0 can't be read back from stdout; pick a free one up front instead.
async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

async function startChild(brokerUrl) {
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, [BIN, '--no-embed-broker', '--broker-url', brokerUrl], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const exited = new Promise((resolve) => child.once('exit', resolve))

  // The subscription this waits for is what lets a POST's echo ever arrive;
  // without it every publish in the test times out regardless of the code
  // under test.
  await waitFor(async () => {
    try {
      return (await fetch(`${base}/warmup/ready`, { method: 'POST', body: '{}' })).status === 204
    } catch {
      return false
    }
  }, 10000)

  return {
    base,
    exitCode: () => exited,
    stderr: () => stderr,
    kill: (signal) => child.kill(signal),
  }
}

test('SIGTERM while a POST is stalled on the broker answers 503 and the process exits 0', async (t) => {
  t.diagnostic('this test waits out the broker echo timeout; it is expected to take several seconds')
  const broker = await startBroker(0)
  try {
    const child = await startChild(broker.url)
    try {
      broker.blackhole('up')
      const posted = fetch(`${child.base}/src/Acurite/1`, { method: 'POST', body: '{"a":1}' })

      // Give the POST time to reach the handler and start awaiting the echo
      // before the signal lands.
      await new Promise((resolve) => setTimeout(resolve, 200))
      child.kill('SIGTERM')

      const response = await posted
      assert.equal(response.status, 503)
      assert.equal(await child.exitCode(), 0)
    } finally {
      child.kill('SIGKILL')
    }
  } finally {
    await broker.close()
  }
}, { timeout: 20_000 })

test('a second SIGTERM during teardown does not start a second teardown', async (t) => {
  t.diagnostic('this test waits out the broker echo timeout; it is expected to take several seconds')
  const broker = await startBroker(0)
  try {
    const child = await startChild(broker.url)
    try {
      broker.blackhole('up')
      const posted = fetch(`${child.base}/src/Acurite/1`, { method: 'POST', body: '{"a":1}' })

      await new Promise((resolve) => setTimeout(resolve, 200))
      child.kill('SIGTERM')
      await new Promise((resolve) => setTimeout(resolve, 200))
      child.kill('SIGTERM')

      const response = await posted
      assert.equal(response.status, 503)
      assert.equal(await child.exitCode(), 0)
      assert.doesNotMatch(child.stderr(), /shutdown failed/)
    } finally {
      child.kill('SIGKILL')
    }
  } finally {
    await broker.close()
  }
}, { timeout: 20_000 })
