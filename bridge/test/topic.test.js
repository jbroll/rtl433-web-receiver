import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { matchFilter, matchSplit, validFilter, validTopic } from '../src/topic.js'

// The topic rules are shared with receiver/topic.cpp; both suites run the
// same table so a change has to land in both implementations at once.
const cases = readFileSync(new URL('../../test/topic_cases.txt', import.meta.url), 'utf8')
  .split('\n')
  .filter((line) => line && !line.startsWith('#'))
  .map((line) => {
    const fields = line.split('|')
    const want = fields[fields.length - 1]
    return { fn: fields[0], a: fields[1], b: fields[2], want: want === 'true', line }
  })

for (const c of cases) {
  test(`shared case: ${c.line}`, () => {
    let got
    if (c.fn === 'validTopic') got = validTopic(c.a)
    else if (c.fn === 'validFilter') got = validFilter(c.a)
    else if (c.fn === 'matchFilter') got = matchFilter(c.a, c.b)
    else throw new Error(`unknown function ${c.fn}`)
    assert.equal(got, c.want, c.line)
  })
}

test('a non-string input is rejected', () => {
  assert.equal(validTopic(undefined), false)
  assert.equal(validTopic(null), false)
  assert.equal(validFilter(123), false)
})

test('matchSplit takes pre-split segments and agrees with matchFilter', () => {
  assert.equal(matchSplit(['a', '+', 'c'], ['a', 'b', 'c']), true)
  assert.equal(matchSplit(['a', '#'], ['a', 'b', 'c']), true)
  assert.equal(matchSplit(['a', 'b'], ['a', 'b', 'c']), false)
  assert.equal(matchSplit(['a', '+', 'c'], ['a', 'b', 'c']), matchFilter('a/+/c', 'a/b/c'))
})

test('# and + do not match a $-leading first topic segment', () => {
  assert.equal(matchFilter('#', '$SYS/broker/uptime'), false)
  assert.equal(matchFilter('+/x', '$SYS/x'), false)
  assert.equal(matchFilter('$SYS/#', '$SYS/x'), true)
  assert.equal(matchSplit(['#'], ['$SYS', 'broker', 'uptime']), false)
})
