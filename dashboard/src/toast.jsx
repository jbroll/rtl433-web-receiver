import { toast } from './toast.js'

export function Toast() {
  const t = toast.value
  if (!t) return null
  return <div id="toast" role="status">{t.msg}</div>
}
