import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const FACTS = [
  '1. 项目名称为样板。',
  '2. 输入格式为JSON。',
  '3. 输出编码为UTF-8。',
  '4. 日志时间采用UTC。',
  '5. 每页默认20条。',
  '6. 最大重试次数为2。',
  '7. 空列表显示无数据。',
  '8. 文件名区分大小写。',
  '9. 错误输出写入stderr。',
  '10. 成功退出码为0。',
]
const text = readFileSync('document.md', 'utf8')
for (const f of FACTS) assert.ok(text.includes(f), `missing fact: ${f}`)
const len = [...text].length
assert.ok(len > 200, 'baseline should have compressible padding')
console.log(`O01 verify: pass (length=${len})`)
