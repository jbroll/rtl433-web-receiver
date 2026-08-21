#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildHtml } from '../../dashboard/build.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const out = join(HERE, '..', 'public', 'index.html')

const html = await buildHtml()
await mkdir(dirname(out), { recursive: true })
await writeFile(out, html)
process.stderr.write(`${out} ${html.length} bytes\n`)
