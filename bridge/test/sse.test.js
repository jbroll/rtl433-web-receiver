import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MAX_BUFFERED_BYTES, openStream } from '../src/sse.js'

// A minimal stand-in for http.ServerResponse: enough surface for openStream
// to write frames, read backpressure state, and hear a close. writableLength
// is a plain mutable field a test sets directly, rather than something that
// depends on the OS's actual socket buffers.
function fakeResponse({ writeReturns = true } = {}) {
  return {
    written: [],
    writableLength: 0,
    writable: true,
    destroyed: false,
    ended: false,
    writeHead() {},
    write(frame) {
      if (!this.writable) return false
      this.written.push(frame)
      return writeReturns
    },
    destroy() {
      this.writable = false
      this.destroyed = true
    },
    end() {
      this.writable = false
      this.ended = true
    },
    on() {},
  }
}

test('a write that reports backpressure but stays under the cap is kept open', () => {
  const res = fakeResponse({ writeReturns: false })
  const stream = openStream(res, ['#'], { maxBufferedBytes: 1024 })
  res.writableLength = 1024

  stream.write('data: a\n\n')

  assert.equal(res.destroyed, false)
  assert.equal(res.ended, false)
  assert.deepEqual(res.written.slice(-1), ['data: a\n\n'])
})

test('a write that reports backpressure past the cap is dropped via destroy, not end', () => {
  const res = fakeResponse({ writeReturns: false })
  const stream = openStream(res, ['#'], { maxBufferedBytes: 1024 })
  res.writableLength = 1025

  stream.write('data: a\n\n')

  assert.equal(res.destroyed, true)
  assert.equal(res.ended, false)
})

test('a large writableLength with no backpressure (write returns true) is not dropped', () => {
  const res = fakeResponse({ writeReturns: true })
  const stream = openStream(res, ['#'], { maxBufferedBytes: 1024 })
  res.writableLength = 10 * 1024 * 1024

  stream.write('data: a\n\n')

  assert.equal(res.destroyed, false)
})

test('a dropped stream ignores further writes', () => {
  const res = fakeResponse({ writeReturns: false })
  const stream = openStream(res, ['#'], { maxBufferedBytes: 1024 })
  res.writableLength = 2048
  stream.write('data: a\n\n')
  assert.equal(res.destroyed, true)

  const before = res.written.length
  stream.write('data: b\n\n')
  assert.equal(res.written.length, before)
})

test('close() ends the response and a write after close is a no-op', () => {
  const res = fakeResponse()
  const stream = openStream(res, ['#'], { maxBufferedBytes: 1024 })

  stream.close()
  assert.equal(res.ended, true)
  assert.equal(res.destroyed, false)

  const before = res.written.length
  res.writable = false
  stream.write('data: a\n\n')
  assert.equal(res.written.length, before)
})

test('MAX_BUFFERED_BYTES is the default cap when none is passed', () => {
  const res = fakeResponse({ writeReturns: false })
  const stream = openStream(res, ['#'])
  res.writableLength = MAX_BUFFERED_BYTES + 1

  stream.write('data: a\n\n')

  assert.equal(res.destroyed, true)
})
