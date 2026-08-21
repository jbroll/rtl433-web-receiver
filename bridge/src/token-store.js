import { readFileSync, renameSync, writeFileSync } from 'node:fs'

// The bridge's own internal connection to the embedded broker and any
// external MQTT client dial in once and keep their session past a
// rotation, so this is a single mutable value, not a queue of valid
// tokens: only ever one token is current.
export function createTokenStore(initialToken, { path } = {}) {
  let current = initialToken
  if (path) {
    try {
      const fromFile = readFileSync(path, 'utf8').trim()
      if (fromFile) current = fromFile
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
  }

  return {
    get: () => current,
    rotate(newToken) {
      current = newToken
      if (path) {
        // Write-then-rename so a crash mid-write never leaves a truncated
        // token file that then locks the operator out at next boot.
        const tmpPath = `${path}.tmp`
        writeFileSync(tmpPath, newToken)
        renameSync(tmpPath, path)
      }
    },
  }
}
