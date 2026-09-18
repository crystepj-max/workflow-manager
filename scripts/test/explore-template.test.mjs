import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { compileBlueprint } from '../generate.mjs'
import { runGeneratedScript, makeAgentScript } from './helpers/runtime-harness.mjs'
import { readWorkerFile, writeWorkerFile } from '../workspace-isolation.mjs'
import {
  createStore, appendRecord, toRef, dependsOnStaleInputs, coverageStatus, staleProofsFor,
  COVERING, NOT_COVERING_CURRENT, KIND, MEDIA,
} from '../formal-records.mjs'
import validatorCore from '../validate-core.cjs'

const { validateBlueprint } = validatorCore
const here = path.dirname(fileURLToPath(import.meta.url))
const exploreBp = JSON.parse(readFileSync(path.join(here, '../../templates/wf-explore.json'), 'utf8'))

const runEngine = (bp, table, args = {}) => {
  const { script } = compileBlueprint(bp)
  const agent = makeAgentScript(table)
  return runGeneratedScript(script, { args, agent })
}

const briefs = (n) => Array.from({ length: n }, (_, i) => ({
  expert_id: 'expert-' + (i + 1),
  focus: '视角 ' + (i + 1),
  brief: '取证要求 ' + (i + 1),
  question_ids: ['q' + ((i % 3) + 1)],
}))
const plan = (n, roundType) => ({
  route: 'PLAN_READY',
  round_type: roundType || 'BROAD',
  research_question: 'Q',
  questions: [
    { id: 'q1', required: true, text: '问题1' },
    { id: 'q2', required: true, text: '问题2' },
    { id: 'q3', required: true, text: '问题3' },
  ],
  expert_briefs: briefs(n),
  plan_summary: '方案',
})
const researchItem = (i) => ({
  expert_id: 'expert-' + i,
  findings: '发现 ' + i,
  evidence: ['证据'],
  counter_evidence: ['反证'],
  assumptions: ['假设'],
  uncertainties: ['未知'],
  confidence: 'medium',
})
const synthesis = {
  route: 'SYNTHESIS_READY',
  consensus: ['共识'],
  disagreements: ['分歧'],
  evidence_map: '证据地图',
  coverage: [
    { question_id: 'q1', status: 'answered', evidence_refs: ['r1'], reason: '已回答' },
    { question_id: 'q2', status: 'answered', evidence_refs: ['r2'], reason: '已回答' },
    { question_id: 'q3', status: 'answered', evidence_refs: ['r3'], reason: '已回答' },
  ],
  source_overlaps: [],
  research_failures: [],
  open_gaps: ['q2'],
  synthesis_summary: '综合摘要',
}
const evalVerdict = (verdict, extra = {}) => ({
  verdict,
  why: '原因：' + verdict,
  summary_for_human: '摘要：' + verdict,
  current_state: '现状',
  ...extra,
})

test('LOC-013 蓝图通过内核校验，轮次预算按锁定口径声明', () => {
  const v = validateBlueprint(exploreBp)
  assert.equal(v.ok, true, JSON.stringify(v.errors))
  assert.equal(exploreBp.control.maxRounds, 2)
  const nr = exploreBp.edges.find((e) => e.outcome === 'NEEDS_RESEARCH')
  assert.equal(nr && nr.countRound, true)
  assert.equal(nr.to, 'orchestrate')
  assert.equal(exploreBp.workspace && exploreBp.workspace.template_id, 'wf-explore')
})

test('LOC-013 正常路径：统筹→专家 fanout→综合→PASS，完成类型 EVALUATION_PASSED', async () => {
  const { result, agentCalls } = await runEngine(exploreBp, {
    探索统筹: plan(3),
    '/^专家研究 #/': (label) => researchItem(Number(label.slice(-1))),
    综合分析: synthesis,
    结论评估: evalVerdict('PASS', { completion_type: 'EVALUATION_PASSED' }),
  })
  assert.equal(result.status, 'DONE')
  assert.equal(result.completion && result.completion.type, 'EVALUATION_PASSED')
  assert.equal(result.completion && result.completion.node, 'evaluate')
  // fanout 聚合包装：{ total, okCount, failedCount, items }
  const agg = result.results.research
  assert.equal(agg.total, 3)
  assert.equal(agg.okCount, 3)
  assert.equal(agg.failedCount, 0)
  assert.equal(agg.items.length, 3)
  assert.equal(agg.items[0].expert_id, 'expert-1')
  // 业务结果不被改写：evaluate 原样保留
  assert.equal(result.results.evaluate.verdict, 'PASS')
  assert.equal(result.budgetUsed, 0)
  assert.ok(agentCalls.some((c) => c.label === '专家研究 #3'))
})

