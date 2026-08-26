import { useState } from 'preact/hooks'
import { tab, settingsTab } from './app.jsx'
import { devices } from './devices.js'
import { cardFields, cardHidden, setCardHidden, valueMode, setValueMode } from './store.js'
import { aliasOf, postAlias, shortKey } from './alias.js'
import { ageText, displayValue } from './units.js'
import { settings } from './settings.js'
import { sortDevices, sortBy, current, sortable } from './devicesort.js'
import { isRich, briefOf } from './render-values.js'

function reading(rec) {
  const s = settings.value
  const merged = rec.merged.value
  return Object.keys(merged)
    .map(k => {
      const raw = merged[k]
      // A rich value has no scalar form; its one-line brief stands in, and a
      // value without one is left out rather than stringified into the cell.
      if (isRich(raw)) { const b = briefOf(raw); return b ? k + ": " + b : '' }
      const d = displayValue(k, raw, s)
      return d.name + ": " + d.num + d.unit
    })
    .filter(Boolean)
    .join("  ")
}

function AliasInput({ r, name }) {
  const [editing, setEditing] = useState(null)
  const commit = (value) => { setEditing(null); postAlias(r.key, value) }
  return (
    <input
      type="text"
      value={editing !== null ? editing : aliasOf(r.key)}
      placeholder={name}
      title="Name shown on this device's card"
      onInput={(e) => setEditing(e.target.value)}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur() }}
    />
  )
}

// Call count a test can read to confirm a packet to one device does not
// re-render another device's row. Rows() re-runs its whole loop on any one
// device's change (it reads every device's r.merged.value to compute field
// lists), but @preact/signals already gives DeviceRow its own subscription
// to the signals it reads, so an unrelated row's function body never runs.
let deviceRowRenders = 0
export function deviceRowRenderCount() { return deviceRowRenders }

function DeviceRow({ r }) {
  deviceRowRenders++
  const obj = r.obj.value
  const name = obj && obj.model ? obj.model : shortKey(r.key)
  const flash = r.flashing.value ? 'flash' : ''
  const id = obj && obj.id !== undefined ? obj.id : (obj && obj.channel !== undefined ? 'ch' + obj.channel : '')
  // seenAt 0 marks a record with no arrival time, the same as on a card.
  const age = r.seenAt.value ? ageText(Date.now() - r.seenAt.value) : ''
  const rssi = r.rssi.value === undefined ? '' : r.rssi.value
  const count = r.count.value === undefined ? '' : r.count.value

  return (
    <tr data-key={r.key} class={flash}>
      <td>{name}</td>
      <td>{id}</td>
      <td>{reading(r)}</td>
      <td class="num">{rssi}</td>
      <td class="num">{count}</td>
      <td class="num">{age}</td>
      <td>
        <AliasInput r={r} name={name} />
      </td>
      <td>
        <input
          type="checkbox"
          checked={!cardHidden(r.key)}
          title="Show a card for this device"
          onChange={(e) => setCardHidden(r.key, !e.target.checked)}
        />
      </td>
    </tr>
  )
}

function ValueRow({ rowKey, field, raw }) {
  const mode = valueMode(rowKey, field)
  let value
  if (isRich(raw)) {
    // briefOf() already returns '' for a missing/non-string brief (e.g.
    // weather's `now` field with no observation and no forecast text), the
    // same fallback reading() above applies explicitly.
    value = briefOf(raw)
  } else {
    const d = displayValue(field, raw, settings.value)
    value = d.num + d.unit
  }

  return (
    <tr class="vrow" data-key={rowKey} data-f={field}>
      <td colSpan={3}>{field}</td>
      <td colSpan={3}>{value}</td>
      <td colSpan={2}>
        <select value={mode} onChange={(e) => setValueMode(rowKey, field, e.target.value)}>
          <option value="shown">shown</option>
          <option value="bottom">bottom</option>
          <option value="hidden">hidden</option>
        </select>
      </td>
    </tr>
  )
}

function SortHeader({ col, children }) {
  const { by, dir } = current()
  const isSorted = sortable(col)
  const ariaSort = isSorted && col === by ? (dir === 1 ? 'ascending' : 'descending') : 'none'

  const handleClick = () => {
    if (sortable(col)) sortBy(col)
  }

  if (!sortable(col)) {
    return <th>{children}</th>
  }

  return (
    <th data-sort={col} aria-sort={ariaSort}>
      <button type="button" onClick={handleClick}>{children}</button>
    </th>
  )
}

function Rows() {
  const rows = []
  for (const r of sortDevices(devices.value.values())) {
    rows.push(<DeviceRow key={r.key} r={r} />)
    for (const f of cardFields(r.key, r.merged.value)) {
      rows.push(<ValueRow key={`${r.key} ${f}`} rowKey={r.key} field={f} raw={r.merged.value[f]} />)
    }
  }
  return rows
}

export function DevicesView() {
  // Keys let Preact reuse each row's DOM, so a select keeps focus and its
  // open list across the re-render its own change triggers. Rendering an
  // empty tbody to "preserve" the rows instead removed every one of them.
  // Skipped entirely while another tab is up, which is most of the time.
  const rows = tab.value === 'devices' && settingsTab.value === 'devices' ? <Rows /> : null

  return (
    <>
    <span id="git-hash">{GIT_HASH}</span>
    <table>
      <thead>
        <tr>
          <SortHeader col="name">Model</SortHeader>
          <SortHeader col="id">ID</SortHeader>
          <th>Reading</th>
          <SortHeader col="rssi">RSSI</SortHeader>
          <SortHeader col="count">Msgs</SortHeader>
          <SortHeader col="age">Age</SortHeader>
          <SortHeader col="alias">Alias</SortHeader>
          <th>Card</th>
        </tr>
      </thead>
      <tbody id="devices">{rows}</tbody>
    </table>
    </>
  )
}
