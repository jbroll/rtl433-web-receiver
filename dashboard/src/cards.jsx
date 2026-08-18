import { memo } from 'preact/compat'
import { useLayoutEffect, useEffect, useRef } from 'preact/hooks'
import { devices } from './devices.js'
import { cardState, cardEntry, visibleValues, bottomFields, setCardHidden } from './store.js'
import { aliasOf, displayName, postAlias } from './alias.js'
import { splitUnit, fmtValue, ageText } from './units.js'
import { editing, renaming, dragging, resizing, gestureInFlight,
         measureGrid, fitValues, valueFont, textWidthEm, cellSignal,
         trackFit, beginDrag, beginResize, setRenaming, currentDrag, currentResize, computeUniformFontSize } from './grid.js'
import { tick } from './tick.js'

export function CardsView() {
  const gridRef = useRef(null)

  // Read cellSignal and cardState to trigger re-render on changes
  cellSignal.value
  cardState.value

  // measureGrid on render (synchronous, before paint)
  useLayoutEffect(() => {
    if (gridRef.current) measureGrid()
  })

  // fitValues runs after measureGrid updates cellSignal and uniformFontSize, after paint
  useEffect(() => {
    cellSignal.value
    if (gridRef.current) fitValues()
  }, [cellSignal.value])

  // Handle window resize
  useEffect(() => {
    const handleResize = () => {
      if (gridRef.current) {
        measureGrid()
        fitValues()
      }
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  // Compute shown keys directly from signals for reactivity
  const order = cardState.value.order
  const hidden = cardState.value.hidden
  const shown = order.filter(k => devices.value.has(k) && !hidden.includes(k))

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
  const w = Math.max(1, Math.min(c.w, g.cols))
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
  const font = valueFont()

  return (
    <div
      class="body"
      style={{
        gridTemplateColumns: `repeat(${w}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${valueRows}, minmax(0, 1fr))`
      }}
    >
      {vis.map(f => (
        <Value key={f} rec={rec} field={f} font={font} cardKey={cardKey} />
      ))}
    </div>
  )
}

function Value({ rec, field, font, cardKey }) {
  const parts = splitUnit(field)
  const num = fmtValue(rec.merged.value[field])
  const fvStyle = { fontSize: font }
  const valRef = useRef(null)

  // Call trackFit after the element is mounted or when its font/size changes
  useLayoutEffect(() => {
    const valEl = valRef.current
    if (!valEl) return
    const card = valEl.closest('.card')
    if (card) {
      const valParent = valEl.parentNode
      const rowHeight = valParent ? valParent.clientHeight : 0
      trackFit(valEl, card, textWidthEm(num, parts.unit), rowHeight)
    }
  }, [num, parts.unit, font])

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
        <span>{parts.name}</span>
        {parts.unit && <span class="u">{parts.unit}</span>}
      </div>
      <div class="fv" ref={valRef} style={fvStyle}>
        {num}
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
        const parts = splitUnit(f)
        return (
          <span key={f}>
            <span class="bn">{parts.name}</span>
            <span class="bv">{fmtValue(rec.merged.value[f])}{parts.unit}</span>
          </span>
        )
      })}
    </div>
  )
}

function Age({ rec }) {
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
