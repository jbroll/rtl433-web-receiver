import { memo } from 'preact/compat'
import { useLayoutEffect, useEffect, useRef } from 'preact/hooks'
import { devices } from './devices.js'
import { cardState, cardEntry, visibleValues, bottomFields, setCardHidden } from './store.js'
import { aliasOf, displayName, postAlias } from './alias.js'
import { ageText, displayValue, isBadReading } from './units.js'
import { settings } from './settings.js'
import { editing, renaming, dragging, resizing, gestureInFlight,
         measureGrid, fitValues, cellSignal, viewCols, viewColsSignal,
         trackFit, textWidthEm, beginDrag, beginResize, setRenaming, currentDrag, currentResize,
         dragOrResizeInFlight } from './grid.js'
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
  }, [cellSignal.value, viewColsSignal.value, cardState.value, settings.value, devices.value])

  // devices.value is here so an eviction or clear (fewer tracked boxes, same
  // cell/card/settings state) still refits the survivors, not just arrivals.
  useEffect(() => {
    if (gridRef.current) fitValues()
  }, [cellSignal.value, viewColsSignal.value, cardState.value, settings.value, devices.value])

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

// The card key a drag, resize, or rename currently has hold of, or null.
function gestureTargetKey() {
  if (!gestureInFlight()) return null
  const gesture = dragging.value || resizing.value
  return gesture ? gesture.key : renaming.value
}

// areEqual returns true when props are "equal" (skip re-render)
function areEqual(props) {
  return gestureTargetKey() === props.cardKey
}

// Holds merged's last-read value across a render that must not observe a
// newer one -- reading sig.value only when unfrozen keeps this component
// unsubscribed from it for the render(s) where the freeze applies, so a
// signals-forced update can't leak the new value past memo/areEqual.
function useFrozenValue(sig, frozen) {
  const ref = useRef(sig.peek())
  if (!frozen) ref.current = sig.value
  return ref.current
}

const Card = memo(function Card({ rec }) {
  const key = rec.key
  const merged = useFrozenValue(rec.merged, gestureTargetKey() === key)
  const c = cardEntry(key)
  if (!c) return null
  const vis = visibleValues(key, merged)
  const g = cardState.value.grid
  const w = Math.max(1, Math.min(c.w, viewCols()))
  const h = Math.max(1, Math.min(c.h, g.rows))

  const flashClass = rec.flashing.value ? 'flash' : ''
  const editingClass = editing.value ? 'editing' : ''
  // radio_ok arrives unconditionally on the Receiver's own telemetry; every
  // other device's merged object simply lacks the field.
  const errClass = merged.radio_ok === 0 ? 'err' : ''

  return (
    <div
      class={`card ${flashClass} ${editingClass} ${errClass}`}
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
      <Body rec={rec} merged={merged} vis={vis} h={h} w={w} />
      <BottomStrip rec={rec} merged={merged} />
      <Age rec={rec} />
      <CloseButton rec={rec} />
      <ResizeHandle c={c} />
    </div>
  )
}, areEqual)

function Label({ rec }) {
  const key = rec.key
  const isRenaming = renaming.value && key === renaming.value

  return (
    <div
      class="lbl"
      onDblClick={(ev) => {
        if (!editing.value || isRenaming) return
        ev.stopPropagation()
        setRenaming(key)
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
  const committed = useRef(false)

  if (isRenaming) {
    committed.current = false
    // We need to render the input synchronously
    return (
      <input
        ref={inputRef}
        type="text"
        maxlength="32"
        defaultValue={alias}
        onKeyDown={(ev) => {
          if (ev.key === 'Enter') {
            if (dragOrResizeInFlight()) return
            committed.current = true
            postAlias(key, ev.target.value)
            setRenaming(false)
          } else if (ev.key === 'Escape') {
            committed.current = true
            setRenaming(false)
          }
        }}
        onBlur={(ev) => {
          // The unmount from Enter's or Escape's setRenaming(false) can itself
          // fire blur; committed guards against that post-closing the input.
          if (committed.current) return
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

function Body({ rec, merged, vis, h, w }) {
  const valueCols = Math.max(1, Math.min(w, vis.length))
  const valueRows = Math.max(h, Math.ceil(vis.length / valueCols))

  return (
    <div
      class="body"
      style={{
        gridTemplateColumns: `repeat(${valueCols}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${valueRows}, minmax(0, 1fr))`
      }}
    >
      {vis.map(f => (
        isRich(merged[f])
          ? <RichValue key={f} rec={rec} raw={merged[f]} field={f} />
          : <Value key={f} raw={merged[f]} field={f} />
      ))}
    </div>
  )
}

function RichValue({ rec, raw, field }) {
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

function Value({ raw, field }) {
  const d = displayValue(field, raw, settings.value)
  const bad = isBadReading(field, raw)
  const valRef = useRef(null)

  // fitValues is the only writer of .fv font size, so a re-render cannot undo it.
  // upsert() mutates an existing device's signals in place, leaving
  // devices.value's identity untouched -- CardsView's fitValues() effect
  // never reruns for a reading that only got wider. .fv is a shrink-to-fit
  // flex item (its own scrollWidth/clientWidth is always 1), so overflow is
  // checked against the .val parent fitValues() sized: the current font size
  // times this value's own em width. A full fitValues() pass only runs when
  // that check trips -- the common case costs one canvas.measureText() call
  // and a clientWidth read, not a page-wide refit.
  useLayoutEffect(() => {
    const node = valRef.current
    if (!node) return
    trackFit(node, d.num)
    const parent = node.parentNode
    const fontPx = parseFloat(node.style.fontSize) || parseFloat(getComputedStyle(node).fontSize)
    if (parent && fontPx && textWidthEm(d.num) * fontPx > parent.clientWidth) fitValues()
  }, [d.num, d.unit])

  return (
    <div
      class={`val${bad ? ' err' : ''}`}
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

function BottomStrip({ rec, merged }) {
  const key = rec.key
  const bottom = bottomFields(key, merged)

  return (
    <div class="btm">
      {bottom.map(f => {
        const raw = merged[f]
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

function ResizeHandle({ c }) {
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
