// #75 S-2b：内置 Outcome Preset 应用规划纯函数单测（packet s2b-preset-selector-001 设计 §3/§4）
// 覆盖：四态判定（DIRECT/CONFIRM/BLOCKED/NOOP）、冲突码、差异结构、候选不变量、输入不可变性，
// 以及 §7 强制场景的模型级断言（保存→重开的数据保真、多层路径无损、错误匹配）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'src', 'client.js'), 'utf8')
const plugin = new Function(src)()
const { planOutcomePresetApplication, applyRoutingWrite, routingValuesOf } = plugin

assert.equal(typeof planOutcomePresetApplication, 'function', 'client.js 顶层导出 planOutcomePresetApplication 纯函数')

const presets = JSON.parse(readFileSync(join(here, '../../../docs/design/outcome-presets.json'), 'utf8')).presets
const presetById = (id) => presets.find((p) => p.id === id)
const optimize = presetById('optimize-evaluator')

const freshRoutingNode = () => ({
  id: 'evaluate',
  output: { outcomePath: '', schema: { type: 'object', properties: {}, required: [] } },
})
const nodeWith = (output) => ({ id: 'evaluate', output })
const deep = (x) => JSON.parse(JSON.stringify(x))

test('四态：全新 routing 节点应用预设为 DIRECT，候选走既有 applyRoutingWrite', () => {
  const node = freshRoutingNode()
  const snapshot = deep(node)
  const plan = planOutcomePresetApplication(node, optimize, [], {})
  assert.equal(plan.status, 'DIRECT')
  assert.equal(plan.applicable, true)
  assert.deepEqual(plan.conflicts, [])
  assert.equal(plan.candidate.outcomePath, '$.route')
  assert.deepEqual(plan.candidate.schema.properties.route, { type: 'string', enum: ['PASS', 'OPTIMIZE', 'CONFIRM'] })
  assert.ok(plan.candidate.schema.required.includes('route'))
  assert.deepEqual(node, snapshot, '输入节点不得被修改')
})

test('四态：字段与取值完全一致为 NOOP，不产生候选', () => {
  const node = nodeWith(applyRoutingWrite(freshRoutingNode(), 'route', ['PASS', 'OPTIMIZE', 'CONFIRM']))
  const plan = planOutcomePresetApplication(node, optimize, [], {})
  assert.equal(plan.status, 'NOOP')
  assert.equal(plan.candidate, null)
  assert.ok(plan.warnings.length > 0, '缺边的取值仍应给出待配置去向警告')
})

test('四态：同名字段枚举有差异且无边引用为 CONFIRM，差异列出新增/移除/保留', () => {
  const node = nodeWith(applyRoutingWrite(freshRoutingNode(), 'route', ['PASS', 'CUSTOM_RETRY']))
  const plan = planOutcomePresetApplication(node, optimize, [], {})
  assert.equal(plan.status, 'CONFIRM')
  const diff = plan.differences[0]
  assert.deepEqual(diff.enumDiff, { added: ['OPTIMIZE', 'CONFIRM'], removed: ['CUSTOM_RETRY'], retained: ['PASS'] })
  assert.equal(diff.after, '$.route')
})

test('四态：既有边引用预设外取值为 BLOCKED，且不产生候选', () => {
  const node = nodeWith(applyRoutingWrite(freshRoutingNode(), 'route', ['PASS', 'CUSTOM_RETRY']))
  const edges = [{ from: 'evaluate', to: 'execute', outcome: 'CUSTOM_RETRY' }]
  const plan = planOutcomePresetApplication(node, optimize, edges, {})
  assert.equal(plan.status, 'BLOCKED')
  assert.equal(plan.conflicts[0].code, 'EDGE_OUTCOME_NOT_IN_PRESET')
  assert.deepEqual(plan.conflicts[0].detail, [{ from: 'evaluate', to: 'execute', outcome: 'CUSTOM_RETRY' }])
  assert.equal(plan.candidate, null)
})

test('四态：目标字段名被非路由属性占用为 BLOCKED（同名不等于有覆盖权限）', () => {
  const node = nodeWith({
    outcomePath: '$.decision',
    schema: { type: 'object', properties: { decision: { type: 'string' }, route: { type: 'string', enum: ['A'] } }, required: ['decision'] },
  })
  const plan = planOutcomePresetApplication(node, optimize, [], {})
  assert.equal(plan.status, 'BLOCKED')
  assert.equal(plan.conflicts[0].code, 'NON_ROUTING_FIELD_COLLISION')
})

