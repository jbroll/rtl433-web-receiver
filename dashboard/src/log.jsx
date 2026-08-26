import { signal } from '@preact/signals'
import { tab, settingsTab } from './app.jsx'

const LOG_MAX = 200
export const log = signal([])

let nextId = 0

export function addLog(at, raw) {
  const next = [{ id: nextId++, time: new Date(at).toLocaleTimeString(), raw }, ...log.value]
  if (next.length > LOG_MAX) next.length = LOG_MAX
  log.value = next
}

export function LogView() {
  // Skipped entirely while another tab is up, which is most of the time; see
  // DevicesView for the same gate.
  const rows = tab.value === 'devices' && settingsTab.value === 'log' ? log.value : []
  return (
    <section id="view-log">
      <table id="log">
        <tbody id="logrows">
          {rows.map(entry => (
            <tr key={entry.id}>
              <td class="nw">{entry.time}</td>
              <td>{entry.raw}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
