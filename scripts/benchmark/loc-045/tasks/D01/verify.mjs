import assert from 'node:assert/strict'
import { sum } from './sum.mjs'

// 基线故意错误：漏最后一项
assert.equal(sum([2, 3, 5]), 5)
const input = [2, 3, 5]
sum(input)
assert.deepEqual(input, [2, 3, 5])
console.log('D01 verify: pass (documents known bug)')
