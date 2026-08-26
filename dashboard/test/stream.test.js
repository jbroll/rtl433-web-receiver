import { test, mock, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { openSource } from '../src/stream.js'

class FakeEventSource {
  constructor(url) {
    this.url = url
    this.readyState = FakeEventSource.CONNECTING
    FakeEventSource.instances.push(this)
  }
  close() { this.readyState = FakeEventSource.CLOSED }
}
FakeEventSource.CONNECTING = 0
FakeEventSource.OPEN = 1
FakeEventSource.CLOSED = 2
FakeEventSource.instances = []

function handlers(states) {
  return {
    onState: (base, state) => states.push(state),
    onMessage() {}, onAlias() {}, onLayout() {}, onLocation() {}, onTz() {}, onUnits() {},
  }
}

beforeEach(() => {
  FakeEventSource.instances = []
  globalThis.EventSource = FakeEventSource
  mock.timers.enable({ apis: ['setTimeout'] })
  mock.method(Math, 'random', () => 0.5) // fixes the jitter factor at 1.0
})

afterEach(() => {
  mock.timers.reset()
  mock.restoreAll()
})

test('a dropped socket retries with exponential backoff, not a flat delay', () => {
  const source = openSource('http://a.b', handlers([]))
  const es0 = FakeEventSource.instances[0]

  es0.readyState = FakeEventSource.CLOSED
  es0.onerror()
  mock.timers.tick(999)
  assert.equal(FakeEventSource.instances.length, 1, 'retried before the n=0 backoff elapsed')
  mock.timers.tick(1)
  assert.equal(FakeEventSource.instances.length, 2, 'no retry after the 1000ms n=0 backoff')

  const es1 = FakeEventSource.instances[1]
  es1.readyState = FakeEventSource.CLOSED
  es1.onerror()
  mock.timers.tick(1999)
  assert.equal(FakeEventSource.instances.length, 2, 'retried before the n=1 backoff elapsed')
  mock.timers.tick(1)
  assert.equal(FakeEventSource.instances.length, 3, 'no retry after the 2000ms n=1 backoff')

  source.close()
})

test('the backoff caps at 30 seconds', () => {
  const source = openSource('http://a.b', handlers([]))
  const delays = [1000, 2000, 4000, 8000, 16000, 30000, 30000]
  for (const delay of delays) {
    const before = FakeEventSource.instances.length
    const es = FakeEventSource.instances[before - 1]
    es.readyState = FakeEventSource.CLOSED
    es.onerror()
    mock.timers.tick(delay - 1)
    assert.equal(FakeEventSource.instances.length, before, `retried before the ${delay}ms backoff elapsed`)
    mock.timers.tick(1)
    assert.equal(FakeEventSource.instances.length, before + 1)
  }
  source.close()
})

test('onopen resets the backoff to the initial delay', () => {
  const source = openSource('http://a.b', handlers([]))
  const es0 = FakeEventSource.instances[0]
  es0.readyState = FakeEventSource.CLOSED
  es0.onerror()
  mock.timers.tick(1000)

  const es1 = FakeEventSource.instances[1]
  es1.onopen()
  es1.readyState = FakeEventSource.CLOSED
  es1.onerror()
  mock.timers.tick(999)
  assert.equal(FakeEventSource.instances.length, 2, 'retried before the reset n=0 backoff elapsed')
  mock.timers.tick(1)
  assert.equal(FakeEventSource.instances.length, 3, 'backoff did not reset after onopen')

  source.close()
})

test('a superseded socket cannot reset the attempt count or schedule its own retry', () => {
  const states = []
  const source = openSource('http://a.b', handlers(states))
  const es0 = FakeEventSource.instances[0]
  es0.readyState = FakeEventSource.CLOSED
  es0.onerror()
  mock.timers.tick(1000)
  assert.equal(FakeEventSource.instances.length, 2)

  const statesBefore = states.length
  es0.readyState = FakeEventSource.CLOSED
  es0.onerror()
  assert.equal(states.length, statesBefore, 'a superseded socket must not report its own state')
  mock.timers.tick(100000)
  assert.equal(FakeEventSource.instances.length, 2, 'a superseded socket must not schedule its own retry')

  source.close()
})
