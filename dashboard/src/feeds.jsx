import { feedStatuses } from './feeds/feed.js'

// Reads feedState through feedStatuses(), so the list re-renders as feeds run.
const LABEL = {
  idle: 'waiting',
  ok: 'ok',
  error: 'failed',
  unsupported: 'not available here',
}

function retryIn(nextAt) {
  if (!Number.isFinite(nextAt)) return ''
  const ms = nextAt - Date.now()
  if (ms <= 0) return 'retrying'
  const mins = Math.round(ms / 60000)
  return mins < 1 ? 'retrying shortly' : `retry in ${mins} min`
}

export function FeedsView() {
  const rows = feedStatuses()
  if (rows.length === 0) return null

  return (
    <div class="feeds">
      <h3>Feeds</h3>
      {rows.map(r => (
        <div class="feed" key={r.id} data-feed={r.id} data-status={r.status}>
          <span class="feed-name">{r.topic}</span>
          <span class="feed-status">{LABEL[r.status] || r.status}</span>
          {r.err && <span class="feed-err">{r.err}</span>}
          {r.status === 'error' && <span class="feed-retry">{retryIn(r.nextAt)}</span>}
        </div>
      ))}
    </div>
  )
}
