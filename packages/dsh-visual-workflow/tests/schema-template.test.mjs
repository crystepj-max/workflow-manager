// 模板生成纯函数单测（beautifySchema 空字段自动填入的基础版 JSON Schema）
// 覆盖验收标准 ②③④⑤⑥ 的纯函数部分：类型推导、多级路径展开、fanout 骨架、
// verifyBranch required、最小骨架兜底，以及「生成结果通过 validate-core」契约。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import validatorCore from '../../../scripts/validate-core.cjs'

const { validateBlueprint, COND_RE } = validatorCore

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'src', 'client.js'), 'utf8')

// client.js 是动态客户端闭包体（return { name, inject, apply }）；纯函数以顶层
// 属性导出，便于在不启动 React/jsdom 的情况下直接单测（与 client.smoke 一致）。
const plugin = new Function(src)()
const buildSchemaTemplate = plugin.buildSchemaTemplate
assert.equal(typeof buildSchemaTemplate, 'function', 'client.js 顶层导出 buildSchemaTemplate 纯函数')

test('worker 无成功表达式（非 verifyBranch）→ 固定最小骨架', () => {
  assert.deepEqual(
    buildSchemaTemplate({ kind: 'worker' }),
    { type: 'object', properties: {}, required: [] }
  )
})

test('worker + $.result == true → boolean 写入 properties 与 required', () => {
  assert.deepEqual(
    buildSchemaTemplate({ kind: 'worker', successCondition: '$.result == true' }),
    { type: 'object', properties: { result: { type: 'boolean' } }, required: ['result'] }
  )
})

test('类型推导：==false→boolean、=="字符串"→string、==数字→number', () => {
  assert.equal(buildSchemaTemplate({ kind: 'worker', successCondition: '$.a == false' }).properties.a.type, 'boolean')
  assert.equal(buildSchemaTemplate({ kind: 'worker', successCondition: '$.a == "PASSED"' }).properties.a.type, 'string')
  assert.equal(buildSchemaTemplate({ kind: 'worker', successCondition: '$.a == 42' }).properties.a.type, 'number')
  assert.equal(buildSchemaTemplate({ kind: 'worker', successCondition: '$.a == -7' }).properties.a.type, 'number')
  assert.equal(buildSchemaTemplate({ kind: 'worker', successCondition: '$.a == 3.14' }).properties.a.type, 'number')
})

test('推导不出（null / != 字符串 / 空串）→ string 兜底', () => {
  assert.equal(buildSchemaTemplate({ kind: 'worker', successCondition: '$.a == null' }).properties.a.type, 'string')
  assert.equal(buildSchemaTemplate({ kind: 'worker', successCondition: '$.a != "REQUEST_CHANGES"' }).properties.a.type, 'string')
  assert.equal(buildSchemaTemplate({ kind: 'worker', successCondition: '$.a == ""' }).properties.a.type, 'string')
})

test('多级路径 $.a.b == x 按嵌套对象展开', () => {
  assert.deepEqual(
    buildSchemaTemplate({ kind: 'worker', successCondition: '$.a.b == true' }),
    {
      type: 'object',
      properties: { a: { type: 'object', properties: { b: { type: 'boolean' } }, required: ['b'] } },
      required: ['a'],
    }
  )
})

test('fanout → per-item 基础骨架（最小对象，忽略 successCondition）', () => {
  assert.deepEqual(
    buildSchemaTemplate({ kind: 'fanout', successCondition: '$.x == true' }),
    { type: 'object', properties: {}, required: [] }
  )
})

test('verifyBranch=true（无成功表达式）→ required 含 verified_branch 与 verified_head', () => {
  const s = buildSchemaTemplate({ kind: 'worker', verifyBranch: true })
  assert.deepEqual(s.required, ['verified_branch', 'verified_head'])
  assert.deepEqual(s.properties.verified_branch, { type: 'string' })
  assert.deepEqual(s.properties.verified_head, { type: 'string' })
})

test('verifyBranch=true + 成功表达式 → 派生字段与 verified_* 合并', () => {
  const s = buildSchemaTemplate({ kind: 'worker', successCondition: '$.result == true', verifyBranch: true })
  assert.deepEqual(s.properties.result, { type: 'boolean' })
  assert.ok(s.required.includes('verified_branch') && s.required.includes('verified_head'), 'required 含 verified_branch 与 verified_head')
  assert.deepEqual(s.properties.verified_branch, { type: 'string' })
  assert.deepEqual(s.properties.verified_head, { type: 'string' })
})

test('非法成功表达式不匹配 COND_RE → 不派生字段（最小骨架）', () => {
  assert.deepEqual(
    buildSchemaTemplate({ kind: 'worker', successCondition: 'not-a-condition' }),
    { type: 'object', properties: {}, required: [] }
  )
})

// 最小合法蓝图（单 worker 节点 + success 到 $end + failure 自环），用于喂 validate-core。
function minimalBlueprint(node, entry = 'n1') {
  return {
    id: 'schema-tpl-test',
    displayName: 'schema 模板测试',
    entry,
    nodes: [node],
    edges: [
      { from: entry, to: '$end', on: 'success' },
      { from: entry, to: entry, on: 'failure' },
    ],
  }
}

test('生成的 schema 通过 validate-core（successCondition 路径存在于 schema）', () => {
  const cases = [
    { cond: '$.result == true', schema: buildSchemaTemplate({ kind: 'worker', successCondition: '$.result == true' }) },
    { cond: '$.a.b == true', schema: buildSchemaTemplate({ kind: 'worker', successCondition: '$.a.b == true' }) },
    { cond: '$.result == "PASSED"', schema: buildSchemaTemplate({ kind: 'worker', successCondition: '$.result == "PASSED"' }) },
  ]
  for (const c of cases) {
    const r = validateBlueprint(minimalBlueprint({
      id: 'n1', profile: 'dev', goal: 'g', output: { schema: c.schema, successCondition: c.cond },
    }))
    assert.equal(r.ok, true, c.cond + ' → ' + JSON.stringify(r.errors))
  }
})

test('verifyBranch=true 生成的 schema 通过 validate-core（required 含 verified_*）', () => {
  const schema = buildSchemaTemplate({ kind: 'worker', verifyBranch: true, successCondition: '$.result == "PASSED"' })
  const r = validateBlueprint(minimalBlueprint({
    id: 'n1', profile: 'test', goal: 'g', verifyBranch: true, output: { schema, successCondition: '$.result == "PASSED"' },
  }))
  assert.equal(r.ok, true, JSON.stringify(r.errors))
})

// 防漂移门禁：client.js 是浏览器动态闭包，无法 import 内核，内联了一份成功表达式正则。
// 两侧一旦漂移，自动生成的 schema 与保存校验会给出不一致的路径判定，故在此锁定字面一致。
test('防漂移门禁：client.js 的 COND_RE 与 validate-core.cjs 字面一致', () => {
  assert.equal(
    plugin.COND_RE.source,
    COND_RE.source,
    'client.js 的 conditionRegex() 与 scripts/validate-core.cjs 的 COND_RE 已漂移，请同步两侧'
  )
})
