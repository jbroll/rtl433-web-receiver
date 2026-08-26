import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

import { digest } from './auth.js'

// The bridge's own internal connection to the embedded broker and any
// external MQTT client dial in once and keep their session past a
// rotation, so this is a single mutable value, not a queue of valid
// tokens: only ever one token is current.
export function createTokenStore(initialToken, { path: tokenPath } = {}) {
  let current = initialToken
  let counter = 0
  if (tokenPath) {
    try {
      const fromFile = readFileSync(tokenPath, 'utf8').trim()
      if (fromFile) current = fromFile
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
  }
  let currentDigest = current ? digest(current) : undefined

  return {
    get: () => current,
    digest: () => currentDigest,
    rotate(newToken) {
      const trimmed = newToken.trim()
      if (trimmed.length === 0) throw new Error('token must not be empty')
      // Assigned right alongside `current`, after persist() succeeds: a
      // failed write must leave both the old token and old digest live.
      if (tokenPath) persist(tokenPath, trimmed, counter++)
      current = trimmed
      currentDigest = digest(trimmed)
    },
  }
}

// Write-then-rename with fsync on both the file and its directory, so a
// crash mid-write or mid-rename can't leave a truncated or missing token file.
function persist(tokenPath, token, counter) {
  const tmpPath = `${tokenPath}.${process.pid}.${counter}.tmp`
  const fd = openSync(tmpPath, 'w', 0o600)
  try {
    writeFileSync(fd, token)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmpPath, tokenPath)

  const dirFd = openSync(path.dirname(tokenPath), 'r')
  try {
    fsyncSync(dirFd)
  } catch (err) {
    // Some filesystems (and platforms) refuse to fsync a directory fd.
    if (err.code !== 'EPERM' && err.code !== 'EISDIR') throw err
  } finally {
    closeSync(dirFd)
  }
}
