import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import net from 'node:net'
import path from 'node:path'
import tls from 'node:tls'

import mqtt from 'mqtt'

import { connectBroker } from '../src/broker.js'
import { createCache } from '../src/cache.js'
import { startEmbeddedBroker } from '../src/embedded-broker.js'
import { createTokenStore } from '../src/token-store.js'
import { waitFor, withTimeout } from './helpers/bridge.js'

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

test('TLS_CERT without TLS_KEY throws before listening', async () => {
  const { certPath, dir } = selfSignedCertFiles()
  try {
    await assert.rejects(
      () => startEmbeddedBroker({ mqttPort: 0, mqttsPort: 0, tlsCert: certPath }),
      /TLS_CERT and TLS_KEY must both be set, or neither/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TLS_KEY without TLS_CERT throws before listening', async () => {
  const { keyPath, dir } = selfSignedCertFiles()
  try {
    await assert.rejects(
      () => startEmbeddedBroker({ mqttPort: 0, mqttsPort: 0, tlsKey: keyPath }),
      /TLS_CERT and TLS_KEY must both be set, or neither/,
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

test('TLS: passing a tokenStore, rotating it gates new CONNECTs by the new token', async () => {
  const { certPath, keyPath, dir } = selfSignedCertFiles()
  try {
    const tokenStore = createTokenStore('s3cr3t')
    const embedded = await startEmbeddedBroker({
      mqttPort: 0,
      mqttsPort: 0,
      tlsCert: certPath,
      tlsKey: keyPath,
      tokenStore,
    })
    try {
      const withOld = await mqtt.connectAsync(embedded.url, {
        username: 'anyone',
        password: 's3cr3t',
        rejectUnauthorized: false,
      })
      await withOld.endAsync()

      tokenStore.rotate('rotated')

      await assert.rejects(() =>
        mqtt.connectAsync(embedded.url, {
          username: 'anyone',
          password: 's3cr3t',
          rejectUnauthorized: false,
          connectTimeout: 2000,
        }),
      )

      const withNew = await mqtt.connectAsync(embedded.url, {
        username: 'anyone',
        password: 'rotated',
        rejectUnauthorized: false,
      })
      await withNew.endAsync()
    } finally {
      await embedded.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a socket that never sends CONNECT does not block close()', async () => {
  const embedded = await startEmbeddedBroker({ mqttPort: 0, mqttsPort: 0 })
  const port = new URL(embedded.url).port
  const socket = net.connect(port, '127.0.0.1')
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  await withTimeout(embedded.close(), 2000, 'embedded broker close() with a pre-CONNECT socket open')
})

test('TLS: overwriting the cert and key files reloads the secure context', async () => {
  const { certPath, keyPath, dir } = selfSignedCertFiles({ subject: '/CN=original' })
  try {
    const embedded = await startEmbeddedBroker({
      mqttPort: 0,
      mqttsPort: 0,
      tlsCert: certPath,
      tlsKey: keyPath,
      authToken: 's3cr3t',
    })
    try {
      selfSignedCertFiles({ dir, subject: '/CN=rotated' })

      const port = new URL(embedded.url.replace('mqtts:', 'https:')).port
      await waitFor(() => new Promise((resolve) => {
        const socket = tls.connect({ port, host: '127.0.0.1', rejectUnauthorized: false }, () => {
          const subject = socket.getPeerCertificate().subject.CN
          socket.end()
          resolve(subject === 'rotated')
        })
        socket.once('error', () => resolve(false))
      }), 5000)
    } finally {
      await embedded.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TLS: renewing through a certbot-style live symlink reloads the secure context', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'bridge-embedded-certbot-'))
  try {
    const archive1 = path.join(root, 'archive1')
    const live = path.join(root, 'live')
    mkdirSync(archive1)
    mkdirSync(live)
    const { certPath: realCert1, keyPath: realKey1 } = selfSignedCertFiles({ dir: archive1, subject: '/CN=original' })
    const certPath = path.join(live, 'cert.pem')
    const keyPath = path.join(live, 'key.pem')
    symlinkSync(realCert1, certPath)
    symlinkSync(realKey1, keyPath)

    const embedded = await startEmbeddedBroker({
      mqttPort: 0,
      mqttsPort: 0,
      tlsCert: certPath,
      tlsKey: keyPath,
      authToken: 's3cr3t',
    })
    try {
      const port = new URL(embedded.url.replace('mqtts:', 'https:')).port
      const peerSubject = () => new Promise((resolve) => {
        const socket = tls.connect({ port, host: '127.0.0.1', rejectUnauthorized: false }, () => {
          const subject = socket.getPeerCertificate().subject.CN
          socket.end()
          resolve(subject)
        })
        socket.once('error', () => resolve(undefined))
      })
      assert.equal(await peerSubject(), 'original')

      const archive2 = path.join(root, 'archive2')
      mkdirSync(archive2)
      const { certPath: realCert2, keyPath: realKey2 } = selfSignedCertFiles({ dir: archive2, subject: '/CN=rotated' })

      // certbot repoints the live symlink by writing a new link at a temp
      // name and renaming it over the old one, not by editing the target file.
      const certTmp = path.join(live, 'cert.pem.tmp')
      symlinkSync(realCert2, certTmp)
      renameSync(certTmp, certPath)
      const keyTmp = path.join(live, 'key.pem.tmp')
      symlinkSync(realKey2, keyTmp)
      renameSync(keyTmp, keyPath)

      await waitFor(async () => (await peerSubject()) === 'rotated', 5000)
    } finally {
      await embedded.close()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function selfSignedCertFiles({ dir, subject = '/CN=test-only' } = {}) {
  dir = dir ?? mkdtempSync(path.join(tmpdir(), 'bridge-embedded-cert-'))
  const keyPath = path.join(dir, 'key.pem')
  const certPath = path.join(dir, 'cert.pem')
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath,
    '-days', '1', '-subj', subject,
  ])
  return { certPath, keyPath, dir }
}
