import { signal } from '@preact/signals'
import { editing } from './grid.js'
import { sourceState } from './sources.js'
import { SourcesView } from './sources.jsx'

export const tab = signal('cards')

const TABS = ['devices', 'log', 'cards', 'sources']

function Status() {
  const states = [...sourceState.value.values()]
  const live = states.filter((s) => s === 'live').length
  const text = live === states.length ? 'live'
             : live === 0 ? 'reconnecting'
             : `${live}/${states.length} live`
  return <span id="status">{text}</span>
}

export function App() {
  return (
    <>
      <header>
        <h1>rtl_433</h1>
        <nav>
          {TABS.map((n) => (
            <button
              key={n}
              id={`tab-${n}`}
              aria-selected={tab.value === n}
            >
              {n[0].toUpperCase() + n.slice(1)}
            </button>
          ))}
        </nav>
        <Status />
      </header>
      <section id="view-devices" hidden={tab.value !== 'devices'}>
        <table>
          <thead>
            <tr>
              <th data-sort="name">Model</th>
              <th data-sort="id">ID</th>
              <th>Reading</th>
              <th class="num" data-sort="rssi">RSSI</th>
              <th class="num" data-sort="count">Msgs</th>
              <th class="num" data-sort="age">Age</th>
              <th data-sort="alias">Alias</th>
              <th>Card</th>
            </tr>
          </thead>
          <tbody id="devices"></tbody>
        </table>
      </section>
      <section id="view-log" hidden={tab.value !== 'log'}>
        <table id="log"><tbody id="logrows"></tbody></table>
      </section>
      <section id="view-sources" hidden={tab.value !== 'sources'}>
        <SourcesView />
      </section>
      <section id="view-cards" class={editing.value ? 'editing' : ''} hidden={tab.value !== 'cards'}>
        <button id="edit-cards" title="Edit layout">&#9998;</button>
        <button id="forget-cards" title="Forget saved layouts">Forget layouts</button>
        <span id="grid-size" title="Grid columns and rows">
          <input id="grid-cols" type="number" min="1" max="24" aria-label="Grid columns" />
          <span>&times;</span>
          <input id="grid-rows" type="number" min="1" max="24" aria-label="Grid rows" />
        </span>
        <div id="cards"></div>
      </section>
    </>
  )
}
