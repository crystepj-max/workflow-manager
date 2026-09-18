// LOC-036（WR-010）：探索覆盖度与定向补充规则
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createRequire } from 'module'
import { compileBlueprint } from '../generate.mjs'
import { runGeneratedScript, makeAgentScript } from './helpers/runtime-harness.mjs'
import validatorCore from '../validate-core.cjs'

const require = createRequire(import.meta.url)
const ec = require('../explore-coverage.cjs')
const { validateBlueprint } = validatorCore
const here = path.dirname(fileURLToPath(import.meta.url))
const exploreBp = JSON.parse(readFileSync(path.join(here, '../../templates/wf-explore.json'), 'utf8'))

const runEngine = (table, args = {}) => {
  const { script } = compileBlueprint(exploreBp)
  const agent = makeAgentScript(table)
  return runGeneratedScript(script, { args, agent })
}

const questions = (ids) => ids.map((id) => ({ id, required: true, text: '问题 ' + id }))
const brief = (id, qids, extra = {}) => ({
  expert_id: id,
  focus: '视角 ' + id,
  brief: '取证 ' + id,
  question_ids: qids,
  ...extra,
})
const plan = (n, roundType = 'BROAD', extra = {}) => ({
  route: 'PLAN_READY',
  round_type: roundType,
  research_question: '核心问题',
  questions: questions(['q1', 'q2', 'q3'].slice(0, Math.max(n, 3))),
  expert_briefs: Array.from({ length: n }, (_, i) => brief('expert-' + (i + 1), ['q' + ((i % 3) + 1)])),
  plan_summary: '方案',
  ...extra,
})
const researchItem = (id) => ({
  expert_id: id,
  findings: '发现',
  evidence: ['证据'],
  counter_evidence: ['反证'],
  assumptions: ['假设'],
  uncertainties: ['未知'],
  confidence: 'medium',
})
const coverageRow = (qid, status = 'answered') => ({
  question_id: qid,
  status,
  evidence_refs: status === 'answered' ? ['research-' + qid] : ['note-' + qid],
  reason: status,
})
const synthesis = (overrides = {}) => ({
  route: 'SYNTHESIS_READY',
  consensus: ['共识'],
  disagreements: ['分歧'],
  evidence_map: '地图',
  coverage: [
    coverageRow('q1'),
    coverageRow('q2'),
    coverageRow('q3'),
  ],
  source_overlaps: [],
  research_failures: [],
  open_gaps: [],
  synthesis_summary: '摘要',
  ...overrides,
})
const evalVerdict = (verdict, extra = {}) => ({
  verdict,
  why: '原因',
  summary_for_human: '摘要',
  current_state: '现状',
  ...extra,
})

test('LOC-036 蓝图校验：maxRoundsExhausted=INSUFFICIENT；裁决一致性由运行时 explore 校验承担', () => {
  const v = validateBlueprint(exploreBp)
  assert.equal(v.ok, true, JSON.stringify(v.errors))
  assert.equal(exploreBp.control.maxRoundsExhausted, 'INSUFFICIENT')
  const ev = exploreBp.nodes.find((n) => n.id === 'evaluate')
  assert.equal(ev.output.consistency, undefined)
})

test('LOC-036 内核：合法 3/5 人计划通过；0/2/6 人为边界', () => {
  for (const n of [3, 5]) {
    const ok = ec.validateExplorePlan(plan(n))
    assert.equal(ok.ok, true, 'n=' + n)
  }
  for (const n of [0, 2, 6]) {
    const bad = ec.validateExplorePlan(plan(n))
    assert.equal(bad.ok, false)
    assert.equal(bad.kind, 'boundary')
    assert.equal(bad.code, 'PLAN_COUNT_BOUNDARY')
  }
})

test('LOC-036 内核：重复 ID、空 brief、完全相同任务直接拒绝', () => {
  const dup = plan(3)
  dup.expert_briefs[1].expert_id = dup.expert_briefs[0].expert_id
  assert.equal(ec.validateExplorePlan(dup).code, 'DUPLICATE_expert_id')

  const empty = plan(3)
  empty.expert_briefs[0].brief = '   '
  assert.equal(ec.validateExplorePlan(empty).code, 'BRIEF_EMPTY')

  const same = plan(3)
  same.expert_briefs[1].focus = same.expert_briefs[0].focus
  same.expert_briefs[1].brief = same.expert_briefs[0].brief
  assert.equal(ec.validateExplorePlan(same).code, 'IDENTICAL_TASK')
})

