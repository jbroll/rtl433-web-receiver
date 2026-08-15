import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'

import { writeProgmem, buildHtml } from '../build.js'

test('the header holds the gzipped page and its length', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'progmem-'))
  const path = join(dir, 'dashboard_html.h')
  const sizes = await writeProgmem(path)
  const header = await readFile(path, 'utf8')

  assert.match(header, /#pragma once/)
  assert.match(header, /static const unsigned char DASHBOARD_HTML_GZ\[\] PROGMEM = \{/)
  assert.match(header, new RegExp(`DASHBOARD_HTML_GZ_LEN = ${sizes.gz}`))

  const bytes = Buffer.from(
    header.match(/\{([^}]*)\}/)[1].split(',').map((s) => s.trim()).filter(Boolean)
      .map((s) => Number(s)))
  assert.equal(bytes.length, sizes.gz)
  assert.equal(gunzipSync(bytes).toString('utf8'), await buildHtml())
  assert.ok(sizes.gz < sizes.raw / 2, `gz ${sizes.gz} not under half of raw ${sizes.raw}`)

  await rm(dir, { recursive: true })
})
