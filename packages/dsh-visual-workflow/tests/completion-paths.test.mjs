// WFM-83：公开编辑模型的多层映射、schema 保真和投影契约。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import core from '../../../scripts/validate-core.cjs'
const ui = new Function(readFileSync(new URL('../src/client.js', import.meta.url), 'utf8'))()
const clone = (v) => JSON.parse(JSON.stringify(v))
const seed = () => ({ id: 'closeout', profile: 'closeout', goal: '输出完成原因', output: {
  outcomePath: '$.result.decision', completionPath: '$.result.completion', files: { 'report.md': 'markdown' },
  schema: { type: 'object', additionalProperties: false, required: ['result', 'summary'], properties: {
    summary: { type: 'string' },
    result: { type: 'object', required: ['decision', 'completion', 'evidence'], properties: {
      decision: { type: 'string', enum: ['DONE'], description: '去向', minLength: 1 },
      completion: { type: 'string', const: 'DELIVERED', description: '完成原因' },
      evidence: { type: 'string' },
    } },
  } },
} })

test('WFM-83 多层字段按内核路径语法回显，候选值读取当前节点 schema', () => {
  assert.equal(ui.routingNameOf('$.result.decision'), 'result.decision')
  assert.equal(ui.normalizeRoutingName(' $.result.1decision '), 'result.1decision')
  assert.deepEqual(ui.routingValuesOf(seed()), ['DONE'])
  assert.deepEqual(ui.routingValuesOf(seed(), 'completionPath'), ['DELIVERED'])
  assert.deepEqual(ui.routingCandidates(seed().output.schema), ['result.decision', 'result.completion'])
})

test('WFM-83 改取值不降层，保留注释/约束/其它字段且不修改入参', () => {
  for (const field of ['outcomePath', 'completionPath']) {
    const n = seed(), before = clone(n)
    const path = n.output[field]
    const out = ui.applyRoutingWrite(n, ui.routingNameOf(path), ['DONE', 'CUSTOM'], field)
    assert.equal(out[field], path)
    const leaf = core.schemaLeafAt(out.schema, core.parseJsonPath(path))
    assert.deepEqual(leaf.enum, ['DONE', 'CUSTOM'])
    assert.ok(leaf.description)
    assert.equal(leaf.const, undefined, '编辑取值时清理原 const，避免自相矛盾')
    assert.deepEqual(out.files, n.output.files)
    assert.deepEqual(out.schema.properties.summary, n.output.schema.properties.summary)
    assert.deepEqual(n, before)
  }
})

test('WFM-83 显式改路径清理旧叶子和 required，保留兄弟字段并支持单层往返', () => {
  const n = seed()
  const moved = ui.applyRoutingWrite(n, 'final.reason', ['CUSTOM'], 'completionPath')
  assert.equal(moved.completionPath, '$.final.reason')
  assert.equal(moved.schema.properties.result.properties.completion, undefined)
  assert.deepEqual(moved.schema.properties.result.required, ['decision', 'evidence'])
  assert.deepEqual(moved.schema.properties.final.required, ['reason'])
  assert.ok(moved.schema.properties.result.properties.decision)
  const flat = ui.applyRoutingWrite({ output: moved }, 'completion_type', ['CUSTOM'], 'completionPath')
  assert.equal(flat.schema.properties.final, undefined, '空路径容器被清理')
  assert.ok(!flat.schema.required.includes('final'), '空容器的 required 同步清理')
  assert.equal(flat.completionPath, '$.completion_type')
})

test('WFM-83 共用字段改映射不删除另一映射仍使用的属性', () => {
  const n = seed()
  n.output.completionPath = n.output.outcomePath
  const moved = ui.applyRoutingWrite(n, 'done', ['CUSTOM'], 'completionPath')
  assert.equal(moved.outcomePath, '$.result.decision')
  assert.deepEqual(core.schemaLeafAt(moved.schema, ['result', 'decision']), n.output.schema.properties.result.properties.decision)
  assert.equal(moved.completionPath, '$.done')
  assert.ok(moved.schema.properties.result.required.includes('decision'))
})

test('WFM-83 只声明完成字段保留已有 schema；未声明候选的 string 由内核接受', () => {
  const n = seed()
  delete n.output.completionPath
  n.output.schema.properties.summary.description = '自由文本完成原因'
  const out = ui.applyRoutingWrite(n, 'summary', undefined, 'completionPath')
  assert.equal(out.completionPath, '$.summary')
  assert.deepEqual(out.schema, n.output.schema)
  const bp = { id: 'nested-mapping', displayName: '多层映射', entry: n.id, control: { maxRounds: 3 }, nodes: [{ ...n, output: out }], edges: [{ from: n.id, to: '$end', outcome: 'DONE' }] }
  assert.equal(core.validateBlueprint(bp).ok, true, JSON.stringify(core.validateBlueprint(bp).errors))
  const roundtrip = core.projectToBlueprint(core.projectToVwf(bp))
  assert.deepEqual(roundtrip.nodes[0].output, out)
})


test('WFM-83 两种多层声明经蓝图与 DSL 双向保真，候选读取与校验内核一致', () => {
  const n = seed()
  n.output.outcomePath = '  $.result.decision  '
  n.output.completionPath = '  $.result.completion  '
  const bp = { id: 'nested-roundtrip', displayName: '双映射往返', entry: n.id, control: { maxRounds: 3 }, nodes: [n], edges: [{ from: n.id, to: '$end', outcome: 'DONE' }] }
  const v = core.validateBlueprint(bp)
  assert.equal(v.ok, true, JSON.stringify(v.errors))
  assert.deepEqual(core.projectToBlueprint(core.projectToVwf(bp)).nodes[0].output, n.output)
  for (const field of ['outcomePath', 'completionPath']) {
    const written = ui.applyRoutingWrite(n, ui.routingNameOf(n.output[field]), ['DONE'], field)
    assert.equal(written[field], n.output[field], '只改取值时声明路径逐字保留')
  }
  for (const leaf of [
    { oneOf: [{ enum: ['A', 'B'] }, { const: 'C' }] },
    { enum: ['B'], const: 'A' }, { type: 'boolean' }, { enum: [] }, { type: 'string' },
  ]) {
    const expected = core.enumerableValues(leaf)
    assert.deepEqual(ui.enumerableValues(leaf), expected && expected.map(String), '界面数据读取与真实内核相同')
  }
})

test('WFM-83 编辑已有错误 required 不抛异常，沿用旧编辑器的数组修复口径', () => {
  const node = seed()
  node.output.schema.required = 'result'
  const out = ui.applyRoutingWrite(node, 'result.decision', ['DONE'])
  assert.deepEqual(out.schema.required, ['result'])
  assert.deepEqual(out.schema.properties.result.properties.decision.enum, ['DONE'])
})