test('四态：多层自定义路径为 BLOCKED（NESTED_PATH_UNSAFE），不得静默截断', () => {
  const node = nodeWith({
    outcomePath: '$.decision.route',
    schema: { type: 'object', properties: { decision: { type: 'object', properties: { route: { type: 'string', enum: ['PASS'] } } } }, required: [] },
  })
  const snapshot = deep(node)
  const plan = planOutcomePresetApplication(node, optimize, [], {})
  assert.equal(plan.status, 'BLOCKED')
  assert.equal(plan.conflicts[0].code, 'NESTED_PATH_UNSAFE')
  assert.deepEqual(node, snapshot, '§7 多层路径无损：原节点原样保留')
})

test('四态：目标字段既有属性带额外约束为 BLOCKED（UNSAFE_SCHEMA_CHANGE）', () => {
  const node = nodeWith(applyRoutingWrite(freshRoutingNode(), 'route', ['PASS']))
  node.output.schema.properties.route.minLength = 2
  const plan = planOutcomePresetApplication(node, optimize, [], {})
  assert.equal(plan.status, 'BLOCKED')
  assert.equal(plan.conflicts[0].code, 'UNSAFE_SCHEMA_CHANGE')
})

test('四态：boolean 路由字段为 BLOCKED（UNSUPPORTED_SCHEMA）', () => {
  const node = nodeWith({ outcomePath: '$.route', schema: { type: 'object', properties: { route: { type: 'boolean' } }, required: [] } })
  const plan = planOutcomePresetApplication(node, optimize, [], {})
  assert.equal(plan.status, 'BLOCKED')
  assert.equal(plan.conflicts[0].code, 'UNSUPPORTED_SCHEMA')
})

test('改名同步清理 required，预设候选可供用户明确确认', () => {
  const node = nodeWith({
    outcomePath: '$.decision',
    schema: { type: 'object', properties: { decision: { type: 'string', enum: ['PASS'] } }, required: ['decision'] },
  })
  const plan = planOutcomePresetApplication(node, optimize, [], {})
  assert.equal(plan.status, 'CONFIRM')
  assert.deepEqual(plan.candidate.schema.required, ['route'])
  assert.equal(plan.candidate.schema.properties.decision, undefined)
  assert.deepEqual(plan.candidate.schema.properties.route.enum, optimize.values)
})

test('组合约束仍引用旧结果字段时预设不能绕过安全拒绝', () => {
  const node = nodeWith({
    outcomePath: '$.decision',
    schema: { type: 'object', properties: { decision: { type: 'string', enum: ['PASS'] } }, required: ['decision'], allOf: [{ required: ['decision'] }] },
  })
  const before = deep(node)
  const plan = planOutcomePresetApplication(node, optimize, [], {})
  assert.equal(plan.status, 'BLOCKED')
  assert.equal(plan.conflicts[0].code, 'UNSAFE_SCHEMA_CHANGE')
  assert.equal(plan.candidate, null)
  assert.deepEqual(node, before)
})

test('草稿未提交与只读上下文必须阻塞', () => {
  const node = freshRoutingNode()
  assert.equal(planOutcomePresetApplication(node, optimize, [], { dirtyDraft: true }).conflicts[0].code, 'DIRTY_DRAFT')
  assert.equal(planOutcomePresetApplication(node, optimize, [], { readOnly: true }).conflicts[0].code, 'READ_ONLY_NODE')
})

test('预设数据本身不合法为 INVALID_PRESET', () => {
  const node = freshRoutingNode()
  for (const bad of [null, {}, { id: 'x' }, { id: 'x', outcomePath: 'route', values: ['A'] }, { id: 'x', outcomePath: '$.r', values: [] }, { id: 'x', outcomePath: '$.r', values: ['A', 'A'] }]) {
    assert.equal(planOutcomePresetApplication(node, bad, [], {}).conflicts[0].code, 'INVALID_PRESET')
  }
})

