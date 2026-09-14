// LOC-011 优化快速迭代正式模板（templates/wf-optimize.json）行为测试
// 剧本驱动真实蓝图（非 mini 夹具）：正常 / OPTIMIZE 回退 / 额度耗尽 / RECONFIRM / CONFIRM 升人工 / BLOCKED
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { compileBlueprint } from '../generate.mjs'
import { runGeneratedScript, makeAgentScript } from './helpers/runtime-harness.mjs'
import validatorCore from '../validate-core.cjs'

const { validateBlueprint } = validatorCore
const here = path.dirname(fileURLToPath(import.meta.url))
const optimizeBp = JSON.parse(readFileSync(path.join(here, '../../templates/wf-optimize.json'), 'utf8'))

const runEngine = (bp, table, args = {}) => {
  const { script } = compileBlueprint(bp)
  const agent = makeAgentScript(table)
  return runGeneratedScript(script, { args, agent })
}

test('LOC-011 optimize 蓝图通过校验且为全量新语义', () => {
  const v = validateBlueprint(optimizeBp)
  assert.equal(v.ok, true, JSON.stringify(v.errors))
  assert.equal(optimizeBp.control.maxRounds, 3)
  for (const n of optimizeBp.nodes) {
    assert.ok(n.output?.outcomePath, `节点 ${n.id} 须为 outcomePath 新模式`)
  }
  const optimizeEdge = optimizeBp.edges.find((e) => e.outcome === 'OPTIMIZE')
  assert.equal(optimizeEdge.to, 'execute')
  assert.equal(optimizeEdge.countRound, true, 'OPTIMIZE → 执行 须消耗额度')
  const reconfirmEdge = optimizeBp.edges.find((e) => e.outcome === 'RECONFIRM_REQUIRED')
  assert.equal(reconfirmEdge.to, 'confirm')
  assert.notEqual(reconfirmEdge.countRound, true, 'RECONFIRM_REQUIRED → 目标确认 不消耗额度')
})

test('正常路径：PASS → 收口 EVALUATION_PASSED，不耗额度', async () => {
  const { result } = await runEngine(optimizeBp, {
    目标确认: { route: 'READY', summary: '契约冻结', contract_digest: 'c1' },
    执行: { route: 'READY', summary: '最小修改', changed: 'a.md' },
    评估: { route: 'PASS', summary: '满足判据', contract_digest: 'c1', gaps: '' },
    收口: { status: 'DELIVERED', completion_type: 'EVALUATION_PASSED', summary: 'done', followups: '' },
  })
  assert.equal(result.status, 'DONE')
  assert.equal(result.budgetUsed, 0)
  assert.equal(result.completion && result.completion.type, 'EVALUATION_PASSED')
})

test('OPTIMIZE → 执行消耗 1 点额度，随后 PASS 收口', async () => {
  let evals = 0
  const { result } = await runEngine(optimizeBp, {
    目标确认: { route: 'READY', summary: '契约冻结', contract_digest: 'c1' },
    执行: { route: 'READY', summary: '最小修改', changed: 'a.md' },
    评估: () => {
      evals += 1
      if (evals === 1) return { route: 'OPTIMIZE', summary: '判据未满足', contract_digest: 'c1', gaps: 'g1' }
      return { route: 'PASS', summary: '满足判据', contract_digest: 'c1', gaps: '' }
    },
    收口: { status: 'DELIVERED', completion_type: 'EVALUATION_PASSED', summary: 'done', followups: '' },
  })
  assert.equal(result.status, 'DONE')
  assert.equal(evals, 2)
  assert.equal(result.budgetUsed, 1)
  assert.ok(result.history.some((h) => h.outcome === 'OPTIMIZE' && h.countRound === true && !h.halted))
})

test('额度耗尽：WAITING_HUMAN + MAX_ROUNDS_REACHED，评估原结果不被改写', async () => {
  const { result } = await runEngine(optimizeBp, {
    目标确认: { route: 'READY', summary: '契约冻结', contract_digest: 'c1' },
    执行: { route: 'READY', summary: '最小修改', changed: 'a.md' },
    评估: { route: 'OPTIMIZE', summary: '判据未满足', contract_digest: 'c1', gaps: 'g1' },
  })
  assert.equal(result.status, 'WAITING_HUMAN')
  assert.equal(result.reason, 'MAX_ROUNDS_REACHED')
  assert.equal(result.results.evaluate.route, 'OPTIMIZE', '评估节点原结果须原样保留')
  assert.equal(result.budgetUsed, 3)
  assert.equal(result.blocked_edge && result.blocked_edge.to, 'execute')
  assert.equal(result.blocked_edge && result.blocked_edge.countRound, true)
})

