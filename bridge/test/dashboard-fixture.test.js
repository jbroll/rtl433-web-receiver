import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { startTestBridge } from './helpers/dashboard-fixture.js'

test('publish() resolves once the bridge itself serves the published bytes back', async () => {
  const fixture = await startTestBridge()
  try {
    await fixture.publish('src/Acurite/1234', '{"a":1}')
    const got = await fixture.get('src/Acurite/1234')
    assert.equal(got.status, 200)
    assert.equal(got.body, '{"a":1}')
  } finally {
    await fixture.close()
  }
})

test('get() on a topic with no message is 404', async () => {
  const fixture = await startTestBridge()
  try {
    const got = await fixture.get('src/Acurite/9999')
    assert.equal(got.status, 404)
  } finally {
    await fixture.close()
  }
})

test('onMessage fires for a publish, with the topic and payload bytes', async () => {
  const seen = []
  const fixture = await startTestBridge({ onMessage: (topic, payload) => seen.push([topic, payload]) })
  try {
    await fixture.publish('src/Acurite/1234', '{"a":1}')
    assert.equal(seen.length, 1)
    assert.equal(seen[0][0], 'src/Acurite/1234')
    assert.deepEqual(seen[0][1], Buffer.from('{"a":1}'))
  } finally {
    await fixture.close()
  }
})

test('authToken gates POST through the underlying bridge, same as createBridge alone', async () => {
  const fixture = await startTestBridge({ authToken: 's3cr3t' })
  try {
    const unauthed = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: fixture.httpPort, path: '/src/Acurite/1234', method: 'POST' },
        (res) => resolve(res.statusCode),
      )
      req.on('error', reject)
      req.end('{"a":1}')
    })
    assert.equal(unauthed, 401)
  } finally {
    await fixture.close()
  }
})

test('close() releases the HTTP port', async () => {
  const fixture = await startTestBridge()
  const { httpPort } = fixture
  await fixture.close()
  await assert.rejects(() =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: httpPort, path: '/x', method: 'GET' }, resolve)
      req.on('error', reject)
      req.end()
    }),
  )
})
