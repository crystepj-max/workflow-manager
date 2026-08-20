// 运行时排练厅对拍套件（候选三）——第三层：同一批场景跑翻译员 B（host compileDsl）译文，
// 公共语义断言与引擎侧一致（C1）；三个已知差异断言确实存在（C2）。
// C2 的差异断言翻转为「一致」的那一天 = 候选一（统一编译器）完工日。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { compileDsh, generateAll, projectToVwf } from '../generate.mjs'
import { runGeneratedScript, makeAgentScript } from './helpers/runtime-harness.mjs'
import { loadHost } from '../../packages/dsh-visual-workflow/tests/helpers/load-host.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const tplDir = path.join(here, '../../templates')
const tpl = JSON.parse(readFileSync(path.join(tplDir, 'dev-workflow-2-0.json'), 'utf8'))
const mini = JSON.parse(readFileSync(path.join(here, 'fixtures/hello-blueprint.json'), 'utf8'))

// host 半加载 → vwf.script RPC 取编译产物（校验通过即编译）
async function compileHost(bp) {
  const { handlers } = loadHost()
  const dsl = bp === tpl
    ? JSON.parse(generateAll(tplDir).files.get('dev-workflow-2-0/vwf-dsl.json'))
    : projectToVwf(bp)
  const c = await handlers.get('vwf.script')({ dsl })
  if (!c.ok) throw new Error('host 编译失败：' + JSON.stringify(c.errors))
  return c.script
}

// 同表双跑：返回 { engine, host }（各自 { result, agentCalls, logs }）
async function dualRun(bp, table, args = {}) {
  const engine = await (async () => {
    const { script } = compileDsh(bp)
    return runGeneratedScript(script, { args, agent: makeAgentScript(table) })
  })()
  const host = await runGeneratedScript(await compileHost(bp), { args, agent: makeAgentScript(table) })
  return { engine, host }
}

// 公共语义投影（排除引擎/宿主已知差异字段：results 形状、reschedule、dispatch 载荷）
const common = (r) => ({
  status: r.status, taskId: r.taskId, round: r.round, rounds: r.rounds,
  node: r.node, stage: r.stage, detail: r.detail, history: r.history,
  resume: r.resume, result: r.result,
})

// ---------- C1 · 公共语义一致（微型图纸，框架级） ----------
test('C1 对拍-幸福路径：DONE 与出场顺序完全一致', async () => {
  const { engine, host } = await dualRun(mini, {
    dispatch: { complete: true }, work: { status: 'completed' },
    gate: { verdict: 'ok' }, finish: { done: true },
  })
  assert.deepEqual(common(host.result), common(engine.result))
  assert.deepEqual(host.agentCalls.map((c) => c.label), engine.agentCalls.map((c) => c.label))
})

test('C1 对拍-失败出口：FAILED_AT_dispatch 一致', async () => {
  const { engine, host } = await dualRun(mini, { dispatch: { complete: false } })
  assert.deepEqual(common(host.result), common(engine.result))
})

test('C1 对拍-打回循环与超限：轮次/历史/反馈一致（rounds/history deep-equal）', async () => {
  const { engine, host } = await dualRun(mini, {
    '/^dispatch( R\\d+)?$/': { complete: true },
    '/^work( R\\d+)?$/': { status: 'blocked' },
  })
  assert.equal(host.result.status, engine.result.status) // FAILED_MAX_ROUNDS
  assert.equal(host.result.rounds, engine.result.rounds)
  assert.deepEqual(host.result.history, engine.result.history)
  const hDev = host.agentCalls.find((c) => c.label === 'dispatch R1')
  const eDev = engine.agentCalls.find((c) => c.label === 'dispatch R1')
  for (const p of [hDev.prompt, eDev.prompt]) {
    assert.ok(p.includes('work未通过 · 第 1 轮') && p.includes('【上轮打回反馈——必须逐条修复】'), '打回反馈注入一致')
  }
})

test('C1 对拍-人工门禁：AWAITING_HUMAN_<id> + resume 载荷一致', async () => {
  const { engine, host } = await dualRun(mini, {
    dispatch: { complete: true }, work: { status: 'completed' }, gate: { verdict: 'ok' },
  })
  assert.equal(host.result.status, 'AWAITING_HUMAN_gate')
  assert.deepEqual(common(host.result), common(engine.result))
})

