// LOC-012 诊断缺陷修复正式模板（templates/wf-diagnose.json）行为测试
// 剧本驱动真实蓝图：正常 / 修复问题回修复 / 根因被推翻回诊断 / 额度耗尽 / 回归失败 / 诊断受阻
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
const diagnoseBp = JSON.parse(readFileSync(path.join(here, '../../templates/wf-diagnose.json'), 'utf8'))
// LOC-026：审核/回归验证声明 verifyBranch 后，结论必须通过可信度闸门（无 workspace 形态仍校验 verified_branch/verified_head；schema required 含 candidate_sha256）
const DIAG_VERIFY = { verified_branch: 'dev2/task', verified_head: 'diag-head', candidate_sha256: 'diag-candidate' }

const runEngine = (bp, table, args = {}) => {
  const { script } = compileBlueprint(bp)
  const agent = makeAgentScript(table)
  return runGeneratedScript(script, { args, agent })
}

test('LOC-012 diagnose 蓝图通过校验：maxRounds=3、双回退边耗额度、默认无人工验收节点', () => {
  const v = validateBlueprint(diagnoseBp)
  assert.equal(v.ok, true, JSON.stringify(v.errors))
  assert.equal(diagnoseBp.control.maxRounds, 3)
  const fixEdge = diagnoseBp.edges.find((e) => e.from === 'review' && e.outcome === 'FIX_ISSUES')
  assert.equal(fixEdge.to, 'fix')
  assert.equal(fixEdge.countRound, true, '修复问题 → 修复 须消耗额度')
  const refuteEdge = diagnoseBp.edges.find((e) => e.from === 'review' && e.outcome === 'ROOT_CAUSE_REFUTED')
  assert.equal(refuteEdge.to, 'diagnose')
  assert.equal(refuteEdge.countRound, true, '证据推翻根因 → 诊断 须消耗额度')
  assert.ok(!diagnoseBp.edges.some((e) => e.to === '$human-decision' || e.from === '$human-decision'), '默认无独立人工验收')
  // 原始 feedback signal 贯穿：诊断/修复/回归 goal 均须引用 feedback signal
  for (const id of ['diagnose', 'fix', 'regression']) {
    const n = diagnoseBp.nodes.find((x) => x.id === id)
    assert.ok(/feedback signal/.test(n.goal), `${id} goal 须贯穿 feedback signal`)
  }
})

test('正常路径：诊断 → 修复 → 审核 → 回归 → 收口，不耗额度', async () => {
  const { result } = await runEngine(diagnoseBp, {
    缺陷诊断: { route: 'DIAGNOSED', root_cause: '空指针', evidence: '复现栈', verified_head: 'h1' },
    修复: { route: 'FIXED', summary: '补判空', changed: 'a.js' },
    审核: { route: 'APPROVE', verdict_reason: '修改与根因对应', ...DIAG_VERIFY },
    回归验证: { route: 'PASS', verdict_reason: '缺陷不复现', regression_evidence: '测试绿', ...DIAG_VERIFY },
    收口: { status: 'DELIVERED', summary: 'done', followups: '' },
  })
  assert.equal(result.status, 'DONE')
  assert.equal(result.budgetUsed, 0)
})

test('修复问题回修复：消耗 1 点额度后通过', async () => {
  let reviews = 0
  const { result } = await runEngine(diagnoseBp, {
    缺陷诊断: { route: 'DIAGNOSED', root_cause: '空指针', evidence: '复现栈', verified_head: 'h1' },
    修复: { route: 'FIXED', summary: '补判空', changed: 'a.js' },
    审核: () => {
      reviews += 1
      if (reviews === 1) return { route: 'FIX_ISSUES', verdict_reason: '未覆盖边界', ...DIAG_VERIFY }
      return { route: 'APPROVE', verdict_reason: '通过', ...DIAG_VERIFY }
    },
    回归验证: { route: 'PASS', verdict_reason: '缺陷不复现', regression_evidence: '测试绿', ...DIAG_VERIFY },
    收口: { status: 'DELIVERED', summary: 'done', followups: '' },
  })
  assert.equal(result.status, 'DONE')
  assert.equal(result.budgetUsed, 1)
  assert.ok(result.history.some((h) => h.outcome === 'FIX_ISSUES' && h.countRound === true && !h.halted))
})

