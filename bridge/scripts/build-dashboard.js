#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises'
import { register } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

// dashboard/build.js imports esbuild, resolved from dashboard/node_modules,
// which a bridge-only install doesn't create. esbuild is pinned in the
// bridge's own devDependencies for that case; fall back to it here.
const loaderSrc = `
  export async function resolve(specifier, context, nextResolve) {
    if (specifier !== 'esbuild') return nextResolve(specifier, context)
    try {
      return await nextResolve(specifier, context)
    } catch {
      return nextResolve(specifier, { ...context, parentURL: ${JSON.stringify(import.meta.url)} })
    }
  }
`
register(`data:text/javascript,${encodeURIComponent(loaderSrc)}`, import.meta.url)

const { buildHtml } = await import('../../dashboard/build.js')

const out = join(HERE, '..', 'public', 'index.html')

const html = await buildHtml()
await mkdir(dirname(out), { recursive: true })
await writeFile(out, html)
process.stderr.write(`${out} ${html.length} bytes\n`)
