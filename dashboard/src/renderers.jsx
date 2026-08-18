import { registerValue } from './render-values.js'

// Imported for its registrations, so a renderer is reachable by tag before the
// first card renders. Components live here rather than beside the registry so
// the registry stays plain JS that `node --test` can import.

registerValue('text', ({ v }) => (
  <>
    {v.label && <div class="cfn">{v.label}</div>}
    <div class="ctext">{v.text}</div>
  </>
))