test('T-ACCEPT-02 零写入：BLOCKED 不产生候选，节点/边/completionPath 一律原样', () => {
  // 多层路径 + 预设外边引用 + 非路由属性撞名三类阻塞，逐一断言零写入
  const nested = nodeWith({
    outcomePath: '$.decision.route',
    completionPath: '$.completion_type',
    schema: { type: 'object', properties: { decision: { type: 'object', properties: { route: { type: 'string', enum: ['PASS'] } } } }, required: [] },
  })
  const edges = [{ from: 'evaluate', to: 'execute', outcome: 'PASS' }]
  const nestedSnapshot = deep(nested)
  const edgesSnapshot = deep(edges)
  const nestedPlan = planOutcomePresetApplication(nested, optimize, edges, {})
  assert.equal(nestedPlan.status, 'BLOCKED')
  assert.equal(nestedPlan.candidate, null, 'BLOCKED 不提供候选，UI 无可写回内容')
  assert.deepEqual(nested, nestedSnapshot, '节点原样')
  assert.deepEqual(edges, edgesSnapshot, '边原样')
  assert.equal(nested.output.completionPath, '$.completion_type', 'completionPath 原样')

  const foreign = nodeWith(applyRoutingWrite(freshRoutingNode(), 'route', ['PASS']))
  foreign.output.completionPath = '$.completion_type'
  const foreignEdges = [{ from: 'evaluate', to: 'execute', outcome: 'CUSTOM_RETRY' }]
  const foreignEdgesSnapshot = deep(foreignEdges)
  const foreignPlan = planOutcomePresetApplication(foreign, optimize, foreignEdges, {})
  assert.equal(foreignPlan.status, 'BLOCKED')
  assert.equal(foreignPlan.candidate, null)
  assert.equal(foreign.output.completionPath, '$.completion_type')
  assert.deepEqual(foreignEdges, foreignEdgesSnapshot, '边数组未被改动')
})

test('无既有配置时中文名与 source 回带；重复业务边为 BLOCKED', () => {
  const node = nodeWith(applyRoutingWrite(freshRoutingNode(), 'route', ['PASS', 'OPTIMIZE', 'CONFIRM']))
  const edges = [
    { from: 'evaluate', to: 'closeout', outcome: 'PASS' },
    { from: 'evaluate', to: 'execute', outcome: 'PASS' },
  ]
  const plan = planOutcomePresetApplication(node, optimize, edges, {})
  assert.equal(plan.status, 'BLOCKED')
  assert.equal(plan.conflicts[0].code, 'DUPLICATED_OUTCOME_EDGE')
  assert.equal(plan.source.presetId, 'optimize-evaluator')
})

test('§7 T-S2B-01/02 模型级：应用候选保存后与手填写回形态一致，可无损改回', () => {
  // 手填 → 选择：手填 $.route [PASS] 后应用预设（同名字段差异 → CONFIRM 候选）
  const handFilled = nodeWith(applyRoutingWrite(freshRoutingNode(), 'route', ['PASS']))
  const plan = planOutcomePresetApplication(handFilled, optimize, [], {})
  assert.equal(plan.status, 'CONFIRM')
  const applied = deep(plan.candidate)
  // 保存 → 重开：以应用结果为节点重新规划应为 NOOP（真实 DSL 回显一致）
  const reopened = nodeWith(applied)
  assert.equal(planOutcomePresetApplication(reopened, optimize, [], {}).status, 'NOOP')
  // 手动改回：既有手填能力（applyRoutingWrite）可恢复自定义配置
  const reverted = applyRoutingWrite(reopened, 'route', ['PASS'])
  assert.deepEqual(routingValuesOf({ id: 'evaluate', output: reverted }), ['PASS'])
})

test('四条真实预设对真实模板节点：模板自身配置必为 NOOP，全新节点必为 DIRECT', () => {
  const templateFiles = {
    'optimize-evaluator': ['templates/wf-optimize.json', 'evaluate'],
    'explore-evaluator': ['templates/wf-explore.json', 'evaluate'],
    'construction-review-route': ['templates/wf-construction-full-feature.json', 'review'],
    'diagnose-review-route': ['templates/wf-diagnose.json', 'review'],
  }
  for (const p of presets) {
    const [file, nodeId] = templateFiles[p.id]
    const tpl = JSON.parse(readFileSync(join(here, '../../..', file), 'utf8'))
    const node = tpl.nodes.find((n) => n.id === nodeId)
    assert.equal(planOutcomePresetApplication(node, p, [], {}).status, 'NOOP', p.id + '：模板节点自身配置应与预设一致')
    const fresh = freshRoutingNode()
    fresh.id = nodeId
    assert.equal(planOutcomePresetApplication(fresh, p, [], {}).status, 'DIRECT', p.id + '：全新节点应可直接应用')
  }
})
