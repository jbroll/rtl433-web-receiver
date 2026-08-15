import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { buildHtml, deviceMax } from '../build.js'

test('the build inlines everything into one document', async () => {
  const html = await buildHtml()
  assert.match(html, /^<!doctype html>/i)
  assert.match(html, /<style>/)
  assert.match(html, /<script>/)
  assert.doesNotMatch(html, /<script[^>]+\ssrc=/)
  assert.doesNotMatch(html, /<link[^>]+rel=["']?stylesheet/)
  // A placeholder attribute value is example text, not a request; only a
  // reference site (script src, stylesheet href, fetch target) matters here.
  assert.doesNotMatch(html, /\s(?:src|href)\s*=\s*["']https?:\/\//i)
  assert.doesNotMatch(html, /\bfetch\(\s*["']https?:\/\//)
})

test('the device cap comes from the firmware header', async () => {
  const header = await readFile(
    new URL('../../receiver/signal_store.h', import.meta.url), 'utf8')
  const declared = Number(header.match(/^#define\s+SIGNAL_DEVICE_SLOTS\s+(\d+)/m)[1])
  assert.equal(await deviceMax(), declared)

  const html = await buildHtml()
  assert.doesNotMatch(html, /DEVICE_MAX/)
  // The cap is DEVICE_MAX scaled by the number of configured sources, so the
  // substituted constant shows up multiplied into a variable rather than
  // inlined directly at the comparison and slice call sites.
  const capExpr = html.match(new RegExp(`(\\w+)=${declared}\\*`))
  assert.ok(capExpr, `no ${declared}*<sources> product found in built output`)
  const cap = capExpr[1]
  assert.match(html, new RegExp(`\\.size\\s*<=\\s*${cap}\\b`))
  assert.match(html, new RegExp(`\\.slice\\(${cap}\\)`))
})
