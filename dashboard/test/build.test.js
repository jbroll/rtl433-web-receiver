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
})

// The page still loads with no external request, which the reference-site
// assertions above pin. Once the user sets a location it may reach these
// origins at runtime, and this is the list of them.
const REACHABLE = new Set([
  'https://api.weather.gov',
  'https://nominatim.openstreetmap.org',
  'https://tile.openstreetmap.org',
])

// Link targets, not requests. The first is the attribution the OSM tile usage
// policy asks for. The second is pigeon-maps' own credit, which the map turns
// off with attributionPrefix={false} but which stays a literal in the bundle.
const LINKED = new Set(['https://www.openstreetmap.org', 'https://pigeon-maps.js.org'])

// An XML namespace name, the example text in a placeholder attribute, and the
// minified source of candidateBase()'s own template literal (matched as text
// since it isn't valid on its own — the closing backtick rides along with it).
// None of these are ever fetched.
const NOT_A_REQUEST = new Set([
  'http://www.w3.org',
  'http://bridge.local:8080',
  'http://${n}:${e.port}`',
])

test('the bundle names no origin beyond the ones the feeds reach', async () => {
  const html = await buildHtml()
  for (const match of html.matchAll(/https?:\/\/[^"'\s)\\]+/g)) {
    let origin
    try { origin = new URL(match[0]).origin } catch (e) { origin = match[0] }
    if (NOT_A_REQUEST.has(origin)) continue
    assert.ok(REACHABLE.has(origin) || LINKED.has(origin),
      `unexpected origin in the built page: ${origin}`)
  }
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
  // inlined directly at the comparison and slice call sites. The comparison
  // counts the radio records rather than the whole map, since feed cards live
  // in the same map and are exempt from the cap.
  const capExpr = html.match(new RegExp(`(\\w+)=${declared}\\*`))
  assert.ok(capExpr, `no ${declared}*<sources> product found in built output`)
  const cap = capExpr[1]
  assert.match(html, new RegExp(`\\.length\\s*<=\\s*${cap}\\b`))
  assert.match(html, new RegExp(`\\.slice\\(${cap}\\)`))
})
