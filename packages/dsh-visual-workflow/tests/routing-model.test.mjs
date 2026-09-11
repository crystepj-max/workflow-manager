// 业务结果路由模型纯函数单测（LOC-001 基线 V2：录入体验改造）
// 覆盖：参数名友好录入归一、可穷举判定、取值读取、写入合并（保留 schema 其它属性与 files）、
// 改名清孤儿、边存在性（ok/missing/duplicated + 未声明取值），以及与 validate-core 的
// 防漂移契约（UI 写出的形态内核必须接受；枚举缺边必须被内核拦下）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import validatorCore from '../../../scripts/validate-core.cjs'

const { validateBlueprint } = validatorCore

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'src', 'client.js'), 'utf8')
const plugin = new Function(src)()
const {
  routingNameOf,
  normalizeRoutingName,
  routingPathOf,
  enumerableValues,
  routingCandidates,
  routingValuesOf,
  applyRoutingWrite,
  routingEdgeStatus,
} = plugin

assert.equal(typeof applyRoutingWrite, 'function', 'client.js 顶层导出 applyRoutingWrite 纯函数')
assert.equal(typeof routingEdgeStatus, 'function', 'client.js 顶层导出 routingEdgeStatus 纯函数')

test('参数名：$.route ↔ route 双向，非法名不写入', () => {
  assert.equal(routingNameOf('$.route'), 'route')
  assert.equal(routingNameOf('  $.need_test  '), 'need_test')
  assert.equal(routingNameOf('route'), '', '缺 $. 前缀不算路由路径')
  assert.equal(routingNameOf('$.a.b'), '', '多段路径不支持')
  assert.equal(routingNameOf('$.1bad'), '', '不能以数字开头')
  assert.equal(routingNameOf(''), '')
  assert.equal(routingPathOf('route'), '$.route')
  assert.equal(routingPathOf(''), '')
})

test('友好录入归一：接受 $.route / route / 空白，拒绝非法字符', () => {
  assert.equal(normalizeRoutingName('route'), 'route')
  assert.equal(normalizeRoutingName('$.route'), 'route')
  assert.equal(normalizeRoutingName('  $.route '), 'route')
  assert.equal(normalizeRoutingName('need_test'), 'need_test')
  assert.equal(normalizeRoutingName('1bad'), '')
  assert.equal(normalizeRoutingName('a-b'), '')
  assert.equal(normalizeRoutingName(''), '')
  assert.equal(normalizeRoutingName(null), '')
})

test('可穷举判定与内核同构：enum / oneOf 全常量 / const / boolean', () => {
  assert.deepEqual(enumerableValues({ type: 'string', enum: ['pass', 'block'] }), ['pass', 'block'])
  assert.deepEqual(enumerableValues({ oneOf: [{ const: 'A' }, { const: 'B' }] }), ['A', 'B'])
  assert.equal(enumerableValues({ oneOf: [{ const: 'A' }, { type: 'string' }] }), null)
  assert.deepEqual(enumerableValues({ const: 'SHIP' }), ['SHIP'])
  assert.deepEqual(enumerableValues({ type: 'boolean' }), ['true', 'false'])
  assert.equal(enumerableValues({ type: 'string', enum: [] }), null)
  assert.equal(enumerableValues({ type: 'string' }), null)
})

test('routingCandidates：只列出可穷举属性（进档恢复 R6 用）', () => {
  const schema = {
    type: 'object',
    properties: {
      route: { type: 'string', enum: ['pass', 'block'] },
      summary: { type: 'string' },
      done: { type: 'boolean' },
    },
  }
  assert.deepEqual(routingCandidates(schema), ['route', 'done'])
  assert.deepEqual(routingCandidates(null), [])
})

test('routingValuesOf：以 schema 为唯一真源', () => {
  const node = { output: { outcomePath: '$.route', schema: { properties: { route: { type: 'string', enum: ['pass', 'block'] } } } } }
  assert.deepEqual(routingValuesOf(node), ['pass', 'block'])
  assert.deepEqual(routingValuesOf({ output: { outcomePath: '', schema: {} } }), [])
  assert.deepEqual(routingValuesOf({}), [])
})

