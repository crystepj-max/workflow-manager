// 边类型模型纯函数单测（编辑器边判断条件适配业务结果路由，LOC-001）
// 覆盖：edgeKind 四类判定（含 HD result 边与编辑中空串）、applyEdgeKind 互斥清理
// （on/outcome 互斥、when 仅 success、countRound 仅业务边）、画布标签文本与宽度，
// 以及「applyEdgeKind 产物通过 validate-core」契约（与内核边规则防漂移）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import validatorCore from '../../../scripts/validate-core.cjs'

const { validateBlueprint } = validatorCore

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'src', 'client.js'), 'utf8')

// client.js 是动态客户端闭包（return { name, inject, apply }）；纯函数以顶层
// 属性导出，便于在不启动 React/jsdom 的情况下直接单测（与 schema-template 一致）。
const plugin = new Function(src)()
const { edgeKind, applyEdgeKind, edgeLabelText } = plugin
assert.equal(typeof edgeKind, 'function', 'client.js 顶层导出 edgeKind 纯函数')
assert.equal(typeof applyEdgeKind, 'function', 'client.js 顶层导出 applyEdgeKind 纯函数')
assert.equal(typeof edgeLabelText, 'function', 'client.js 顶层导出 edgeLabelText 纯函数')

const LABELS = { success: '成功', failure: '失败', technical: '重试' }

test('edgeKind：success / failure / technical / outcome 四类判定', () => {
  assert.equal(edgeKind({ from: 'a', to: 'b', on: 'success' }), 'success')
  assert.equal(edgeKind({ from: 'a', to: 'b', on: 'failure' }), 'failure')
  assert.equal(edgeKind({ from: 'a', to: 'a', on: 'technical' }), 'technical')
  assert.equal(edgeKind({ from: 'a', to: 'b', outcome: 'PASS' }), 'outcome')
})

test('edgeKind：HD result 边按 outcome 类型呈现；outcome 空串（编辑中）不跳变', () => {
  assert.equal(edgeKind({ from: '$human-decision', to: 'closeout', result: 'ACCEPT' }), 'outcome')
  assert.equal(edgeKind({ from: 'a', to: 'b', outcome: '' }), 'outcome')
})

test('edgeKind：无字段/非法入参兜底 success', () => {
  assert.equal(edgeKind({}), 'success')
  assert.equal(edgeKind(null), 'success')
  assert.equal(edgeKind(undefined), 'success')
})

test('applyEdgeKind：切到业务 outcome 清理 on/when，保留 countRound，outcome 置空待填', () => {
  assert.deepEqual(
    applyEdgeKind({ from: 'a', to: '$end', on: 'success', when: '$.ok == true', countRound: undefined }, 'outcome'),
    { from: 'a', to: '$end', outcome: '' }
  )
  assert.deepEqual(
    applyEdgeKind({ from: 'a', to: '$end', outcome: 'BLOCK', countRound: true }, 'outcome'),
    { from: 'a', to: '$end', outcome: 'BLOCK', countRound: true }
  )
})

test('applyEdgeKind：切回 success 保留 when；切到 failure/technical 清理 when', () => {
  assert.deepEqual(
    applyEdgeKind({ from: 'a', to: '$end', outcome: 'PASS' }, 'success'),
    { from: 'a', to: '$end', on: 'success' }
  )
  assert.deepEqual(
    applyEdgeKind({ from: 'a', to: '$end', on: 'success', when: '$.ok == true' }, 'success'),
    { from: 'a', to: '$end', on: 'success', when: '$.ok == true' }
  )
  assert.deepEqual(
    applyEdgeKind({ from: 'a', to: '$end', on: 'success', when: '$.ok == true' }, 'failure'),
    { from: 'a', to: '$end', on: 'failure' }
  )
  assert.deepEqual(
    applyEdgeKind({ from: 'a', to: '$end', outcome: 'PASS', countRound: true }, 'technical'),
    { from: 'a', to: '$end', on: 'technical' }
  )
})

test('applyEdgeKind：HD result 边沿原字段编辑，不新增 outcome 字段', () => {
  const next = applyEdgeKind({ from: '$human-decision', to: 'closeout', result: 'ACCEPT' }, 'outcome')
  assert.deepEqual(next, { from: '$human-decision', to: 'closeout', result: 'ACCEPT' })
})

test('applyEdgeKind：不修改入参对象', () => {
  const original = { from: 'a', to: '$end', on: 'success', when: '$.ok == true' }
  const snapshot = JSON.stringify(original)
  applyEdgeKind(original, 'outcome')
  assert.equal(JSON.stringify(original), snapshot)
})

