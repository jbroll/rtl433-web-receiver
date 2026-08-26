import { createHash, timingSafeEqual } from 'node:crypto'

const DIGEST_LENGTH = 32

// SHA-256 digest of a token. Both the token store and tokenMatches hash
// through this one function, so there's exactly one place responsible for
// getting it right.
export function digest(value) {
  return createHash('sha256').update(value).digest()
}

function isNonEmpty(value) {
  return (typeof value === 'string' || Buffer.isBuffer(value)) && value.length > 0
}

// Comparing digests instead of raw bytes buys two things: both sides are
// always the same 32-byte length, so timingSafeEqual can never throw on a
// length mismatch, and there's one place that has to hash correctly. `expected`
// may be a raw token (hashed here) or an already-computed 32-byte digest, which
// is how the token store's cached digest reaches this unchanged on the hot path.
export function tokenMatches(provided, expected) {
  if (!isNonEmpty(provided) || !isNonEmpty(expected)) return false
  const expectedDigest =
    Buffer.isBuffer(expected) && expected.length === DIGEST_LENGTH ? expected : digest(expected)
  return timingSafeEqual(digest(provided), expectedDigest)
}
