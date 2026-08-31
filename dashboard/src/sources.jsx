import { useState } from 'preact/hooks'
import { Capacitor } from '@capacitor/core'
import { mDNS } from '@devioarts/capacitor-mdns'
import { sources, sourceState, addSource, removeSource, normalizeBase, rejectionReason,
         setNativePlatform } from './sources.js'
import { showToast } from './toast.js'

setNativePlatform(Capacitor.isNativePlatform())

const MDNS_NAME_PREFIX = 'rtl433-'
const REMOTE_HINT = "That address isn't on your local network."

export function SourcesView() {
  return (
    <>
      <ul id="source-list">
        {sources.value.map(base => (
          <li key={base}>
            <span class="dot" data-state={sourceState.value.get(base) || 'connecting'} />
            <span class="url">{base}</span>
            <button class="rm" title={`Remove ${base}`} onClick={() => removeSource(base)}>✕</button>
          </li>
        ))}
      </ul>
      {Capacitor.isNativePlatform() && <ScanButton />}
      <SourceForm />
    </>
  )
}

function ScanButton() {
  const [state, setState] = useState({ status: 'idle', found: [] })

  async function scan() {
    setState({ status: 'scanning', found: [] })
    try {
      const result = await mDNS.discover({ type: '_http._tcp.', timeout: 4000 })
      if (result.error) {
        setState({ status: 'error', found: [], message: result.errorMessage || 'Scan failed.' })
        return
      }
      const found = (result.services || []).filter(s => s.name && s.name.startsWith(MDNS_NAME_PREFIX))
      setState({ status: 'done', found })
    } catch (err) {
      setState({ status: 'error', found: [], message: (err && err.message) || 'Scan failed.' })
    }
  }

  return (
    <div id="mdns-scan">
      <button type="button" onClick={scan} disabled={state.status === 'scanning'}>
        {state.status === 'scanning' ? 'Scanning…' : 'Scan for receivers'}
      </button>
      {state.status === 'error' && (
        <p class="hint" role="alert">{state.message}</p>
      )}
      {state.status === 'done' && state.found.length === 0 && (
        <p class="hint">No receivers found.</p>
      )}
      {state.status === 'done' && state.found.length > 0 && (
        <ul id="mdns-results">
          {state.found.map(svc => <ScanResult key={svc.name} svc={svc} />)}
        </ul>
      )}
    </div>
  )
}

function candidateBase(svc) {
  const host = (svc.hosts || [])[0]
  if (!host) return null
  const hostPart = host.includes(':') ? `[${host}]` : host
  return normalizeBase(`http://${hostPart}:${svc.port}`)
}

function ScanResult({ svc }) {
  const base = candidateBase(svc)
  const already = base && sources.value.indexOf(base) >= 0
  function add() {
    if (!base || addSource(base)) return
    showToast(REMOTE_HINT)
  }
  return (
    <li>
      <span class="url">{svc.name}{base ? ` — ${base}` : ' (no address)'}</span>
      <button type="button" disabled={!base || already} onClick={add}>
        {already ? 'Added' : 'Add'}
      </button>
    </li>
  )
}

function SourceForm() {
  let input
  return (
    <form id="source-form" onSubmit={(ev) => {
      ev.preventDefault()
      const reason = rejectionReason(input.value)
      if (!addSource(input.value)) {
        input.setAttribute('aria-invalid', 'true')
        if (reason === 'remote') showToast(REMOTE_HINT)
        return
      }
      input.removeAttribute('aria-invalid')
      input.value = ''
    }}>
      <input
        id="source-url"
        type="url"
        placeholder="http://bridge.local:8080"
        aria-label="Source base URL"
        ref={(el) => { input = el }}
        onInput={() => input.removeAttribute('aria-invalid')}
      />
      <button id="source-add" type="submit">Add</button>
    </form>
  )
}