test('applyRoutingWrite：写入参数名与取值，保留其它 schema 属性、required 与 files', () => {
  const node = {
    output: {
      schema: {
        type: 'object',
        properties: { summary: { type: 'string' } },
        required: ['summary'],
        additionalProperties: false,
      },
      files: { 'report.md': 'markdown' },
    },
  }
  const out = applyRoutingWrite(node, 'route', ['pass', 'block'])
  assert.equal(out.outcomePath, '$.route')
  assert.deepEqual(out.schema.properties.route, { type: 'string', enum: ['pass', 'block'] })
  assert.deepEqual(out.schema.properties.summary, { type: 'string' }, '其它属性保留')
  assert.deepEqual(out.schema.required, ['summary', 'route'], 'routing 字段进入 required')
  assert.deepEqual(out.schema.additionalProperties, false, '其它 schema 键保留')
  assert.deepEqual(out.files, { 'report.md': 'markdown' }, 'files 不被破坏')
})

test('applyRoutingWrite：空取值写出可读形态；改名清掉旧属性键', () => {
  const empty = applyRoutingWrite({ output: {} }, 'route', ['', '  '])
  assert.deepEqual(empty.schema.properties.route, { type: 'string' }, '无取值时不留空 enum')
  assert.equal(empty.outcomePath, '$.route')

  const renamed = applyRoutingWrite({ output: empty }, 'verdict', ['PASS'])
  assert.equal(renamed.outcomePath, '$.verdict')
  assert.equal(renamed.schema.properties.route, undefined, '旧属性键被清除，不留孤儿枚举')
  assert.deepEqual(renamed.schema.properties.verdict, { type: 'string', enum: ['PASS'] })

  const cleared = applyRoutingWrite({ output: renamed }, '', [])
  assert.equal(cleared.outcomePath, '')
  assert.equal(cleared.schema.properties.verdict, undefined)
})

test('routingEdgeStatus：✅ 有边 / ⚠️ 无边 / ❗ 多条边 + 未声明取值告警', () => {
  const dsl = {
    nodes: [{ id: 'step-1', output: { outcomePath: '$.route', schema: { properties: { route: { type: 'string', enum: ['pass', 'block', 'skip'] } } } } }],
    edges: [
      { from: 'step-1', to: 'step-2', outcome: 'pass' },
      { from: 'step-1', to: '$end', outcome: 'block' },
      { from: 'step-1', to: '$end', outcome: 'block' },
      { from: 'step-1', to: 'step-3', outcome: 'legacy' },
      { from: 'step-1', to: 'step-2', on: 'technical' },
      { from: 'other', to: '$end', outcome: 'pass' },
    ],
  }
  const st = routingEdgeStatus(dsl, 'step-1')
  const byValue = {}
  st.values.forEach((r) => { byValue[r.value] = r })
  assert.equal(byValue.pass.state, 'ok')
  assert.deepEqual(byValue.pass.edgeIndexes, [0])
  assert.equal(byValue.block.state, 'duplicated', '同一取值两条边 → 重复告警')
  assert.deepEqual(byValue.block.edgeIndexes, [1, 2])
  assert.equal(byValue.skip.state, 'missing', '无对应边 → 待补边')
  assert.deepEqual(st.undeclared, [{ edgeIndex: 3, value: 'legacy', to: 'step-3' }], '非 outcome 边与别的节点不计入')
})

test('契约防漂移：UI 写出的路由形态内核接受；枚举缺边时内核拦下', () => {
  const routeOutput = applyRoutingWrite({ output: {} }, 'route', ['pass', 'block'])
  const bp = {
    id: 'routing-write-check',
    displayName: '路由写入契约',
    entry: 'step-1',
    control: { maxRounds: 3 },
    nodes: [
      { id: 'step-1', profile: 'evaluator', goal: '判定并输出 route', output: routeOutput },
      { id: 'step-2', profile: 'dev', goal: '执行' },
    ],
    edges: [
      { from: 'step-1', to: 'step-2', outcome: 'pass' },
      { from: 'step-1', to: '$end', outcome: 'block' },
      { from: 'step-2', to: '$end', on: 'success' },
    ],
  }
  const ok = validateBlueprint(bp)
  assert.equal(ok.ok, true, 'UI 写出的 outcomePath + enum 形态内核接受：' + JSON.stringify(ok.errors))

  const missing = JSON.parse(JSON.stringify(bp))
  missing.edges = missing.edges.filter((e) => e.outcome !== 'block')
  const bad = validateBlueprint(missing)
  assert.equal(bad.ok, false)
  assert.ok(
    bad.errors.some((e) => /block/.test(e.message) && /outcome/.test(e.message)),
    '缺边的取值被内核点名：' + JSON.stringify(bad.errors)
  )
})
