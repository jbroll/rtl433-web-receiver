import { timingSafeEqual } from 'node:crypto'

// A naive `===` leaks the token's length and prefix through response
// timing. Both HTTP's bearer-token check and MQTT's CONNECT-password check
// go through this one function so there is exactly one place that has to
// get the constant-time discipline right.
export function tokenMatches(provided, expected) {
  if (expected.length === 0) return false
  if (provided === undefined) return false
  const providedBuf = Buffer.isBuffer(provided) ? provided : Buffer.from(provided)
  const expectedBuf = Buffer.from(expected)
  if (providedBuf.length !== expectedBuf.length) return false
  return timingSafeEqual(providedBuf, expectedBuf)
}