test('LOC-013 NEEDS_RESEARCH 自动回退 2 次后 PASS（初次 BROAD 不计额度）', async () => {
  let evals = 0
  let orchestras = 0
  const targetedPlan = () => {
    const p = plan(1, 'TARGETED')
    p.expert_briefs = [{ expert_id: 'gap-expert', focus: '缺口', brief: '补 q2', question_ids: ['q2'], research_targets: ['q2'] }]
    return p
  }
  const { result } = await runEngine(exploreBp, {
    探索统筹: () => { orchestras += 1; return orchestras === 1 ? plan(3, 'BROAD') : targetedPlan() },
    '/^专家研究 #/': (label) => researchItem(Number(label.slice(-1))),
    综合分析: synthesis,
    结论评估: () => {
      evals += 1
      if (evals < 3) return evalVerdict('NEEDS_RESEARCH', { research_targets: ['q2'] })
      return evalVerdict('PASS', { completion_type: 'EVALUATION_PASSED' })
    },
  })
  assert.equal(result.status, 'DONE')
  assert.equal(evals, 3)
  assert.equal(orchestras, 3)
  assert.equal(result.budgetUsed, 2)
  const nrHistory = result.history.filter((h) => h.outcome === 'NEEDS_RESEARCH')
  assert.equal(nrHistory.length, 2)
  assert.ok(nrHistory.every((h) => h.countRound === true && !h.halted))
})

test('LOC-036 第 3 轮仍 NEEDS_RESEARCH：保留原裁决，DONE + INSUFFICIENT（额度耗尽收口）', async () => {
  const table = {
    探索统筹: plan(3),
    '/^专家研究 #/': (label) => researchItem(Number(label.slice(-1))),
    综合分析: synthesis,
    结论评估: () => evalVerdict('NEEDS_RESEARCH', { research_targets: ['q2'] }),
  }
  const done = await runEngine(exploreBp, table, { taskId: 'explore-halt' })
  assert.equal(done.result.status, 'DONE')
  assert.equal(done.result.completion && done.result.completion.type, 'INSUFFICIENT')
  assert.equal(done.result.results.evaluate.verdict, 'NEEDS_RESEARCH')
  assert.equal(done.result.results.explore_budget_exhausted.effective_verdict, 'INSUFFICIENT')
  assert.equal(done.result.budgetUsed, 2)
})

test('LOC-013 INSUFFICIENT 是合法完成：DONE + completion.type=INSUFFICIENT', async () => {
  const { result } = await runEngine(exploreBp, {
    探索统筹: plan(3),
    '/^专家研究 #/': (label) => researchItem(Number(label.slice(-1))),
    综合分析: synthesis,
    结论评估: evalVerdict('INSUFFICIENT', { completion_type: 'INSUFFICIENT' }),
  })
  assert.equal(result.status, 'DONE')
  assert.equal(result.completion && result.completion.type, 'INSUFFICIENT')
  assert.equal(result.results.evaluate.verdict, 'INSUFFICIENT')
})

test('LOC-013 技术失败沿 on:technical 自环重试，不消耗回退额度', async () => {
  let synthCalls = 0
  const { result } = await runEngine(exploreBp, {
    探索统筹: plan(3),
    '/^专家研究 #/': (label) => researchItem(Number(label.slice(-1))),
    综合分析: () => {
      synthCalls += 1
      if (synthCalls < 3) return { bad: 'schema 不合规（触发重试与 technical 自环）' }
      return synthesis
    },
    结论评估: evalVerdict('PASS', { completion_type: 'EVALUATION_PASSED' }),
  })
  assert.equal(result.status, 'DONE')
  // 首次 + 节点内格式重试 + technical 自环后再成功 = 3 次调用
  assert.equal(synthCalls, 3)
  assert.equal(result.budgetUsed, 0)
  assert.ok(!result.history.some((h) => h.halted === true))
})

test('LOC-013 fanout 注入独立 scratch 与隔离禁令（有 workspace 现场）', async () => {
  const { result, agentCalls } = await runEngine(exploreBp, {
    探索统筹: plan(3),
    '/^专家研究 #/': (label) => researchItem(Number(label.slice(-1))),
    综合分析: synthesis,
    结论评估: evalVerdict('PASS', { completion_type: 'EVALUATION_PASSED' }),
  }, {
    taskId: 'explore-ws',
    workspace_path: '/ws/explore-1',
    source_path: '/ws/explore-1/source',
    workspace_mode: 'ISOLATED_READ',
  })
  assert.equal(result.status, 'DONE')
  for (let i = 1; i <= 3; i++) {
    const call = agentCalls.find((c) => c.label === '专家研究 #' + i)
    assert.ok(call, '缺专家 #' + i + ' 调用')
    assert.ok(call.prompt.includes('/ws/explore-1/workers/research-' + i + '/'), '专家 #' + i + ' prompt 缺专属 scratch 路径')
    assert.ok(call.prompt.includes('禁止读取或写入其他并行子任务的 scratch 目录'), '专家 #' + i + ' prompt 缺兄弟隔离禁令')
    assert.ok(call.prompt.includes('正式交付物写入 run 产物目录'), '专家 #' + i + ' prompt 缺正式交付物指引')
    assert.ok(call.prompt.includes('只读现场'), '专家 #' + i + ' prompt 缺 source 只读标注')
  }
  // ISOLATED_READ 时普通节点（统筹/综合/评估）上下文也标注 source 只读
  const orch = agentCalls.find((c) => c.label === '探索统筹')
  assert.ok(orch.prompt.includes('只读现场'))
  assert.ok(!orch.prompt.includes('唯一允许写业务文件的位置'))
})

