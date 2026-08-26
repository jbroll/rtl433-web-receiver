import { createHash, timingSafeEqual } from 'node:crypto'

const DIGEST_LENGTH = 32

// Both the token store and the matchers hash through this one function, so
// there's exactly one place responsible for getting it right.
export function digest(value) {
  return createHash('sha256').update(value).digest()
}

function isNonEmpty(value) {
  return (typeof value === 'string' || Buffer.isBuffer(value)) && value.length > 0
}

// Hashes both sides and compares digests, so timingSafeEqual always sees
// equal-length input and can never throw on a length mismatch.
export function tokenMatches(provided, expected) {
  if (!isNonEmpty(provided) || !isNonEmpty(expected)) return false
  return timingSafeEqual(digest(provided), digest(expected))
}

// Like tokenMatches, but expectedDigest is already a computed 32-byte
// digest (the token store's cached value on the hot path) and is not hashed.
export function digestMatches(provided, expectedDigest) {
  if (!isNonEmpty(provided)) return false
  if (!Buffer.isBuffer(expectedDigest) || expectedDigest.length !== DIGEST_LENGTH) return false
  return timingSafeEqual(digest(provided), expectedDigest)
}
