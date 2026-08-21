const ALIAS_SUFFIX = '/$alias'
const LAYOUT_SUFFIX = '/$layout'

function parse(raw) { try { return JSON.parse(raw) } catch (e) { return null } }

export function openSource(base, handlers) {
  let es = null
  let state = 'connecting'
  let retry = 0
  let closed = false

  const set = (next) => { state = next; handlers.onState(base, next) }

  function connect() {
    if (closed) return
    es = new EventSource(`${base}/events`)
    es.onopen = () => set('live')
    es.onerror = () => {
      set('reconnecting')
      // A non-200 (every slot busy) closes the stream for good, so retry by hand.
      if (es.readyState === EventSource.CLOSED) retry = setTimeout(connect, 5000)
    }
    es.onmessage = (ev) => {
      const msg = parse(ev.data)
      if (!msg || typeof msg.topic !== 'string') return
      if (msg.topic.endsWith(ALIAS_SUFFIX)) handlers.onAlias(base, msg.topic, msg.payload)
      else if (msg.topic.endsWith(LAYOUT_SUFFIX)) handlers.onLayout(base, msg.topic, msg.payload)
      else handlers.onMessage(base, msg.topic, msg.payload)
    }
  }

  set('connecting')
  connect()

  return {
    base,
    state: () => state,
    close() {
      closed = true
      clearTimeout(retry)
      if (es) es.close()
      set('closed')
    },
  }
}
