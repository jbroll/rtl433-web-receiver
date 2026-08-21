import { signal } from '@preact/signals'

const LOG_MAX = 200
export const log = signal([])

export function addLog(at, raw) {
  const next = [{ at, raw }, ...log.value]
  if (next.length > LOG_MAX) next.length = LOG_MAX
  log.value = next
}

export function LogView() {
  return (
    <section id="view-log">
      <table id="log">
        <tbody id="logrows">
          {log.value.map(entry => (
            <tr key={entry.at + entry.raw}>
              <td class="nw">{new Date(entry.at).toLocaleTimeString()}</td>
              <td>{entry.raw}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
