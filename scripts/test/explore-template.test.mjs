import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { compileBlueprint } from '../generate.mjs'
import { runGeneratedScript, makeAgentScript } from './helpers/runtime-harness.mjs'
import { readWorkerFile, writeWorkerFile } from '../workspace-isolation.mjs'
import validatorCore from '../validate-core.cjs'

const { validateBlueprint } = validatorCore
const here = path.dirname(fileURLToPath(import.meta.url))
const exploreBp = JSON.parse(readFileSync(path.join(here, '../../templates/explore.json'), 'utf8'))

const runEngine = (bp, table, args = {}) => {
  const { script } = compileBlueprint(bp)
  const agent = makeAgentScript(table)
  return runGeneratedScript(script, { args, agent })
}

const briefs = (n) => Array.from({ length: n }, (_, i) => ({
  expert_id: 'expert-' + (i + 1),
  focus: '视角 ' + (i + 1),
  brief: '取证要求 ' + (i + 1),
}))
const plan = (n, roundType) => ({
  route: 'PLAN_READY',
  round_type: roundType || 'BROAD',
  research_question: 'Q',
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
  open_gaps: ['缺口'],
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
  assert.equal(exploreBp.workspace && exploreBp.workspace.template_id, 'explore')
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
  const { result } = await runEngine(exploreBp, {
    探索统筹: () => { orchestras += 1; return plan(3, orchestras === 1 ? 'BROAD' : 'TARGETED') },
    '/^专家研究 #/': (label) => researchItem(Number(label.slice(-1))),
    综合分析: synthesis,
    结论评估: () => {
      evals += 1
      if (evals < 3) return evalVerdict('NEEDS_RESEARCH', { research_targets: ['缺口' + evals] })
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

test('LOC-013 第 3 轮仍 NEEDS_RESEARCH：保留原结论，WAITING_HUMAN + MAX_ROUNDS_REACHED', async () => {
  const table = {
    探索统筹: plan(3),
    '/^专家研究 #/': (label) => researchItem(Number(label.slice(-1))),
    综合分析: synthesis,
    结论评估: () => evalVerdict('NEEDS_RESEARCH', { research_targets: ['仍有缺口'] }),
  }
  const halt = await runEngine(exploreBp, table, { taskId: 'explore-halt' })
  assert.equal(halt.result.status, 'WAITING_HUMAN')
  assert.equal(halt.result.reason, 'MAX_ROUNDS_REACHED')
  assert.equal(halt.result.node, 'evaluate')
  // 规格红线：不改写 Node Business Outcome
  assert.equal(halt.result.results.evaluate.verdict, 'NEEDS_RESEARCH')
  assert.equal(halt.result.budgetUsed, 2)
  // 决策材料：默认控制选项齐全（USER_ACCEPTED / ADD_BUDGET / STOP）
  const optionIds = halt.result.decision_package.options.map((o) => o.id)
  for (const id of ['USER_ACCEPTED', 'ADD_BUDGET', 'STOP']) assert.ok(optionIds.includes(id), '缺选项 ' + id)
  assert.ok(halt.result.decision_package.why.includes('NEEDS_RESEARCH'))

  // USER_ACCEPTED：受控完成，不重跑任何节点
  const accepted = await runEngine(exploreBp, {}, {
    taskId: 'explore-halt',
    entry: 'evaluate',
    decision_id: halt.result.decision_id,
    user_choice: 'USER_ACCEPTED',
    results: halt.result.results,
  })
  assert.equal(accepted.result.status, 'DONE')
  assert.equal(accepted.result.results.evaluate.verdict, 'NEEDS_RESEARCH')
  assert.equal(accepted.agentCalls.length, 0)
})

test('LOC-013 ADD_BUDGET 续跑：显式入账后沿被拦边再走一轮', async () => {
  const table = {
    探索统筹: plan(3),
    '/^专家研究 #/': (label) => researchItem(Number(label.slice(-1))),
    综合分析: synthesis,
    结论评估: () => evalVerdict('NEEDS_RESEARCH', { research_targets: ['仍有缺口'] }),
  }
  const halt = await runEngine(exploreBp, table, { taskId: 'explore-budget' })
  assert.equal(halt.result.status, 'WAITING_HUMAN')

  let evals = 0
  const resumed = await runEngine(exploreBp, {
    探索统筹: plan(3, 'TARGETED'),
    '/^专家研究 #/': (label) => researchItem(Number(label.slice(-1))),
    综合分析: synthesis,
    结论评估: () => { evals += 1; return evalVerdict('PASS', { completion_type: 'EVALUATION_PASSED' }) },
  }, {
    taskId: 'explore-budget',
    entry: 'evaluate',
    decision_id: halt.result.decision_id,
    user_choice: 'ADD_BUDGET',
    results: halt.result.results,
    blocked_edge: halt.result.blocked_edge,
    budgetUsed: halt.result.budgetUsed,
    maxRounds: halt.result.maxRounds,
    history: halt.result.history,
    decisionSeq: halt.result.decisionSeq,
  })
  assert.equal(resumed.result.status, 'DONE')
  assert.equal(evals, 1)
  assert.equal(resumed.result.results.orchestrate.round_type, 'TARGETED')
  assert.equal(resumed.result.completion && resumed.result.completion.type, 'EVALUATION_PASSED')
  // ADD_BUDGET 显式入账：maxRounds+1，被拦边走完后 budgetUsed=3
  assert.equal(resumed.result.maxRounds, 3)
  assert.equal(resumed.result.budgetUsed, 3)
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
    探索统筹: plan(2),
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
    探索统筹: plan(2),
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
