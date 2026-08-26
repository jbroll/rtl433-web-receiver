const ALIAS_SUFFIX = '/$alias'
const LAYOUT_SUFFIX = '/$layout'
const LOCATION_SUFFIX = '/$location'
const TZ_SUFFIX = '/$tz'
const UNITS_SUFFIX = '/$units'

function parse(raw) { try { return JSON.parse(raw) } catch (e) { return null } }

export function openSource(base, handlers) {
  let es = null
  let state = 'connecting'
  let retry = 0
  let closed = false
  let attempt = 0

  const set = (next) => { state = next; handlers.onState(base, next) }

  function connect() {
    if (closed) return
    const sock = new EventSource(`${base}/events`)
    es = sock
    sock.onopen = () => { attempt = 0; set('live') }
    sock.onerror = () => {
      // A stale error from a socket connect() already superseded must not
      // touch the current retry timer or attempt count.
      if (es !== sock) return
      set('reconnecting')
      // A non-200 (every slot busy) closes the stream for good, so retry by hand.
      if (sock.readyState === EventSource.CLOSED) {
        const delay = Math.min(30000, 1000 * 2 ** attempt) * (0.8 + 0.4 * Math.random())
        attempt++
        retry = setTimeout(connect, delay)
      }
    }
    es.onmessage = (ev) => {
      const msg = parse(ev.data)
      if (!msg || typeof msg.topic !== 'string') return
      if (msg.topic.endsWith(ALIAS_SUFFIX)) handlers.onAlias(base, msg.topic, msg.payload)
      else if (msg.topic.endsWith(LAYOUT_SUFFIX)) handlers.onLayout(base, msg.topic, msg.payload)
      else if (msg.topic.endsWith(LOCATION_SUFFIX)) handlers.onLocation(base, msg.topic, msg.payload)
      else if (msg.topic.endsWith(TZ_SUFFIX)) handlers.onTz(base, msg.topic, msg.payload)
      else if (msg.topic.endsWith(UNITS_SUFFIX)) handlers.onUnits(base, msg.topic, msg.payload)
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
