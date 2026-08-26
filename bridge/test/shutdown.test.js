import { test } from 'node:test'
import assert from 'node:assert/strict'

import { startChild } from './helpers/bin.js'
import { startBroker } from './helpers/broker.js'

test('SIGTERM while a POST is stalled on the broker answers 503 and the process exits 0', async (t) => {
  t.diagnostic('this test waits out the broker echo timeout; it is expected to take several seconds')
  const broker = await startBroker(0)
  try {
    const child = await startChild(['--no-embed-broker', '--broker-url', broker.url])
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
    const child = await startChild(['--no-embed-broker', '--broker-url', broker.url])
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
