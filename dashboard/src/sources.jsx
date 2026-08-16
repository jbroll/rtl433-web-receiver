import { sources, sourceState, addSource, removeSource } from './sources.js'

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
      <SourceForm />
    </>
  )
}

function SourceForm() {
  let input
  return (
    <form id="source-form" onSubmit={(ev) => {
      ev.preventDefault()
      if (!addSource(input.value)) {
        input.setAttribute('aria-invalid', 'true')
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
