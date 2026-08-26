import { memo } from 'preact/compat'
import { useLayoutEffect, useEffect, useRef } from 'preact/hooks'
import { devices } from './devices.js'
import { cardState, cardEntry, visibleValues, bottomFields, setCardHidden } from './store.js'
import { aliasOf, displayName, postAlias } from './alias.js'
import { ageText, displayValue } from './units.js'
import { settings } from './settings.js'
import { editing, renaming, dragging, resizing, gestureInFlight,
         measureGrid, fitValues, textWidthEm, cellSignal, viewCols, viewColsSignal,
         trackFit, beginDrag, beginResize, setRenaming, currentDrag, currentResize } from './grid.js'
import { tick } from './tick.js'
import { isRich, rendererFor, briefOf, labelOf } from './render-values.js'

export function CardsView() {
  const gridRef = useRef(null)

  // Read cellSignal and cardState to trigger re-render on changes
  cellSignal.value
  viewColsSignal.value
  cardState.value
  settings.value

  // measureGrid on render (synchronous, before paint)
  useLayoutEffect(() => {
    if (gridRef.current) measureGrid()
  })

  // fitValues runs after every render, after paint, so values tracked after
  // the last cell change (device arrival, text width change) still get fitted
  useEffect(() => {
    cellSignal.value
    if (gridRef.current) fitValues()
  })

  // The grid measures zero on a hidden tab, so re-fit when it gets its size
  // back as well as on a window resize.
  useEffect(() => {
    const refit = () => {
      if (!gridRef.current) return
      measureGrid()
      fitValues()
    }
    window.addEventListener('resize', refit)
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(refit)
    if (ro && gridRef.current) ro.observe(gridRef.current)
    return () => {
      window.removeEventListener('resize', refit)
      if (ro) ro.disconnect()
    }
  }, [])

  // Compute shown keys directly from signals for reactivity
  const order = cardState.value.order
  const hidden = cardState.value.hidden
  // Read outside the callback: an empty order would never run it, and the
  // component would not subscribe to devices at all.
  const devs = devices.value
  const shown = order.filter(k => devs.has(k) && !hidden.includes(k))

  return (
    <div id="cards" ref={gridRef}>
      {shown.map(key => {
        const rec = devices.value.get(key)
        if (!rec) return null
        return <Card key={key} cardKey={key} rec={rec} />
      })}
    </div>
  )
}

// areEqual returns true when props are "equal" (skip re-render)
function areEqual(props, otherProps) {
  if (gestureInFlight()) {
    const gesture = dragging.value || resizing.value
    const gestureKey = gesture ? gesture.key : renaming.value
    if (gestureKey === props.cardKey) return true
  }
  return false
}

const Card = memo(function Card({ rec }) {
  const key = rec.key
  const c = cardEntry(key)
  const merged = rec.merged.value
  const vis = visibleValues(key, merged)
  const g = cardState.value.grid
  const w = Math.max(1, Math.min(c.w, viewCols()))
  const h = Math.max(1, Math.min(c.h, g.rows))

  const flashClass = rec.flashUntil.value > tick.value ? 'flash' : ''
  const editingClass = editing.value ? 'editing' : ''

  return (
    <div
      class={`card ${flashClass} ${editingClass}`}
      style={{ gridColumn: `span ${w}`, gridRow: `span ${h}` }}
      data-key={key}
      onPointerDown={(ev) => {
        if (!editing.value || ev.button !== 0 || currentResize()) return
        if (ev.target.closest('button') || ev.target.closest('input')) return
        beginDrag(ev, ev.currentTarget, ev.target.closest('.val'))
      }}
      onDragStart={(ev) => { if (editing.value) ev.preventDefault() }}
    >
      <Label rec={rec} />
      <Body rec={rec} vis={vis} h={h} w={w} cardKey={key} />
      <BottomStrip rec={rec} />
      <Age rec={rec} />
      <CloseButton rec={rec} />
      <ResizeHandle rec={rec} c={c} w={w} h={h} />
    </div>
  )
}, areEqual)

function Label({ rec }) {
  const key = rec.key
  const alias = aliasOf(key)
  const isRenaming = renaming.value && key === renaming.value

  return (
    <div
      class="lbl"
      onDblClick={(ev) => {
        if (!editing.value || isRenaming) return
        ev.stopPropagation()
        setRenaming(key)
      }}
      onPointerDown={() => {
        if (!editing.value || isRenaming) return
        // Long press to rename is handled by RenameInput
      }}
    >
      <RenameInput rec={rec} />
    </div>
  )
}