test('C1 对拍-死胡同兜底：ENDED_NO_FAILURE_EDGE 一致', async () => {
  const deadBp = {
    id: 'dead-test', displayName: '死胡同测试', entry: 's',
    bindings: { models: { s: { provider: 'p', model: 'm' } } },
    nodes: [{ id: 's', profile: 'dispatcher', goal: 'x',
      output: { schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }, successCondition: '$.ok == true' } }],
    edges: [{ from: 's', to: '$end', on: 'success' }],
  }
  const { engine, host } = await dualRun(deadBp, { s: { ok: false } })
  assert.equal(engine.result.status, 'ENDED_NO_FAILURE_EDGE')
  assert.equal(host.result.status, 'ENDED_NO_FAILURE_EDGE')
})

// ---------- C2 · 已知差异显式断言（内置蓝图，模板级特性触发） ----------
const VERIFIED = { verified_branch: 'dev2/task', verified_head: 'abc123' }
const HAPPY = {
  调度: { complete: true, missing: [], need_integration_test: true, reason: 'ok' },
  分流: { need_integration_test: true, reason: 'ok' }, // 仅宿主需要（引擎折叠）
  开发: { status: 'completed', summary: 's', self_verify: 'v' },
  测试: { result: 'PASSED', reason: 'r', evidence: 'e', ...VERIFIED },
  审核: { verdict: 'APPROVE', summary: 's', ...VERIFIED },
  人工验收: { verdict: 'PASS', summary_for_human: 's', details: 'd', ...VERIFIED },
  收口: { status: 'done', summary: 's' },
}

test('C2 差异-分流折叠：引擎分流零出场，宿主分流是 LLM 出场（D3 有意差异）', async () => {
  const { engine, host } = await dualRun(tpl, HAPPY)
  assert.equal(engine.result.status, 'AWAITING_HUMAN_accept')
  assert.equal(host.result.status, 'AWAITING_HUMAN_accept')
  assert.ok(!engine.agentCalls.some((c) => c.label === '分流'), '引擎侧折叠：分流零出场')
  assert.ok(host.agentCalls.some((c) => c.label === '分流'), '宿主侧分流是演员出场（一次 LLM 转发）')
})

test('C2 差异-可信度闸门：引擎交错分支即 TECHNICAL_FAILURE，宿主继续放行', async () => {
  const table = {
    ...HAPPY,
    测试: { result: 'PASSED', reason: 'r', evidence: 'e', verified_branch: 'main', verified_head: '' },
  }
  const { engine, host } = await dualRun(tpl, table)
  assert.equal(engine.result.status, 'TECHNICAL_FAILURE', '引擎侧闸门硬校验')
  assert.notEqual(host.result.status, 'TECHNICAL_FAILURE', '宿主侧无闸门（v1 忽略），流程继续')
  assert.equal(host.result.status, 'AWAITING_HUMAN_accept')
})

test('C2 差异-超限归因：引擎超限有归因演员与 reschedule，宿主没有', async () => {
  const table = {
    调度: { complete: true, missing: [], need_integration_test: true, reason: 'ok' },
    '/^分流( R\\d+)?$/': { need_integration_test: true, reason: 'ok' },
    '/^开发( R\\d+)?$/': { status: 'completed', summary: 's', self_verify: 'v' },
    '/^测试( R\\d+)?$/': { result: 'PASSED', reason: 'r', evidence: 'e', ...VERIFIED },
    '/^审核( R\\d+)?$/': { verdict: 'REQUEST_CHANGES', summary: '要改', ...VERIFIED },
    超限归因: { reason: '卡在审核', reschedule: { attribution: '审核过严', split: ['x'], human_action: '放宽' } },
  }
  const { engine, host } = await dualRun(tpl, table)
  assert.equal(engine.result.status, 'FAILED_MAX_ROUNDS')
  assert.equal(host.result.status, 'FAILED_MAX_ROUNDS')
  assert.equal(engine.result.reschedule.attribution, '审核过严', '引擎侧有归因载荷')
  assert.equal(engine.agentCalls.filter((c) => c.label === '超限归因').length, 1)
  assert.equal(host.result.reschedule, undefined, '宿主侧无归因载荷')
  assert.ok(!host.agentCalls.some((c) => c.label === '超限归因'), '宿主侧归因演员零出场')
})
