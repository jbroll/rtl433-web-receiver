import { test } from 'node:test'
import assert from 'node:assert/strict'

import { digest, digestMatches, tokenMatches } from '../src/auth.js'

test('the right token matches, string or buffer', () => {
  assert.equal(tokenMatches('s3cr3t', 's3cr3t'), true)
  assert.equal(tokenMatches(Buffer.from('s3cr3t'), 's3cr3t'), true)
})

test('a wrong token of the same length does not match', () => {
  assert.equal(tokenMatches('s3cr3u', 's3cr3t'), false)
})

test('a token of a different length does not match', () => {
  assert.equal(tokenMatches('short', 's3cr3t'), false)
  assert.equal(tokenMatches('a-much-longer-guess', 's3cr3t'), false)
})

test('a missing token does not match', () => {
  assert.equal(tokenMatches(undefined, 's3cr3t'), false)
  assert.equal(tokenMatches('', 's3cr3t'), false)
})

test('an empty expected token never matches, even an empty provided one', () => {
  // AUTH_TOKEN is never configured as "", but a caller passing one through
  // should not get a false "everything matches" from a zero-length compare.
  assert.equal(tokenMatches('', ''), false)
  assert.equal(tokenMatches('anything', ''), false)
})

test('undefined, null, a number, and an object as expected all return false without throwing', () => {
  assert.equal(tokenMatches('s3cr3t', undefined), false)
  assert.equal(tokenMatches('s3cr3t', null), false)
  assert.equal(tokenMatches('s3cr3t', 42), false)
  assert.equal(tokenMatches('s3cr3t', {}), false)
})

test('a Buffer expected is hashed like any other value, not treated as a digest', () => {
  assert.equal(tokenMatches('s3cr3t', Buffer.from('s3cr3t')), true)
  assert.equal(tokenMatches('s3cr3t', digest('s3cr3t')), false)
})

test('digestMatches: the right token matches its precomputed digest', () => {
  const d = digest('s3cr3t')
  assert.equal(digestMatches('s3cr3t', d), true)
  assert.equal(digestMatches(Buffer.from('s3cr3t'), d), true)
  assert.equal(digestMatches('wrong', d), false)
})

test('digestMatches: a missing provided token does not match', () => {
  assert.equal(digestMatches(undefined, digest('s3cr3t')), false)
  assert.equal(digestMatches('', digest('s3cr3t')), false)
})

test('digestMatches: undefined, null, a number, and an object as expectedDigest all return false without throwing', () => {
  assert.equal(digestMatches('s3cr3t', undefined), false)
  assert.equal(digestMatches('s3cr3t', null), false)
  assert.equal(digestMatches('s3cr3t', 42), false)
  assert.equal(digestMatches('s3cr3t', {}), false)
})

test('digestMatches: an expectedDigest that is a Buffer of the wrong length does not match', () => {
  assert.equal(digestMatches('s3cr3t', Buffer.alloc(16)), false)
  assert.equal(digestMatches('s3cr3t', Buffer.alloc(33)), false)
})

test('the aedes path, a Buffer password against a nullish digest, does not throw', () => {
  assert.equal(digestMatches(Buffer.from('anything'), undefined), false)
})