test('edgeLabelText：业务边显示 outcome 名（含 HD result），其余按类型取文案', () => {
  assert.equal(edgeLabelText({ outcome: 'BLOCKED' }, LABELS), 'BLOCKED')
  assert.equal(edgeLabelText({ result: 'ACCEPT' }, LABELS), 'ACCEPT')
  assert.equal(edgeLabelText({ on: 'technical' }, LABELS), '重试')
  assert.equal(edgeLabelText({ on: 'failure' }, LABELS), '失败')
  assert.equal(edgeLabelText({ on: 'success' }, LABELS), '成功')
  // 编辑中 outcome 置空：不显示空标签，回落类型文案
  assert.equal(edgeLabelText({ outcome: '' }, LABELS), '成功')
})

// ── 契约：applyEdgeKind 产物必须通过 validate-core（与内核边规则防漂移）──────

// 旧模式最小蓝图（AI 输出验证节点：success/failure/when）
function legacyBlueprint(edge) {
  return {
    id: 'edge-model-legacy',
    displayName: '边模型旧模式契约测试',
    entry: 'n1',
    nodes: [{
      id: 'n1', profile: 'dev', goal: 'g',
      output: {
        schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
        successCondition: '$.ok == true',
      },
    }],
    edges: [edge, { from: 'n1', to: 'n1', on: 'failure' }],
  }
}

// 业务结果路由最小蓝图（outcomePath 节点：outcome/technical/countRound）
function routingBlueprint(edges) {
  return {
    id: 'edge-model-routing',
    displayName: '边模型路由契约测试',
    entry: 'n1',
    nodes: [{
      id: 'n1', profile: 'dev', goal: 'g',
      output: {
        schema: { type: 'object', properties: { route: { type: 'string', enum: ['PASS', 'BLOCK'] } }, required: ['route'] },
        outcomePath: '$.route',
      },
    }],
    edges,
  }
}

test('契约：切到业务 outcome（填值后）通过 validate-core', () => {
  const edge = applyEdgeKind({ from: 'n1', to: '$end', on: 'success', when: '$.ok == true' }, 'outcome')
  edge.outcome = 'PASS'
  const r = validateBlueprint(routingBlueprint([edge, { from: 'n1', to: '$end', outcome: 'BLOCK' }]))
  assert.equal(r.ok, true, JSON.stringify(r.errors))
})

test('契约：业务边带 countRound 通过 validate-core', () => {
  const r = validateBlueprint(routingBlueprint([
    { from: 'n1', to: 'n1', on: 'technical' },
    { from: 'n1', to: '$end', outcome: 'PASS' },
    { from: 'n1', to: '$end', outcome: 'BLOCK', countRound: true },
  ]))
  assert.equal(r.ok, true, JSON.stringify(r.errors))
})

test('契约：切到 technical（自环）通过 validate-core', () => {
  const edge = applyEdgeKind({ from: 'n1', to: '$end', outcome: 'PASS' }, 'technical')
  assert.equal(edge.to, '$end', 'applyEdgeKind 不改写拓扑，自环由用户改目标达成')
  const r = validateBlueprint(routingBlueprint([
    { from: 'n1', to: 'n1', on: 'technical' },
    { from: 'n1', to: '$end', outcome: 'PASS' },
    { from: 'n1', to: '$end', outcome: 'BLOCK' },
  ]))
  assert.equal(r.ok, true, JSON.stringify(r.errors))
})

test('契约：outcome 边切回 success（旧模式节点）通过 validate-core', () => {
  const successEdge = applyEdgeKind({ from: 'n1', to: '$end', outcome: 'PASS', countRound: true }, 'success')
  assert.equal('countRound' in successEdge, false, 'countRound 已清理')
  successEdge.when = '$.ok == true'
  assert.equal(validateBlueprint(legacyBlueprint(successEdge)).ok, true)
})

test('契约：outcome 边切回 failure（旧模式节点）通过 validate-core', () => {
  const failureEdge = applyEdgeKind({ from: 'n1', to: '$end', outcome: 'BLOCK', countRound: true }, 'failure')
  assert.equal('countRound' in failureEdge, false, 'countRound 已清理')
  const r = validateBlueprint({
    id: 'edge-model-legacy-failure',
    displayName: '边模型旧模式失败边契约测试',
    entry: 'n1',
    nodes: [{ id: 'n1', profile: 'dev', goal: 'g' }],
    edges: [failureEdge],
  })
  assert.equal(r.ok, true, JSON.stringify(r.errors))
})

test('契约（现状锁定）：旧模式节点直接挂 outcome 边被 validate-core 拒绝', () => {
  const bp = legacyBlueprint({ from: 'n1', to: '$end', outcome: 'PASS' })
  bp.nodes[0].output.successCondition = ''
  const r = validateBlueprint(bp)
  assert.equal(r.ok, false)
  assert.ok((r.errors || []).some(e => /outcomePath/.test(e.message)), JSON.stringify(r.errors))
})