test('LOC-013 无 workspace 现场时 fanout 不注入 scratch（安全降级）', async () => {
  const { result, agentCalls } = await runEngine(exploreBp, {
    探索统筹: plan(3),
    '/^专家研究 #/': (label) => researchItem(Number(label.slice(-1))),
    综合分析: synthesis,
    结论评估: evalVerdict('PASS', { completion_type: 'EVALUATION_PASSED' }),
  })
  assert.equal(result.status, 'DONE')
  const worker = agentCalls.find((c) => c.label === '专家研究 #1')
  assert.ok(!worker.prompt.includes('workers/research-'), '无现场时不应出现 scratch 路径')
  assert.ok(!worker.prompt.includes('并行子任务工作区'))
})

test('LOC-013 内核级隔离反例：readWorkerFile 拒绝 ../ 逃逸到兄弟 scratch', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'loc013-scratch-'))
  try {
    const ws = { workspace_path: tmp }
    mkdirSync(path.join(tmp, 'workers', 'research-1'), { recursive: true })
    mkdirSync(path.join(tmp, 'workers', 'research-2'), { recursive: true })
    writeWorkerFile(ws, 'research-2', 'note.md', 'expert-2 的工作笔记')
    // Expert A（research-1）试图读 Expert B（research-2）的 scratch → 拒绝
    assert.throws(() => readWorkerFile(ws, 'research-1', '../research-2/note.md'))
    // 自己 scratch 内读写正常
    writeWorkerFile(ws, 'research-1', 'note.md', 'expert-1 的工作笔记')
    assert.equal(readWorkerFile(ws, 'research-1', 'note.md'), 'expert-1 的工作笔记')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('LOC-013 E2：worker 提示不下发 Run 级 capability（RPC 面无凭据可冒用）', async () => {
  const { result, agentCalls } = await runEngine(exploreBp, {
    探索统筹: plan(3),
    '/^专家研究 #/': (label) => researchItem(Number(label.slice(-1))),
    综合分析: synthesis,
    结论评估: evalVerdict('PASS', { completion_type: 'EVALUATION_PASSED' }),
  }, {
    taskId: 'explore-cap',
    workspace_path: '/ws/explore-cap',
    source_path: '/ws/explore-cap/source',
    workspace_mode: 'ISOLATED_READ',
    workspace_capability: 'cap-run-level-secret',
  })
  assert.equal(result.status, 'DONE')
  for (const c of agentCalls.filter((x) => /^专家研究 #/.test(x.label))) {
    assert.ok(!c.prompt.includes('cap-run-level-secret'), c.label + ' 的 prompt 不得携带 Run 级 capability')
    assert.ok(!c.prompt.includes('workspace RPC 能力令牌'), c.label + ' 的 prompt 不得出现 capability 指引')
  }
  // 非 fanout 节点（统筹/综合/评估）保留 capability 行（本模板虽不消费，其他工作流节点可能需要）
  const orch = agentCalls.find((c) => c.label === '探索统筹')
  assert.ok(orch.prompt.includes('cap-run-level-secret'), '非 fanout 节点的 capability 行不应受影响')
})

test('LOC-013 E4：fanout 部分失败不伪装业务结果，默认 failOn=all 继续聚合', async () => {
  const { result } = await runEngine(exploreBp, {
    探索统筹: plan(3),
    '/^专家研究 #/': (label) => label === '专家研究 #2' ? { bad: 'schema 不合规' } : researchItem(Number(label.slice(-1))),
    综合分析: synthesis,
    结论评估: evalVerdict('PASS', { completion_type: 'EVALUATION_PASSED' }),
  })
  assert.equal(result.status, 'DONE')
  const agg = result.results.research
  assert.equal(agg.total, 3)
  assert.equal(agg.okCount, 2)
  assert.equal(agg.failedCount, 1)
  assert.equal(agg.items[1], null)
  // 失败项为 null，不进入 results 伪装成业务 verdict；下游照常评估
  assert.equal(result.results.evaluate.verdict, 'PASS')
})

test('LOC-013 E4：fanout 全部失败走 failure 边，FAILED_AT_research 而非业务路由', async () => {
  const { result, agentCalls } = await runEngine(exploreBp, {
    探索统筹: plan(3),
    '/^专家研究 #/': { bad: '全部不合规' },
    综合分析: synthesis,
    结论评估: evalVerdict('PASS', { completion_type: 'EVALUATION_PASSED' }),
  })
  assert.equal(result.status, 'FAILED_AT_research')
  // 技术聚合失败不得触发综合/评估，也不得伪装成 NEEDS_RESEARCH
  assert.ok(!agentCalls.some((c) => c.label === '综合分析'))
  assert.ok(!agentCalls.some((c) => c.label === '结论评估'))
  assert.equal(result.results.evaluate, undefined)
  assert.equal(result.results.research.failedCount, 3)
})

test('LOC-013 B7 targeted 重算：新证据只让依赖它的 Synthesis/Evaluation 标 stale（真实 #78 通道）', () => {
  const store = createStore()
  const prov = (node, attempt = 1) => ({
    logical_run_id: 'loc-013-r1', node, attempt,
    snapshot_revision: 'snap-1', provider: 'deepseek-official', model: 'deepseek-v4-flash',
    produced_by: 'loc013-test', node_business_outcome: null,
  })
  const jsonBody = (value) => ({ media_type: MEDIA.JSON, value })
  // 第一轮 BROAD：三位专家证据 + 依赖证据集合的 Synthesis / Evaluation
  const a1 = appendRecord(store, { record_id: 'expert-a', kind: KIND.RESULT, body: jsonBody({ expert: 'a', round: 1 }), provenance: prov('research') })
  const b1 = appendRecord(store, { record_id: 'expert-b', kind: KIND.RESULT, body: jsonBody({ expert: 'b', round: 1 }), provenance: prov('research') })
  const c1 = appendRecord(store, { record_id: 'expert-c', kind: KIND.RESULT, body: jsonBody({ expert: 'c', round: 1 }), provenance: prov('research') })
  const synth1 = appendRecord(store, {
    record_id: 'synthesis', kind: KIND.RESULT, body: jsonBody({ round: 1 }),
    dependencies: [toRef(a1), toRef(b1), toRef(c1)], provenance: prov('synthesize'),
  })
  const eval1 = appendRecord(store, {
    record_id: 'evaluation', kind: KIND.PROOF_DECISION, body: jsonBody({ verdict: 'NEEDS_RESEARCH' }),
    dependencies: [toRef(synth1)], provenance: prov('evaluate'),
  })
  assert.equal(dependsOnStaleInputs(store, synth1), false)
  assert.equal(dependsOnStaleInputs(store, eval1), false)

  // TARGETED 轮：只补 expert-a（新证据 Revision）
  const a2 = appendRecord(store, { record_id: 'expert-a', kind: KIND.RESULT, body: jsonBody({ expert: 'a', round: 2 }), provenance: prov('research', 2) })
  assert.equal(a2.record_revision, 2)

  // 依赖旧证据集合的 Synthesis 标 stale；兄弟专家结果不失效、不前进
  assert.equal(dependsOnStaleInputs(store, synth1), true)
  assert.equal(coverageStatus(store, synth1, 'expert-a').status, NOT_COVERING_CURRENT)
  assert.equal(coverageStatus(store, synth1, 'expert-b').status, COVERING)
  assert.deepEqual(staleProofsFor(store, 'expert-b'), [])

  // 重算 Synthesis（依赖 a2 的新 Revision）后，依赖旧 Synthesis 的 Evaluation 才标 stale
  const synth2 = appendRecord(store, {
    record_id: 'synthesis', kind: KIND.RESULT, body: jsonBody({ round: 2 }),
    dependencies: [toRef(a2), toRef(b1), toRef(c1)], provenance: prov('synthesize', 2),
  })
  assert.equal(dependsOnStaleInputs(store, eval1), true)
  assert.equal(coverageStatus(store, eval1, 'synthesis').status, NOT_COVERING_CURRENT)

  // 重算 Evaluation 覆盖当前 Revision；旧 Proof 保留为历史（不删不改写）
  const eval2 = appendRecord(store, {
    record_id: 'evaluation', kind: KIND.PROOF_DECISION, body: jsonBody({ verdict: 'PASS' }),
    dependencies: [toRef(synth2)], provenance: prov('evaluate', 2),
  })
  assert.equal(coverageStatus(store, eval2, 'synthesis').status, COVERING)
  assert.equal(dependsOnStaleInputs(store, eval2), false)
})
