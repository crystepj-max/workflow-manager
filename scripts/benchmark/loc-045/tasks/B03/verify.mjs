import assert from 'node:assert/strict'
import { listNumbers } from './list-numbers.mjs'

const input = [3, 1, 2, 1]
const out = listNumbers(input)
assert.deepEqual(out, input)
assert.deepEqual(listNumbers([]), [])
try {
  listNumbers('x')
  assert.fail('type error expected')
} catch (e) {
  assert.equal(e.name, 'TypeError')
}
console.log('B03 verify: pass (baseline no sort)')