function RenameInput({ rec }) {
  const key = rec.key
  const alias = aliasOf(key)
  const isRenaming = renaming.value === key
  const inputRef = useRef(null)

  if (isRenaming) {
    // We need to render the input synchronously
    return (
      <input
        ref={inputRef}
        type="text"
        defaultValue={alias}
        onKeyDown={(ev) => {
          if (ev.key === 'Enter') {
            postAlias(key, ev.target.value)
            setRenaming(false)
          } else if (ev.key === 'Escape') {
            setRenaming(false)
          }
        }}
        onBlur={(ev) => {
          postAlias(key, ev.target.value)
          setRenaming(false)
        }}
        onClick={(ev) => ev.stopPropagation()}
      />
    )
  }

  return (
    <>
      <span class="nm">{displayName(key)}</span>
      <span class="rs">{rec.rssi.value === undefined ? '' : String(rec.rssi.value)}</span>
    </>
  )
}

function Body({ rec, vis, h, w, cardKey }) {
  const valueRows = Math.max(h, Math.ceil(vis.length / w))

  return (
    <div
      class="body"
      style={{
        gridTemplateColumns: `repeat(${w}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${valueRows}, minmax(0, 1fr))`
      }}
    >
      {vis.map(f => (
        isRich(rec.merged.value[f])
          ? <RichValue key={f} rec={rec} field={f} cardKey={cardKey} />
          : <Value key={f} rec={rec} field={f} cardKey={cardKey} />
      ))}
    </div>
  )
}

function RichValue({ rec, field }) {
  const raw = rec.merged.value[field]
  const R = rendererFor(raw)

  return (
    <div
      class="val cval"
      data-f={field}
      onPointerDown={(ev) => {
        if (!editing.value) return
        ev.stopPropagation()
        beginDrag(ev, ev.target.closest('.card'), ev.currentTarget)
      }}
    >
      {R ? <R v={raw} rec={rec} field={field} /> : null}
    </div>
  )
}

function Value({ rec, field, cardKey }) {
  const d = displayValue(field, rec.merged.value[field], settings.value)
  const valRef = useRef(null)

  // fitValues is the only writer of .fv font size, so a re-render cannot undo it.
  useLayoutEffect(() => {
    if (valRef.current) trackFit(valRef.current, textWidthEm(d.num))
  }, [d.num, d.unit])

  return (
    <div
      class="val"
      data-f={field}
      onPointerDown={(ev) => {
        if (!editing.value) return
        ev.stopPropagation()
        beginDrag(ev, ev.target.closest('.card'), ev.currentTarget)
      }}
    >
      <div class="fn">
        <span>{d.name}</span>
        {d.unit && <span class="u">{d.unit}</span>}
      </div>
      <div class="fv" ref={valRef}>
        {d.num}
      </div>
    </div>
  )
}

function BottomStrip({ rec }) {
  const key = rec.key
  const bottom = bottomFields(key, rec.merged.value)

  return (
    <div class="btm">
      {bottom.map(f => {
        const raw = rec.merged.value[f]
        if (isRich(raw)) {
          const brief = briefOf(raw)
          if (!brief) return null
          return (
            <span key={f}>
              <span class="bn">{labelOf(raw, f)}</span>
              <span class="bv">{brief}</span>
            </span>
          )
        }
        const d = displayValue(f, raw, settings.value)
        return (
          <span key={f}>
            <span class="bn">{d.name}</span>
            <span class="bv">{d.num}{d.unit}</span>
          </span>
        )
      })}
    </div>
  )
}

function Age({ rec }) {
  // seenAt 0 marks a record with no arrival time: a feed computed from the
  // system clock is never stale, so an age would be noise.
  if (!rec.seenAt.value) return null
  // Read to subscribe: only seenAt changing re-rendered this before, so the
  // text was frozen at whatever it read on arrival until the next message.
  tick.value

  return (
    <div class="age">
      {ageText(Date.now() - rec.seenAt.value)}
    </div>
  )
}

function CloseButton({ rec }) {
  const key = rec.key
  return (
    <button
      class="cx"
      onClick={(ev) => {
        ev.stopPropagation()
        setCardHidden(key, true)
      }}
    >
      ✕
    </button>
  )
}

function ResizeHandle({ rec, c, w, h }) {
  const key = rec.key
  return (
    <button
      class="rz"
      onPointerDown={(ev) => {
        if (!editing.value || ev.button !== 0 || currentDrag()) return
        ev.stopPropagation()
        beginResize(ev, ev.target.closest('.card'), c.w, c.h)
      }}
    />
  )
}
