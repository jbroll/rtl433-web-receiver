globalThis.DEVICE_MAX = 24

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { signal } from '@preact/signals'

// Replicate the areEqual logic from cards.jsx
// Returns true when props are "equal" (skip re-render)

const dragging = signal(null)
const resizing = signal(null)
const renaming = signal(null)

export function gestureInFlight() {
  return !!(dragging.value || resizing.value || renaming.value)
}

export function currentDrag() { return dragging.value }
export function currentResize() { return resizing.value }

function areEqual(props, otherProps) {
  if (gestureInFlight()) {
    const gesture = dragging.value || resizing.value
    if (gesture && gesture.key === props.key) return true
  }
  if (props.key !== otherProps.key) return false
  if (props.merged !== otherProps.merged) return false
  if (props.alias !== otherProps.alias) return false
  return true
}

function fakeStorage() {
  const map = new Map()
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  }
  return map
}

beforeEach(() => {
  fakeStorage()
  dragging.value = null
  resizing.value = null
  renaming.value = null
})

test('areEqual returns false when keys differ', () => {
  const a = { key: 'key-a', merged: { temp: 1 }, alias: 'alias-a' }
  const b = { key: 'key-b', merged: { temp: 1 }, alias: 'alias-a' }
  assert.equal(areEqual(a, b), false)
})

test('areEqual returns false when merged differs', () => {
  const merged1 = { temp: 1 }
  const merged2 = { temp: 2 }
  const a = { key: 'key-a', merged: merged1, alias: 'alias-a' }
  const b = { key: 'key-a', merged: merged2, alias: 'alias-a' }
  assert.equal(areEqual(a, b), false)
})

test('areEqual returns false when alias differs', () => {
  const a = { key: 'key-a', merged: { temp: 1 }, alias: 'alias-a' }
  const b = { key: 'key-a', merged: { temp: 1 }, alias: 'alias-b' }
  assert.equal(areEqual(a, b), false)
})

test('areEqual returns true when same object reference', () => {
  const obj = { temp: 1 }
  const a = { key: 'key-a', merged: obj, alias: 'alias-a' }
  const b = { key: 'key-a', merged: obj, alias: 'alias-a' }
  assert.equal(areEqual(a, b), true)
})

test('areEqual skips re-render when dragging this card', () => {
  dragging.value = { key: 'key-a', moved: true }
  const a = { key: 'key-a', merged: { temp: 1 }, alias: 'alias-a' }
  const b = { key: 'key-a', merged: { temp: 2 }, alias: 'alias-b' }
  // Should return true because we're dragging this card - skip re-render
  assert.equal(areEqual(a, b), true)
})

test('areEqual does not skip when dragging different card', () => {
  dragging.value = { key: 'key-a', moved: true }
  const merged = { temp: 1 }
  const a = { key: 'key-b', merged: merged, alias: 'alias-a' }
  const b = { key: 'key-b', merged: merged, alias: 'alias-a' }
  // Same object reference, should return true
  assert.equal(areEqual(a, b), true)
  // But since merged differs...
  const c = { key: 'key-b', merged: { temp: 2 }, alias: 'alias-a' }
  assert.equal(areEqual(a, c), false)
})

test('areEqual skips re-render when resizing this card', () => {
  resizing.value = { key: 'key-a', w: 2, h: 2 }
  const a = { key: 'key-a', merged: { temp: 1 }, alias: 'alias-a' }
  const b = { key: 'key-a', merged: { temp: 2 }, alias: 'alias-b' }
  // Should return true because we're resizing this card - skip re-render
  assert.equal(areEqual(a, b), true)
})

test('areEqual does not skip when resizing different card', () => {
  resizing.value = { key: 'key-a', w: 2, h: 2 }
  const merged = { temp: 1 }
  const a = { key: 'key-b', merged: merged, alias: 'alias-a' }
  const b = { key: 'key-b', merged: merged, alias: 'alias-a' }
  // Same object reference, should return true
  assert.equal(areEqual(a, b), true)
  // But since merged differs...
  const c = { key: 'key-b', merged: { temp: 2 }, alias: 'alias-a' }
  assert.equal(areEqual(a, c), false)
})

test('gestureInFlight returns false when nothing is in flight', () => {
  assert.equal(gestureInFlight(), false)
})

test('gestureInFlight returns true when dragging', () => {
  dragging.value = { key: 'key-a', moved: true }
  assert.equal(gestureInFlight(), true)
})

test('gestureInFlight returns true when resizing', () => {
  resizing.value = { key: 'key-a', w: 2, h: 2 }
  assert.equal(gestureInFlight(), true)
})

test('gestureInFlight returns true when renaming', () => {
  renaming.value = 'key-a'
  assert.equal(gestureInFlight(), true)
})
