import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const cost = readFileSync('cost-page.md', 'utf8')
assert.ok(cost.includes('未提供成本数字'))
assert.ok(cost.includes('无法计算总成本'))
console.log('X03 verify: pass')