test('证据推翻根因回诊断：消耗 1 点额度后通过', async () => {
  let reviews = 0
  const { result } = await runEngine(diagnoseBp, {
    缺陷诊断: { route: 'DIAGNOSED', root_cause: '初始根因', evidence: 'e0', verified_head: 'h1' },
    审核: () => {
      reviews += 1
      if (reviews === 1) return { route: 'ROOT_CAUSE_REFUTED', verdict_reason: '证据不支持根因', ...DIAG_VERIFY }
      return { route: 'APPROVE', verdict_reason: '通过', ...DIAG_VERIFY }
    },
    修复: { route: 'FIXED', summary: '按新根因修复', changed: 'b.js' },
    回归验证: { route: 'PASS', verdict_reason: '缺陷不复现', regression_evidence: '测试绿', ...DIAG_VERIFY },
    收口: { status: 'DELIVERED', summary: 'done', followups: '' },
  })
  assert.equal(result.status, 'DONE')
  assert.equal(result.budgetUsed, 1)
  const recs = result.history.filter((h) => h.outcome === 'ROOT_CAUSE_REFUTED')
  assert.equal(recs.length, 1)
  assert.ok(recs.every((h) => h.countRound === true && !h.halted))
})

test('额度耗尽：WAITING_HUMAN + MAX_ROUNDS_REACHED，审核原结果保留', async () => {
  const { result } = await runEngine(diagnoseBp, {
    缺陷诊断: { route: 'DIAGNOSED', root_cause: '空指针', evidence: '复现栈', verified_head: 'h1' },
    修复: { route: 'FIXED', summary: '补判空', changed: 'a.js' },
    审核: { route: 'FIX_ISSUES', verdict_reason: '未覆盖边界', ...DIAG_VERIFY },
  })
  assert.equal(result.status, 'WAITING_HUMAN')
  assert.equal(result.reason, 'MAX_ROUNDS_REACHED')
  assert.equal(result.results.review.route, 'FIX_ISSUES', '审核节点原结果须原样保留')
  assert.equal(result.budgetUsed, 3)
  assert.equal(result.blocked_edge && result.blocked_edge.to, 'fix')
  assert.equal(result.blocked_edge && result.blocked_edge.countRound, true)
})

test('回归失败退修复：消耗 1 点额度，修改后重新审核并回归', async () => {
  let regressions = 0
  let fixCount = 0
  let reviewCount = 0
  const { result } = await runEngine(diagnoseBp, {
    缺陷诊断: { route: 'DIAGNOSED', root_cause: '空指针', evidence: '复现栈', verified_head: 'h1' },
    修复: () => {
      fixCount += 1
      return { route: 'FIXED', summary: `第 ${fixCount} 次修复`, changed: 'a.js' }
    },
    审核: () => {
      reviewCount += 1
      return { route: 'APPROVE', verdict_reason: '通过', ...DIAG_VERIFY }
    },
    回归验证: () => {
      regressions += 1
      if (regressions === 1) return { route: 'FIX_ISSUES', verdict_reason: '引入新问题', regression_evidence: '回归红', ...DIAG_VERIFY }
      return { route: 'PASS', verdict_reason: '缺陷不复现', regression_evidence: '测试绿', ...DIAG_VERIFY }
    },
    收口: { status: 'DELIVERED', summary: 'done', followups: '' },
  })
  assert.equal(result.status, 'DONE')
  assert.equal(result.budgetUsed, 1)
  assert.equal(fixCount, 2, '修改后必须重新走修复 → 审核 → 回归')
  assert.equal(reviewCount, 2)
  assert.equal(regressions, 2)
})

test('诊断受阻：证据不足直接结束，不猜根因不进入修复', async () => {
  const { result } = await runEngine(diagnoseBp, {
    缺陷诊断: { route: 'BLOCKED', root_cause: '证据不足，无法复现', evidence: '两次复现尝试均失败', verified_head: 'h1' },
  })
  assert.equal(result.status, 'DONE')
  assert.ok(!result.results.fix, '不得进入修复节点')
})

test('workspace 策略：diagnose 默认 ISOLATED_WRITE 且 freeze_from=diagnose（同一 lineage 兜底）', async () => {
  const { resolveWorkspacePolicy, WORKSPACE_MODE } = await import('../workspace-isolation.mjs')
  const policy = resolveWorkspacePolicy('wf-diagnose', {})
  assert.equal(policy.mode, WORKSPACE_MODE.ISOLATED_WRITE)
  assert.equal(policy.freeze_from, 'diagnose')
  const n = diagnoseBp.nodes.find((x) => x.id === 'diagnose')
  assert.ok(n.output.schema.required.includes('verified_head'), '诊断节点须锚定 verified_head')
})
