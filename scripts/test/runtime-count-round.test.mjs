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
const optimizeBp = JSON.parse(readFileSync(path.join(here, 'fixtures/outcome-evaluate-mini.json'), 'utf8'))
const reconfirmBp = JSON.parse(readFileSync(path.join(here, 'fixtures/outcome-reconfirm-mini.json'), 'utf8'))
const researchBp = JSON.parse(readFileSync(path.join(here, 'fixtures/outcome-research-mini.json'), 'utf8'))
const hello = JSON.parse(readFileSync(path.join(here, 'fixtures/hello-blueprint.json'), 'utf8'))

const runEngine = (bp, table, args = {}) => {
  const { script } = compileBlueprint(bp)
  const agent = makeAgentScript(table)
  return runGeneratedScript(script, { args, agent })
}

test('#73 夹具通过校验', () => {
  for (const bp of [optimizeBp, reconfirmBp, researchBp]) {
    const v = validateBlueprint(bp)
    assert.equal(v.ok, true, JSON.stringify(v.errors))
  }
})

test('#73 OPTIMIZE 计数：一次回退消耗 1 点额度，未达上限仍可 PASS', async () => {
  let evals = 0
  const { result } = await runEngine(optimizeBp, {
    intake: { go: 'NEXT' },
    '/^execute/': { status: 'DONE' },
    evaluate: () => {
      evals += 1
      if (evals === 1) return { verdict: 'OPTIMIZE', completion_type: 'loop' }
      return { verdict: 'PASS', completion_type: 'EVALUATION_PASSED' }
    },
  })
  assert.equal(result.status, 'DONE')
  assert.equal(evals, 2)
  assert.equal(result.budgetUsed, 1)
  assert.equal(result.maxRounds, 3)
  assert.ok(result.history.some((h) => h.outcome === 'OPTIMIZE' && h.countRound === true && !h.halted))
})

test('#73 OPTIMIZE 达到额度：保留 OPTIMIZE，WAITING_HUMAN + MAX_ROUNDS_REACHED', async () => {
  const bp = JSON.parse(JSON.stringify(optimizeBp))
  bp.control.maxRounds = 2
  const { result } = await runEngine(bp, {
    intake: { go: 'NEXT' },
    '/^execute/': { status: 'DONE' },
    '/^evaluate/': { verdict: 'OPTIMIZE', completion_type: 'loop' },
  })
  assert.equal(result.status, 'WAITING_HUMAN')
  assert.equal(result.reason, 'MAX_ROUNDS_REACHED')
  assert.equal(result.results.evaluate.verdict, 'OPTIMIZE')
  assert.equal(result.budgetUsed, 2)
  assert.equal(result.blocked_edge && result.blocked_edge.to, 'execute')
  assert.equal(result.blocked_edge.countRound, true)
  assert.ok(result.history.some((h) => h.halted === true && h.reason === 'MAX_ROUNDS_REACHED'))
  assert.notEqual(result.status, 'FAILED_MAX_ROUNDS')
})

test('#73 RECONFIRM 不计数：超过 maxRounds 次仍完整记录且不耗尽', async () => {
  let execs = 0
  const { result } = await runEngine(reconfirmBp, {
    kickoff: { go: 'START' },
    '/^intake/': { go: 'NEXT' },
    execute: () => {
      execs += 1
      if (execs <= 3) return { status: 'RECONFIRM_REQUIRED' }
      return { status: 'DONE' }
    },
    evaluate: { verdict: 'PASS', completion_type: 'EVALUATION_PASSED' },
  })
  assert.equal(result.status, 'DONE')
  assert.equal(result.budgetUsed, 0)
  const recs = result.history.filter((h) => h.outcome === 'RECONFIRM_REQUIRED')
  assert.equal(recs.length, 3)
  assert.ok(recs.every((h) => h.countRound === false && !h.halted))
})

test('#73 探索第 3 轮 NEEDS_RESEARCH：保留结果并转人工（自动补充研究额度=2）', async () => {
  let evals = 0
  const { result } = await runEngine(researchBp, {
    kickoff: { go: 'START' },
    '/^orchestrate/': { go: 'RESEARCH' },
    '/^research/': { status: 'DONE' },
    evaluate: () => {
      evals += 1
      return { verdict: 'NEEDS_RESEARCH' }
    },
  })
  assert.equal(evals, 3)
  assert.equal(result.status, 'WAITING_HUMAN')
  assert.equal(result.reason, 'MAX_ROUNDS_REACHED')
  assert.equal(result.results.evaluate.verdict, 'NEEDS_RESEARCH')
  assert.equal(result.budgetUsed, 2)
  assert.notEqual(result.results.evaluate.verdict, 'PASS')
  assert.notEqual(result.results.evaluate.verdict, 'INSUFFICIENT')
})