test('AC-01 UAT-01：人数 0/2/6 暂停人工决策卡，未启动专家', async () => {
  for (const n of [0, 2, 6]) {
    const { result, agentCalls } = await runEngine({ 探索统筹: plan(n) }, { taskId: 'loc036-boundary-' + n })
    assert.equal(result.status, 'WAITING_HUMAN')
    assert.equal(result.reason, 'EXPLORE_PLAN_COUNT_BOUNDARY')
    assert.ok(result.decision_package.options.some((o) => o.id === 'APPROVE_EXCEPTION'))
    assert.ok(!agentCalls.some((c) => /^专家研究 #/.test(c.label)), 'n=' + n + ' 不得启动专家')
  }
})

test('AC-01：质量违规拒绝；合法 3 人进入研究', async () => {
  const bad = plan(3)
  bad.expert_briefs[0].brief = ''
  const rejected = await runEngine({ 探索统筹: bad })
  assert.equal(rejected.result.status, 'TECHNICAL_FAILURE')
  assert.equal(rejected.result.reason, 'EXPLORE_PLAN_REJECTED')
  assert.ok(!rejected.agentCalls.some((c) => /^专家研究 #/.test(c.label)))

  const good = await runEngine({
    探索统筹: plan(3),
    '/^专家研究 #/': (label) => researchItem('expert-' + label.slice(-1)),
    综合分析: () => synthesis(),
    结论评估: evalVerdict('PASS', { completion_type: 'EVALUATION_PASSED' }),
  })
  assert.equal(good.result.status, 'DONE')
  assert.equal(good.agentCalls.filter((c) => /^专家研究 #/.test(c.label)).length, 3)
})

test('AC-01：人数例外批准后启动专家', async () => {
  const halt = await runEngine({ 探索统筹: plan(2) }, { taskId: 'loc036-approve' })
  assert.equal(halt.result.status, 'WAITING_HUMAN')
  assert.ok(halt.result.results.orchestrate, '边界暂停应保留已提交计划')
  const resumed = await runEngine({
    '/^专家研究 #/': (label) => researchItem('expert-' + label.slice(-1)),
    综合分析: () => synthesis(),
    结论评估: evalVerdict('PASS', { completion_type: 'EVALUATION_PASSED' }),
  }, {
    taskId: 'loc036-approve',
    entry: 'research',
    explore_plan_approved: true,
    results: halt.result.results,
  })
  assert.equal(resumed.result.status, 'DONE')
  assert.equal(resumed.agentCalls.filter((c) => /^专家研究 #/.test(c.label)).length, 2)
})

test('AC-02 UAT-02：单缺口仅 1 名 TARGETED 专家；空 research_targets 拒绝 NEEDS_RESEARCH', async () => {
  const targeted = plan(1, 'TARGETED')
  targeted.questions = questions(['gap-1'])
  targeted.expert_briefs = [brief('gap-expert', ['gap-1'], { research_targets: ['gap-1'] })]
  const ok = await runEngine({
    探索统筹: targeted,
    '/^专家研究 #/': () => researchItem('gap-expert'),
    综合分析: () => synthesis({ coverage: [coverageRow('gap-1')], open_gaps: [] }),
    结论评估: evalVerdict('PASS', { completion_type: 'EVALUATION_PASSED' }),
  }, { taskId: 'loc036-targeted-1' })
  assert.equal(ok.result.status, 'DONE')
  assert.equal(ok.agentCalls.filter((c) => /^专家研究 #/.test(c.label)).length, 1)

  const emptyTargets = await runEngine({
    探索统筹: plan(3),
    '/^专家研究 #/': (label) => researchItem('expert-' + label.slice(-1)),
    综合分析: () => synthesis({ open_gaps: ['q1'] }),
    结论评估: evalVerdict('NEEDS_RESEARCH', { research_targets: [] }),
  })
  assert.equal(emptyTargets.result.status, 'TECHNICAL_FAILURE')
  assert.equal(emptyTargets.result.reason, 'EXPLORE_EVAL_REJECTED')
})

test('AC-03 UAT-03：部分失败可见；必需未覆盖禁止 PASS；全失败无伪成功', async () => {
  const partial = await runEngine({
    探索统筹: plan(3),
    '/^专家研究 #/': (label) => (label === '专家研究 #2' ? { bad: 'fail' } : researchItem('expert-' + label.slice(-1))),
    综合分析: () => synthesis({
      coverage: [coverageRow('q1'), { question_id: 'q2', status: 'uncovered', evidence_refs: [], reason: '专家失败' }, coverageRow('q3')],
      research_failures: [{ index: 2, expert_id: 'expert-2', reason: 'agent 失败' }],
      open_gaps: ['q2'],
    }),
    结论评估: evalVerdict('PASS', { completion_type: 'EVALUATION_PASSED' }),
  })
  assert.equal(partial.result.status, 'TECHNICAL_FAILURE')
  assert.equal(partial.result.reason, 'EXPLORE_SYNTHESIS_REJECTED')

  const allFail = await runEngine({
    探索统筹: plan(3),
    '/^专家研究 #/': { bad: 'all fail' },
    综合分析: () => synthesis(),
    结论评估: evalVerdict('PASS', { completion_type: 'EVALUATION_PASSED' }),
  })
  assert.equal(allFail.result.status, 'FAILED_AT_research')
})

test('AC-04 UAT-04：两次补充耗尽 → INSUFFICIENT，保留原 NEEDS_RESEARCH', async () => {
  let orch = 0
  const targetedPlan = () => {
    const p = plan(1, 'TARGETED')
    p.expert_briefs = [brief('gap-expert', ['q2'], { research_targets: ['q2'] })]
    return p
  }
  const table = {
    探索统筹: () => { orch += 1; return orch === 1 ? plan(3, 'BROAD') : targetedPlan() },
    '/^专家研究 #/': (label) => researchItem('expert-' + label.replace(/.*#/, '')),
    综合分析: () => synthesis({ open_gaps: ['q2'] }),
    结论评估: () => evalVerdict('NEEDS_RESEARCH', { research_targets: ['q2'] }),
  }
  const { result } = await runEngine(table, { taskId: 'loc036-exhaust' })
  assert.equal(result.status, 'DONE')
  assert.equal(result.completion && result.completion.type, 'INSUFFICIENT')
  assert.equal(result.results.evaluate.verdict, 'NEEDS_RESEARCH')
  assert.equal(result.results.explore_budget_exhausted.effective_verdict, 'INSUFFICIENT')
  assert.equal(result.results.explore_budget_exhausted.budget_exhausted, true)
  assert.ok(Array.isArray(result.results.explore_budget_exhausted.unresolved_gaps))
  assert.equal(result.budgetUsed, 2)
})
