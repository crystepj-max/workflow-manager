import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const STEPS = [
  '检查工作区',
  '安装依赖',
  '生成',
  '校验',
  '呈递验收',
  '按授权同步',
]
const CONSTRAINTS = [
  '不得提交凭据',
  '不得直接修改',
  '人工未通过验收前不得发布',
]
const text = readFileSync('guide.md', 'utf8')
for (const s of STEPS) assert.ok(text.includes(s), `missing step: ${s}`)
for (const c of CONSTRAINTS) assert.ok(text.includes(c), `missing constraint: ${c}`)
console.log(`O03 verify: pass (length=${[...text].length})`)
