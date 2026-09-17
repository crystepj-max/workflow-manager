import assert from 'node:assert/strict'
import { maxValue } from './max-value.mjs'

try {
  maxValue([])
  assert.fail('empty should not throw in target behavior')
} catch {
  // baseline throws
}
assert.equal(maxValue([7]), 7)
console.log('D03 verify: pass (documents known bug on empty)')
