import net from 'node:net'
import tls from 'node:tls'
import fs from 'node:fs'
import path from 'node:path'

import Aedes from 'aedes'

import { tokenMatches } from './auth.js'
import { createTokenStore } from './token-store.js'

// Only one of these ever runs: a public broker without an authenticate hook
// is not a state this can start into silently, and a loopback debug port
// alongside the public one is a future decision, not a default.
export async function startEmbeddedBroker({ mqttPort = 1883, mqttsPort = 8883, tlsCert, tlsKey, authToken, tokenStore }) {
  if (Boolean(tlsCert) !== Boolean(tlsKey)) {
    throw new Error('TLS_CERT and TLS_KEY must both be set, or neither')
  }
  const tlsEnabled = Boolean(tlsCert && tlsKey)
  const tokens = tokenStore ?? createTokenStore(authToken)
  if (tlsEnabled && !tokens.get()) {
    throw new Error('AUTH_TOKEN must be set when TLS is configured for the embedded broker')
  }

  const aedes = new Aedes()
  if (tlsEnabled) {
    // CONNECT is the only gate: once authenticated, a client has full
    // read+write over '#', the same as the bridge's own internal
    // connection. Public read access is intentionally the HTTP side's job.
    // tokens.digest() is read per-CONNECT, not captured once, so a rotation
    // gates new connections immediately without restarting the broker.
    aedes.authenticate = (client, username, password, callback) => {
      callback(null, tokenMatches(password, tokens.digest()))
    }
  }

  const server = tlsEnabled
    ? tls.createServer({ cert: fs.readFileSync(tlsCert), key: fs.readFileSync(tlsKey) }, aedes.handle)
    : net.createServer(aedes.handle)

  const certWatch = tlsEnabled ? watchCertFiles({ tlsCert, tlsKey, server }) : null

  const port = tlsEnabled ? mqttsPort : mqttPort
  const host = tlsEnabled ? '0.0.0.0' : '127.0.0.1'

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  const { port: boundPort } = server.address()

  return {
    // The bridge's own internal connectBroker always dials loopback: in
    // no-TLS mode that is the only listener there is, and in TLS mode
    // 0.0.0.0 already includes 127.0.0.1, so the public listener answers
    // here too.
    url: tlsEnabled ? `mqtts://127.0.0.1:${boundPort}` : `mqtt://127.0.0.1:${boundPort}`,
    tlsOptions: tlsEnabled ? { rejectUnauthorized: false } : undefined,
    close: () => new Promise((resolve) => {
      certWatch?.close()
      aedes.close(() => server.close(resolve))
    }),
  }
}

// Watching directories, not the files, survives certbot repointing the
// live symlink at a new archive file instead of editing it in place.
function watchCertFiles({ tlsCert, tlsKey, server }) {
  let watchers = []
  let debounceTimer

  const reload = () => {
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      try {
        server.setSecureContext({ cert: fs.readFileSync(tlsCert), key: fs.readFileSync(tlsKey) })
      } catch (err) {
        // A debounce firing mid-write can still catch a truncated file;
        // keeping the running context beats dropping TLS entirely.
        console.error('embedded broker: failed to reload TLS cert/key, keeping current context:', err.message)
      }
      rewatch()
    }, 1000)
    debounceTimer.unref()
  }

  const rewatch = () => {
    for (const watcher of watchers) watcher.close()
    const dirs = new Set()
    for (const filePath of [tlsCert, tlsKey]) {
      dirs.add(path.dirname(filePath))
      try {
        dirs.add(path.dirname(fs.realpathSync(filePath)))
      } catch {
        // Target may briefly not exist mid-rotation; the literal path's
        // directory watch still catches the eventual change.
      }
    }
    watchers = [...dirs].map((dir) => {
      const watcher = fs.watch(dir, reload)
      watcher.unref()
      return watcher
    })
  }

  rewatch()

  return {
    close: () => {
      clearTimeout(debounceTimer)
      for (const watcher of watchers) watcher.close()
    },
  }
}
