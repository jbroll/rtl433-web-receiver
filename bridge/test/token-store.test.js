import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createTokenStore } from '../src/token-store.js'

test('with no path, get() returns the initial token and rotate() only changes memory', () => {
  const store = createTokenStore('s3cr3t')
  assert.equal(store.get(), 's3cr3t')
  store.rotate('n3wt0k3n')
  assert.equal(store.get(), 'n3wt0k3n')
})

test('with a path and no existing file, get() returns the initial token', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bridge-token-store-'))
  try {
    const tokenPath = path.join(dir, 'auth-token')
    const store = createTokenStore('s3cr3t', { path: tokenPath })
    assert.equal(store.get(), 's3cr3t')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('with a path and an existing file, the file wins over the initial token', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bridge-token-store-'))
  try {
    const tokenPath = path.join(dir, 'auth-token')
    writeFileSync(tokenPath, 'fromfile\n')
    const store = createTokenStore('s3cr3t', { path: tokenPath })
    assert.equal(store.get(), 'fromfile')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rotate() persists to the path so a fresh store picks it up', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bridge-token-store-'))
  try {
    const tokenPath = path.join(dir, 'auth-token')
    const store = createTokenStore('s3cr3t', { path: tokenPath })
    store.rotate('rotated')
    assert.equal(readFileSync(tokenPath, 'utf8'), 'rotated')

    const reopened = createTokenStore('s3cr3t', { path: tokenPath })
    assert.equal(reopened.get(), 'rotated')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rotate() with no path leaves nothing on disk', () => {
  const store = createTokenStore('s3cr3t')
  assert.doesNotThrow(() => store.rotate('rotated'))
})

test('rotate() into a directory that does not exist throws and leaves get() returning the old token', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bridge-token-store-'))
  try {
    const tokenPath = path.join(dir, 'missing-subdir', 'auth-token')
    const store = createTokenStore('s3cr3t', { path: tokenPath })
    assert.throws(() => store.rotate('rotated'))
    assert.equal(store.get(), 's3cr3t')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rotate() persists the token file with mode 0600', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bridge-token-store-'))
  try {
    const tokenPath = path.join(dir, 'auth-token')
    const store = createTokenStore('s3cr3t', { path: tokenPath })
    store.rotate('rotated')
    assert.equal(statSync(tokenPath).mode & 0o777, 0o600)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a token with surrounding whitespace comes back identical from a reopened store', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bridge-token-store-'))
  try {
    const tokenPath = path.join(dir, 'auth-token')
    const store = createTokenStore('s3cr3t', { path: tokenPath })
    store.rotate('  padded-token  ')
    assert.equal(store.get(), 'padded-token')

    const reopened = createTokenStore('s3cr3t', { path: tokenPath })
    assert.equal(reopened.get(), 'padded-token')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an all-whitespace token is rejected by rotate rather than persisted', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bridge-token-store-'))
  try {
    const tokenPath = path.join(dir, 'auth-token')
    const store = createTokenStore('s3cr3t', { path: tokenPath })
    assert.throws(() => store.rotate('   '))
    assert.equal(store.get(), 's3cr3t')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
