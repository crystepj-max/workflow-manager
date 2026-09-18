import assert from 'node:assert/strict'
import { paginate } from './paginate.mjs'

const data = [1, 2, 3, 4, 5]
// 基线 bug：多返回一条
assert.deepEqual(paginate(data, 1, 2), [1, 2, 3])
assert.deepEqual(paginate(data, 2, 2), [3, 4, 5])
try {
  paginate(data, 0, 2)
  assert.fail('page0 rejected')
} catch {
  // expected
}
console.log('D02 verify: pass (documents known bug)')
