import { registerValue } from './render-values.js'
import { tick } from './tick.js'

// Imported for its registrations, so a renderer is reachable by tag before the
// first card renders. Components live here rather than beside the registry so
// the registry stays plain JS that `node --test` can import.

registerValue('text', ({ v }) => (
  <>
    {v.label && <div class="cfn">{v.label}</div>}
    <div class="ctext">{v.text}</div>
  </>
))

// Seconds come off the shared tick rather than a timer of this component's
// own, so the whole page still runs on one interval.
registerValue('clock', ({ v }) => {
  tick.value
  const now = new Date()
  return (
    <>
      <div class="cfn">{v.zone}</div>
      <div class="big">{new Intl.DateTimeFormat(undefined, {
        timeZone: v.zone, hour: '2-digit', minute: '2-digit', hour12: false }).format(now)}</div>
      <div class="csub">{new Intl.DateTimeFormat(undefined, {
        timeZone: v.zone, second: '2-digit' }).format(now)}s</div>
    </>
  )
})
