import { test } from 'node:test'
import assert from 'node:assert/strict'

import { startBridge } from './helpers/bridge.js'

test('POST /auth/rotate with no AUTH_TOKEN configured is 404', async () => {
  const bridge = await startBridge()
  try {
    const res = await fetch(`${bridge.base}/auth/rotate`, {
      method: 'POST',
      body: JSON.stringify({ token: 'new' }),
    })
    assert.equal(res.status, 404)
  } finally {
    await bridge.close()
  }
})

test('POST /auth/rotate with a wrong or missing current token is 401', async () => {
  const bridge = await startBridge({ authToken: 's3cr3t' })
  try {
    const missing = await fetch(`${bridge.base}/auth/rotate`, {
      method: 'POST',
      body: JSON.stringify({ token: 'new' }),
    })
    assert.equal(missing.status, 401)

    const wrong = await fetch(`${bridge.base}/auth/rotate`, {
      method: 'POST',
      body: JSON.stringify({ token: 'new' }),
      headers: { authorization: 'Bearer wrong' },
    })
    assert.equal(wrong.status, 401)
  } finally {
    await bridge.close()
  }
})

test('GET /auth/rotate is 405', async () => {
  const bridge = await startBridge({ authToken: 's3cr3t' })
  try {
    const res = await fetch(`${bridge.base}/auth/rotate`)
    assert.equal(res.status, 405)
  } finally {
    await bridge.close()
  }
})

test('a non-JSON or empty-token body is 400 and does not rotate', async () => {
  const bridge = await startBridge({ authToken: 's3cr3t' })
  try {
    const notJson = await fetch(`${bridge.base}/auth/rotate`, {
      method: 'POST',
      body: 'not json',
      headers: { authorization: 'Bearer s3cr3t' },
    })
    assert.equal(notJson.status, 400)

    const empty = await fetch(`${bridge.base}/auth/rotate`, {
      method: 'POST',
      body: JSON.stringify({ token: '' }),
      headers: { authorization: 'Bearer s3cr3t' },
    })
    assert.equal(empty.status, 400)

    // The old token still gates POST: neither bad request rotated it out.
    const stillOld = await fetch(`${bridge.base}/src/Acurite/1234`, {
      method: 'POST',
      body: '{"a":1}',
      headers: { authorization: 'Bearer s3cr3t' },
    })
    assert.equal(stillOld.status, 204)
  } finally {
    await bridge.close()
  }
})

test('a valid rotation is 204, and the new token gates POST while the old one 401s', async () => {
  const bridge = await startBridge({ authToken: 's3cr3t' })
  try {
    const rotated = await fetch(`${bridge.base}/auth/rotate`, {
      method: 'POST',
      body: JSON.stringify({ token: 'n3wt0k3n' }),
      headers: { authorization: 'Bearer s3cr3t' },
    })
    assert.equal(rotated.status, 204)

    const withOld = await fetch(`${bridge.base}/src/Acurite/1234`, {
      method: 'POST',
      body: '{"a":1}',
      headers: { authorization: 'Bearer s3cr3t' },
    })
    assert.equal(withOld.status, 401)

    const withNew = await fetch(`${bridge.base}/src/Acurite/1234`, {
      method: 'POST',
      body: '{"a":1}',
      headers: { authorization: 'Bearer n3wt0k3n' },
    })
    assert.equal(withNew.status, 204)
  } finally {
    await bridge.close()
  }
})
