import { test } from 'node:test'
import assert from 'node:assert/strict'
import { field, parseSpecVersion, TASK_FIELDS } from '../task-card-parse.mjs'
import { STATUSES, STATUS_LOCAL_DEFINED, STATUS_WAITING_ACCEPTANCE, STATUS_MERGED } from '../local-task-registry.mjs'

const SPEC = `# 任务规格 V2

**版本**：V2

正文提及 task-spec-V9 不应优先于显式声明。
`

test('field：提取表格字段并 trim', () => {
  const md = '# 卡\n\n| 字段 | 值 |\n|---|---|\n| 任务标识 | `LOC-002` |\n'
  assert.equal(field(md, '任务标识'), '`LOC-002`')
})

test('field：多行同名取第一个；缺失返回 null；空文件返回 null', () => {
  const md = '| 优先级 | P1 |\n\n| 优先级 | P2 |\n'
  assert.equal(field(md, '优先级'), 'P1')
  assert.equal(field('# 无表格', '优先级'), null)
  assert.equal(field('', '优先级'), null)
})

test('field：值中的竖线在第一个竖线处截断（现行为钉住）', () => {
  assert.equal(field('| 前置依赖 | 无 | 附注 |\n', '前置依赖'), '无')
})

test('TASK_FIELDS：字段名词汇无正则元字符（field 的正则插值安全性）', () => {
  for (const v of Object.values(TASK_FIELDS)) {
    assert.match(v, /^[A-Za-z0-9\u4e00-\u9fa5\s]+$/, `字段名含不安全字符：${v}`)
  }
})

test('parseSpecVersion ①：需求基线版本表格字段优先', () => {
  const md = '| 需求基线版本 | V3 |\n\n**版本**：V2\n'
  assert.equal(parseSpecVersion(md, '/x/task-spec-V1.md'), 'V3')
})

test('parseSpecVersion ②：**版本**：VN', () => {
  assert.equal(parseSpecVersion(SPEC, '/x/task-spec-V1.md'), 'V2')
})

test('parseSpecVersion ③：版本：VN（含全角冒号）', () => {
  assert.equal(parseSpecVersion('# t\n\n版本：V4\n', ''), 'V4')
  assert.equal(parseSpecVersion('# t\n\n版本：V5\n', ''), 'V5')
})

test('parseSpecVersion ④：标题行 VN', () => {
  assert.equal(parseSpecVersion('# 任务规格 V6\n\n正文无版本声明\n', ''), 'V6')
})

test('parseSpecVersion ⑤：task-spec-VN 正文标记', () => {
  assert.equal(parseSpecVersion('关联规格 task-spec-V7 的说明\n', ''), 'V7')
})

test('parseSpecVersion ⑥：文件名 VN 兜底', () => {
  assert.equal(parseSpecVersion('没有任何版本标记\n', '/x/y/task-spec-V8.md'), 'V8')
})

test('parseSpecVersion：全不命中返回 null', () => {
  assert.equal(parseSpecVersion('没有任何版本标记\n', '/x/y/other.md'), null)
  assert.equal(parseSpecVersion('', ''), null)
})

test('状态词汇唯一来源：registry 命名常量与 STATUSES 一致且值钉死', () => {
  assert.equal(STATUS_LOCAL_DEFINED, '本地已定义')
  assert.equal(STATUS_WAITING_ACCEPTANCE, '等待验收')
  assert.equal(STATUS_MERGED, '已合并')
  assert.ok(STATUSES.includes(STATUS_LOCAL_DEFINED))
  assert.ok(STATUSES.includes(STATUS_WAITING_ACCEPTANCE))
  assert.ok(STATUSES.includes(STATUS_MERGED))
})
