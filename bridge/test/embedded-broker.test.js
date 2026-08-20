import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import mqtt from 'mqtt'

import { connectBroker } from '../src/broker.js'
import { createCache } from '../src/cache.js'
import { startEmbeddedBroker } from '../src/embedded-broker.js'
import { waitFor } from './helpers/bridge.js'

test('no TLS: aedes listens on loopback, and connectBroker reaches it', async () => {
  const embedded = await startEmbeddedBroker({ mqttPort: 0, mqttsPort: 0 })
  try {
    assert.match(embedded.url, /^mqtt:\/\/127\.0\.0\.1:\d+$/)
    assert.equal(embedded.tlsOptions, undefined)

    const cache = createCache()
    const client = connectBroker({ url: embedded.url, cache, onMessage: () => {} })
    try {
      await client.subscribed
      await client.publish('src/Acurite/1', '{"t":1}')
      await waitFor(() => cache.get('src/Acurite/1') !== undefined)
      assert.deepEqual(cache.get('src/Acurite/1'), Buffer.from('{"t":1}'))
    } finally {
      await client.end()
    }
  } finally {
    await embedded.close()
  }
})

test('no TLS: mqttPort 0 lets the OS pick a free port, not the 1883 default', async () => {
  const embedded = await startEmbeddedBroker({ mqttPort: 0, mqttsPort: 0 })
  try {
    assert.doesNotMatch(embedded.url, /:1883$/)
  } finally {
    await embedded.close()
  }
})

test('TLS configured without AUTH_TOKEN throws before listening', async () => {
  const { certPath, keyPath, dir } = selfSignedCertFiles()
  try {
    await assert.rejects(
      () => startEmbeddedBroker({ mqttPort: 0, mqttsPort: 0, tlsCert: certPath, tlsKey: keyPath }),
      /AUTH_TOKEN/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TLS: a client with the right token connects, a wrong or missing one is refused', async () => {
  const { certPath, keyPath, dir } = selfSignedCertFiles()
  try {
    const embedded = await startEmbeddedBroker({
      mqttPort: 0,
      mqttsPort: 0,
      tlsCert: certPath,
      tlsKey: keyPath,
      authToken: 's3cr3t',
    })
    try {
      assert.match(embedded.url, /^mqtts:\/\/127\.0\.0\.1:\d+$/)
      assert.deepEqual(embedded.tlsOptions, { rejectUnauthorized: false })

      const good = await mqtt.connectAsync(embedded.url, {
        username: 'anyone',
        password: 's3cr3t',
        rejectUnauthorized: false,
      })
      await good.endAsync()

      await assert.rejects(() =>
        mqtt.connectAsync(embedded.url, {
          username: 'anyone',
          password: 'wrong',
          rejectUnauthorized: false,
          connectTimeout: 2000,
        }),
      )

      await assert.rejects(() =>
        mqtt.connectAsync(embedded.url, {
          username: 'anyone',
          rejectUnauthorized: false,
          connectTimeout: 2000,
        }),
      )
    } finally {
      await embedded.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TLS: the bridge itself can reach its own embedded broker over loopback', async () => {
  const { certPath, keyPath, dir } = selfSignedCertFiles()
  try {
    const embedded = await startEmbeddedBroker({
      mqttPort: 0,
      mqttsPort: 0,
      tlsCert: certPath,
      tlsKey: keyPath,
      authToken: 's3cr3t',
    })
    try {
      const cache = createCache()
      const client = connectBroker({
        url: embedded.url,
        cache,
        onMessage: () => {},
        tls: embedded.tlsOptions,
        // mqtt.js's underlying mqtt-packet encoder refuses to send a
        // CONNECT with a password and no username at all ("Username is
        // required to use password"), so a username is required here even
        // though aedes's authenticate hook (src/embedded-broker.js) accepts
        // any username and checks only the password.
        username: 'bridge',
        password: 's3cr3t',
      })
      try {
        await client.subscribed
        await client.publish('src/Acurite/1', '{"t":1}')
        await waitFor(() => cache.get('src/Acurite/1') !== undefined)
      } finally {
        await client.end()
      }
    } finally {
      await embedded.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function selfSignedCertFiles() {
  const dir = mkdtempSync(path.join(tmpdir(), 'bridge-embedded-cert-'))
  const keyPath = path.join(dir, 'key.pem')
  const certPath = path.join(dir, 'cert.pem')
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath,
    '-days', '1', '-subj', '/CN=test-only',
  ])
  return { certPath, keyPath, dir }
}
