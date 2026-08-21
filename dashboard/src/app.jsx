import { signal } from '@preact/signals'
import { editing, setEditing } from './grid.js'
import { sourceState } from './sources.js'
import { SourcesView } from './sources.jsx'
import { LogView } from './log.jsx'
import { DevicesView } from './devices-table.jsx'
import { SettingsView } from './settings.jsx'
import { CardsView } from './cards.jsx'
import { setGrid, forgetLayouts, grid } from './store.js'
import { sources } from './sources.js'
import { layouts, postLayout, applyTemplate, disableAutoApply } from './layout_template.js'

export const tab = signal('cards')

const TABS = ['cards', 'devices', 'sources', 'log']

function Status() {
  const states = [...sourceState.value.values()]
  const live = states.filter((s) => s === 'live').length
  const text = live === states.length ? 'live'
             : live === 0 ? 'reconnecting'
             : `${live}/${states.length} live`
  return <span id="status">{text} <span id="git-hash" style={{fontSize:'.7rem',opacity:'.5',marginLeft:'.5rem'}}>{GIT_HASH}</span></span>
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
              onClick={() => { tab.value = n }}
            >
              {n[0].toUpperCase() + n.slice(1)}
            </button>
          ))}
        </nav>
        <Status />
      </header>
      <section id="view-cards" class={editing.value ? 'editing' : ''} hidden={tab.value !== 'cards'}>
        <button
          id="edit-cards"
          title="Edit layout"
          onClick={() => { setEditing(!editing.value) }}
        >
          &#9998;
        </button>
        <button
          id="forget-cards"
          title="Forget saved layouts"
          onClick={() => {
            if (confirm('Forget every saved card layout in this browser?')) {
              forgetLayouts()
              disableAutoApply()
            }
          }}
        >
          Forget layouts
        </button>
        {sources.value.includes(location.origin) && (
          <button
            id="save-layout"
            title="Save this arrangement as the site default"
            onClick={() => { postLayout() }}
          >
            Save as default layout
          </button>
        )}
        {layouts.value.has(location.origin) && (
          <button
            id="load-layout"
            title="Load the site default layout"
            onClick={() => {
              if (confirm('Replace the current card arrangement with the site default layout?')) {
                applyTemplate(layouts.value.get(location.origin))
              }
            }}
          >
            Load default layout
          </button>
        )}
        <span id="grid-size" title="Grid columns and rows">
          <input
            id="grid-cols"
            type="number"
            min="1"
            max="24"
            aria-label="Grid columns"
            value={grid().cols}
            onChange={(ev) => { setGrid('cols', parseInt(ev.target.value, 10)) }}
            onBlur={(ev) => { const v = parseInt(ev.target.value, 10); if (!Number.isInteger(v) || v < 1 || v > 24) ev.target.value = String(grid().cols); }}
          />
          <span>&times;</span>
          <input
            id="grid-rows"
            type="number"
            min="1"
            max="24"
            aria-label="Grid rows"
            value={grid().rows}
            onChange={(ev) => { setGrid('rows', parseInt(ev.target.value, 10)) }}
            onBlur={(ev) => { const v = parseInt(ev.target.value, 10); if (!Number.isInteger(v) || v < 1 || v > 24) ev.target.value = String(grid().rows); }}
          />
        </span>
        <CardsView />
      </section>
      <section id="view-devices" hidden={tab.value !== 'devices'}>
        <SettingsView />
        <DevicesView />
      </section>
      <section id="view-sources" hidden={tab.value !== 'sources'}>
        <SourcesView />
      </section>
      <LogView />
    </>
  )
}