test('#73 技术重试不计额度', async () => {
  const bp = JSON.parse(JSON.stringify(optimizeBp))
  bp.edges.push({ from: 'execute', to: 'execute', on: 'technical' })
  let execs = 0
  const { result } = await runEngine(bp, {
    intake: { go: 'NEXT' },
    execute: () => {
      execs += 1
      if (execs <= 2) return null
      return { status: 'DONE' }
    },
    evaluate: { verdict: 'PASS', completion_type: 'EVALUATION_PASSED' },
  })
  assert.equal(result.status, 'DONE')
  assert.equal(result.budgetUsed, 0)
  const tech = result.history.filter((h) => h.on === 'technical')
  assert.equal(tech.length, 2)
  assert.ok(tech.every((h) => h.countRound === false))
})

test('#73 ADD_BUDGET 显式 +1 额度并沿被拦边继续，写入 Control Record', async () => {
  const bp = JSON.parse(JSON.stringify(optimizeBp))
  bp.control.maxRounds = 1
  const first = await runEngine(bp, {
    intake: { go: 'NEXT' },
    '/^execute/': { status: 'DONE' },
    '/^evaluate/': { verdict: 'OPTIMIZE', completion_type: 'loop' },
  })
  assert.equal(first.result.status, 'WAITING_HUMAN')
  assert.equal(first.result.reason, 'MAX_ROUNDS_REACHED')
  const ev = first.result.control_event
  assert.equal(ev.user_choice, null)
  assert.equal(ev.budget_used, 1)

  let evals = 0
  const resumed = await runEngine(bp, {
    '/^execute/': { status: 'DONE' },
    evaluate: () => {
      evals += 1
      return { verdict: 'PASS', completion_type: 'EVALUATION_PASSED' }
    },
  }, {
    decision_id: first.result.decision_id,
    user_choice: 'ADD_BUDGET',
    blocked_edge: first.result.blocked_edge,
    results: first.result.results,
    history: first.result.history,
    budgetUsed: first.result.budgetUsed,
    maxRounds: first.result.maxRounds,
    entry: first.result.node,
  })
  assert.equal(resumed.result.status, 'DONE')
  assert.equal(resumed.result.budgetUsed, 2)
  assert.equal(resumed.result.maxRounds, 2)
  assert.equal(resumed.result.control_event.user_choice, 'ADD_BUDGET')
  assert.equal(resumed.result.control_event.budget_delta, 1)
  assert.equal(resumed.result.control_event.max_rounds_after, 2)
  assert.equal(resumed.result.results.evaluate.verdict, 'PASS')
  assert.ok(resumed.result.history.some((h) => h.via === 'ADD_BUDGET' && h.countRound === true))
})

test('#73 ADD_BUDGET 后再耗尽须新 decision_id，不得覆盖前次 Decision Record', async () => {
  const bp = JSON.parse(JSON.stringify(optimizeBp))
  bp.control.maxRounds = 1
  const first = await runEngine(bp, {
    intake: { go: 'NEXT' },
    '/^execute/': { status: 'DONE' },
    '/^evaluate/': { verdict: 'OPTIMIZE', completion_type: 'loop' },
  })
  assert.equal(first.result.status, 'WAITING_HUMAN')
  const id1 = first.result.decision_id
  assert.ok(id1)
  assert.equal(first.result.decisionSeq, 1)
  assert.equal(first.result.control_event.attempt, 1)

  const second = await runEngine(bp, {
    '/^execute/': { status: 'DONE' },
    '/^evaluate/': { verdict: 'OPTIMIZE', completion_type: 'loop' },
  }, {
    decision_id: id1,
    user_choice: 'ADD_BUDGET',
    blocked_edge: first.result.blocked_edge,
    results: first.result.results,
    history: first.result.history,
    budgetUsed: first.result.budgetUsed,
    maxRounds: first.result.maxRounds,
    decisionSeq: first.result.decisionSeq,
    entry: first.result.node,
  })
  assert.equal(second.result.status, 'WAITING_HUMAN')
  assert.equal(second.result.reason, 'MAX_ROUNDS_REACHED')
  assert.notEqual(second.result.decision_id, id1)
  assert.equal(second.result.decisionSeq, 2)
  assert.equal(second.result.control_event.decision_id, second.result.decision_id)
  assert.equal(second.result.results.evaluate.verdict, 'OPTIMIZE')
})

test('#73 旧蓝图 failure 边仍走 FAILED_MAX_ROUNDS（兼容）', async () => {
  const bp = JSON.parse(JSON.stringify(hello))
  bp.control = { maxRounds: 1 }
  const { result } = await runEngine(bp, {
    '/^dispatch/': { complete: true },
    '/^work/': { status: 'blocked' },
  })
  assert.equal(result.status, 'FAILED_MAX_ROUNDS')
})
