import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildHtml, deviceMax } from '../build.js'

test('the build inlines everything into one document', async () => {
  const html = await buildHtml()
  assert.match(html, /^<!doctype html>/i)
  assert.match(html, /<style>/)
  assert.match(html, /<script>/)
  assert.doesNotMatch(html, /<script[^>]+\ssrc=/)
  assert.doesNotMatch(html, /<link[^>]+rel=["']?stylesheet/)
  assert.doesNotMatch(html, /https?:\/\//)
})

test('the device cap comes from the firmware header', async () => {
  const n = await deviceMax()
  assert.equal(n, 24)
  const html = await buildHtml()
  assert.doesNotMatch(html, /DEVICE_MAX/)
  assert.match(html, /24/)
})
