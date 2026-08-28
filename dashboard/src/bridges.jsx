import { bridges, addBridge, removeBridge } from './bridges.js'
import { showToast } from './toast.js'

export function BridgesView() {
  if (bridges.value === null) return null
  return (
    <>
      <ul id="bridge-list">
        {bridges.value.map(b => (
          <li key={b.url}>
            <span class="dot" data-state={b.connected ? 'connected' : 'connecting'} />
            <span class="url">{b.url}</span>
            <button class="rm" title={`Remove ${b.url}`} onClick={async () => {
              const ok = await removeBridge(b.url)
              if (!ok) showToast(`Remove failed for ${b.url}.`)
            }}>✕</button>
          </li>
        ))}
      </ul>
      <BridgeForm />
    </>
  )
}

function BridgeForm() {
  let urlInput, tokenInput
  return (
    <form id="bridge-form" onSubmit={async (ev) => {
      ev.preventDefault()
      const ok = await addBridge(urlInput.value, tokenInput.value)
      if (!ok) {
        urlInput.setAttribute('aria-invalid', 'true')
        showToast('Add failed. Check the URL and try again.')
        return
      }
      urlInput.removeAttribute('aria-invalid')
      urlInput.value = ''
      tokenInput.value = ''
    }}>
      <input
        id="bridge-url"
        type="text"
        placeholder="mqtts://weather.rkroll.com:8883"
        aria-label="Bridge broker URL"
        ref={(el) => { urlInput = el }}
        onInput={() => urlInput.removeAttribute('aria-invalid')}
      />
      <input
        id="bridge-token"
        type="text"
        placeholder="token (optional)"
        aria-label="Bridge broker token"
        ref={(el) => { tokenInput = el }}
      />
      <button id="bridge-add" type="submit">Add</button>
    </form>
  )
}
