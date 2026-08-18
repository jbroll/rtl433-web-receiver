import { useRef, useEffect } from 'preact/hooks'
import { devices } from './devices.js'
import { cardFields, cardHidden, setCardHidden, valueMode, setValueMode } from './store.js'
import { aliasOf, postAlias, shortKey } from './alias.js'
import { ageText, displayValue } from './units.js'
import { settings } from './settings.js'
import { sortDevices, sortBy, current, sortable } from './devicesort.js'
import { tick } from './tick.js'
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

function DeviceRow({ r }) {
  const obj = r.obj.value
  const name = obj && obj.model ? obj.model : shortKey(r.key)
  const flash = r.flashUntil.value > tick.value ? 'flash' : ''
  const id = obj && obj.id !== undefined ? obj.id : (obj && obj.channel !== undefined ? 'ch' + obj.channel : '')
  const age = ageText(Date.now() - r.seenAt.value)
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
        <input
          type="text"
          value={aliasOf(r.key)}
          placeholder={name}
          title="Name shown on this device's card"
          onChange={(e) => postAlias(r.key, e.target.value)}
        />
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

function ValueRow({ rowKey, field, value }) {
  const mode = valueMode(rowKey, field)

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

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      if (sortable(col)) sortBy(col)
    }
  }

  if (!sortable(col)) {
    return <th>{children}</th>
  }

  return (
    <th
      data-sort={col}
      aria-sort={ariaSort}
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      {children}
    </th>
  )
}

export function DevicesView() {
  const skipRenderRef = useRef(false)

  // Track when a select or text input inside tbody has focus
  // and skip tbody replacement to preserve user interaction
  useEffect(() => {
    const handleFocusIn = (e) => {
      const tbody = document.getElementById('devices')
      if (tbody && tbody.contains(e.target)) {
        if (e.target.tagName === 'SELECT' || e.target.type === 'text') {
          skipRenderRef.current = true
        }
      }
    }

    const handleFocusOut = (e) => {
      const tbody = document.getElementById('devices')
      if (tbody && !tbody.contains(e.relatedTarget)) {
        skipRenderRef.current = false
      }
    }

    document.addEventListener('focusin', handleFocusIn)
    document.addEventListener('focusout', handleFocusOut)

    return () => {
      document.removeEventListener('focusin', handleFocusIn)
      document.removeEventListener('focusout', handleFocusOut)
    }
  }, [])

  // If the devices tab is hidden, don't update the tbody (preserves legacy behavior)
  const viewHidden = document.getElementById('view-devices')?.hidden
  if (viewHidden) {
    return (
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
        <tbody id="devices">{/* preserve existing content when hidden */}</tbody>
      </table>
    )
  }

  // Compute sorted devices
  const sortedDevices = sortDevices(devices.value.values())

  // Build rows
  const rows = []
  for (const r of sortedDevices) {
    rows.push(<DeviceRow r={r} />)
    for (const f of cardFields(r.key, r.merged.value)) {
      rows.push(<ValueRow rowKey={r.key} field={f} value={r.merged.value[f]} />)
    }
  }

  const tbody = skipRenderRef.current
    ? <tbody id="devices">{/* preserve existing content */}</tbody>
    : <tbody id="devices">{rows}</tbody>

  return (
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
      {tbody}
    </table>
  )
}
