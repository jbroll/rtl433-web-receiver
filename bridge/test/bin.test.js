import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import mqtt from 'mqtt'

import { freePort, startChild } from './helpers/bin.js'

function selfSignedCertFiles() {
  const dir = mkdtempSync(path.join(tmpdir(), 'bridge-bin-cert-'))
  const keyPath = path.join(dir, 'key.pem')
  const certPath = path.join(dir, 'cert.pem')
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath,
    '-days', '1', '-subj', '/CN=test-only',
  ])
  return { certPath, keyPath, dir }
}

test('POST /-/auth/rotate gates the next MQTT CONNECT by the new token', async () => {
  const { certPath, keyPath, dir: certDir } = selfSignedCertFiles()
  const tokenDir = mkdtempSync(path.join(tmpdir(), 'bridge-bin-token-'))
  const tokenPath = path.join(tokenDir, 'token')
  writeFileSync(tokenPath, 'orig-token')
  const mqttsPort = await freePort()

  const child = await startChild(
    ['--tls-cert', certPath, '--tls-key', keyPath, '--auth-token-path', tokenPath, '--mqtts-port', String(mqttsPort)],
    {},
    { authToken: 'orig-token' },
  )
  try {
    const rotated = await fetch(`${child.base}/-/auth/rotate`, {
      method: 'POST',
      body: JSON.stringify({ token: 'new-token' }),
      headers: { authorization: 'Bearer orig-token' },
    })
    assert.equal(rotated.status, 204)

    const url = `mqtts://127.0.0.1:${mqttsPort}`
    await assert.rejects(() =>
      mqtt.connectAsync(url, {
        username: 'anyone',
        password: 'orig-token',
        rejectUnauthorized: false,
        connectTimeout: 2000,
      }),
    )

    const withNew = await mqtt.connectAsync(url, {
      username: 'anyone',
      password: 'new-token',
      rejectUnauthorized: false,
    })
    await withNew.endAsync()
  } finally {
    child.kill('SIGKILL')
    rmSync(certDir, { recursive: true, force: true })
    rmSync(tokenDir, { recursive: true, force: true })
  }
})

test('--dashboard-html serves that file at GET /', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bridge-bin-dashboard-'))
  const htmlPath = path.join(dir, 'dashboard.html')
  const html = '<!doctype html><title>bin test dashboard</title>'
  writeFileSync(htmlPath, html)

  const child = await startChild(['--dashboard-html', htmlPath, '--mqtt-port', '0'])
  try {
    const res = await fetch(`${child.base}/`)
    assert.equal(res.status, 200)
    assert.equal(await res.text(), html)
  } finally {
    child.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
})
