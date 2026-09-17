import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const text = readFileSync('materials.md', 'utf8')
assert.ok(text.includes('8 单位'))
assert.ok(text.includes('4 单位'))
assert.ok(text.includes('6 单位'))
assert.ok(text.includes('转载'))
console.log('X01 verify: pass')