test('RECONFIRM_REQUIRED 回目标确认：不消耗额度且 history 记录', async () => {
  let execs = 0
  const { result } = await runEngine(optimizeBp, {
    目标确认: { route: 'READY', summary: '契约冻结', contract_digest: 'c1' },
    执行: () => {
      execs += 1
      if (execs === 1) return { route: 'RECONFIRM_REQUIRED', summary: '契约已不可执行', changed: '' }
      return { route: 'READY', summary: '最小修改', changed: 'a.md' }
    },
    评估: { route: 'PASS', summary: '满足判据', contract_digest: 'c1', gaps: '' },
    收口: { status: 'DELIVERED', completion_type: 'EVALUATION_PASSED', summary: 'done', followups: '' },
  })
  assert.equal(result.status, 'DONE')
  assert.equal(result.budgetUsed, 0)
  const recs = result.history.filter((h) => h.outcome === 'RECONFIRM_REQUIRED')
  assert.equal(recs.length, 1)
  assert.ok(recs.every((h) => h.countRound === false && !h.halted))
})

test('CONFIRM 升人工决策（含冻结契约摘要材料），ACCEPT 续跑后 USER_ACCEPTED 收口', async () => {
  const halt = await runEngine(optimizeBp, {
    目标确认: { route: 'READY', summary: '契约冻结', contract_digest: 'c1' },
    执行: { route: 'READY', summary: '最小修改', changed: 'a.md' },
    评估: { route: 'CONFIRM', summary: '无法自动判定', contract_digest: 'c1', gaps: '' },
  })
  assert.equal(halt.result.status, 'WAITING_HUMAN')
  assert.equal(halt.result.reason, 'ESCALATED_DECISION')
  assert.equal(halt.result.node, 'evaluate')
  assert.ok(typeof halt.result.decision_id === 'string' && halt.result.decision_id.length > 0)
  // 决策材料包含冻结契约摘要（触发节点结果里的 contract_digest 不得被改写）
  assert.equal(halt.result.results.evaluate.contract_digest, 'c1')
  for (const key of ['why', 'current_state', 'options', 'subsequent_effects']) {
    assert.ok(halt.result.decision_package && halt.result.decision_package[key], `Package 缺 ${key}`)
  }
  const resume = await runEngine(optimizeBp, {
    收口: { status: 'DELIVERED', completion_type: 'USER_ACCEPTED', summary: 'done', followups: '' },
  }, {
    decision_id: halt.result.decision_id,
    user_choice: 'ACCEPT',
    results: halt.result.results,
  })
  assert.equal(resume.result.status, 'DONE')
  assert.equal(resume.result.completion && resume.result.completion.type, 'USER_ACCEPTED')
})

test('目标确认 BLOCKED：直达结束，不进入执行', async () => {
  const { result } = await runEngine(optimizeBp, {
    目标确认: { route: 'BLOCKED', summary: '目标不可验证', contract_digest: '' },
  })
  assert.equal(result.status, 'DONE')
  assert.equal(result.completion ?? null, null)
  assert.ok(!result.results.execute, '不得进入执行节点')
})

test('workspace 策略：Git 代码修改 → ISOLATED_WRITE；非 Git 文档/配置 → SANDBOX', async () => {
  const { resolveWorkspacePolicy, WORKSPACE_MODE } = await import('../workspace-isolation.mjs')
  const gitPolicy = resolveWorkspacePolicy('wf-optimize', { resource_kind: 'git' })
  assert.equal(gitPolicy.mode, WORKSPACE_MODE.ISOLATED_WRITE)
  const docPolicy = resolveWorkspacePolicy('wf-optimize', { resource_kind: 'document' })
  assert.equal(docPolicy.mode, WORKSPACE_MODE.SANDBOX)
  const configPolicy = resolveWorkspacePolicy('wf-optimize', { resource_kind: 'config' })
  assert.equal(configPolicy.mode, WORKSPACE_MODE.SANDBOX)
  assert.throws(() => resolveWorkspacePolicy('wf-optimize', {}), /resource_kind/, '缺 resource_kind 须拒绝（fail closed）')
})
