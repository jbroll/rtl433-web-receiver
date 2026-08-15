import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { build } from 'esbuild'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, 'src')
const HEADER = join(HERE, '..', 'receiver', 'signal_store.h')

// The page's device cap has to be the firmware's, or the two silently disagree
// about how many slots exist.
export async function deviceMax() {
  const src = await readFile(HEADER, 'utf8')
  const m = src.match(/^#define\s+SIGNAL_DEVICE_SLOTS\s+(\d+)/m)
  if (!m) throw new Error(`no SIGNAL_DEVICE_SLOTS in ${HEADER}`)
  return Number(m[1])
}

async function bundle(entry, loader, define) {
  const out = await build({
    entryPoints: [join(SRC, entry)],
    bundle: true,
    write: false,
    minify: true,
    format: 'iife',
    target: 'es2022',
    loader,
    define,
  })
  return out.outputFiles[0].text
}

export async function buildHtml() {
  const define = { DEVICE_MAX: String(await deviceMax()) }
  const [template, css, js] = await Promise.all([
    readFile(join(SRC, 'index.html'), 'utf8'),
    bundle('style.css', {}, {}),
    bundle('main.js', {}, define),
  ])
  return template.replace('/*CSS*/', () => css.trim()).replace('/*JS*/', () => js.trim())
}

async function main() {
  const html = await buildHtml()
  const dist = join(HERE, 'dist')
  await mkdir(dist, { recursive: true })
  await writeFile(join(dist, 'index.html'), html)
  process.stderr.write(`dist/index.html ${html.length} bytes\n`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
