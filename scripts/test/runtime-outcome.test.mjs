import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { compileBlueprint, projectToVwf, skillWrap } from '../generate.mjs'
import { runGeneratedScript, makeAgentScript } from './helpers/runtime-harness.mjs'
import validatorCore from '../validate-core.cjs'

const { validateBlueprint } = validatorCore
const here = path.dirname(fileURLToPath(import.meta.url))
const outcomeBp = JSON.parse(readFileSync(path.join(here, 'fixtures/outcome-evaluate-mini.json'), 'utf8'))
const hello = JSON.parse(readFileSync(path.join(here, 'fixtures/hello-blueprint.json'), 'utf8'))

const runEngine = (bp, table, args = {}) => {
  const { script } = compileBlueprint(bp)
  const agent = makeAgentScript(table)
  return runGeneratedScript(script, { args, agent })
}

test('#127 夹具通过校验', () => {
  assert.equal(validateBlueprint(outcomeBp).ok, true, JSON.stringify(validateBlueprint(outcomeBp).errors))
})

test('#127 PASS 走进 $end：DONE 带 completion，不改写节点结果', async () => {
  const { result } = await runEngine(outcomeBp, {
    intake: { go: 'NEXT' },
    execute: { status: 'DONE' },
    evaluate: { verdict: 'PASS', completion_type: 'EVALUATION_PASSED' },
  })
  assert.equal(result.status, 'DONE')
  assert.deepEqual(result.completion, {
    type: 'EVALUATION_PASSED',
    node: 'evaluate',
    path: '$.completion_type',
  })
  assert.equal(result.results.evaluate.verdict, 'PASS')
})

test('#73 OPTIMIZE 回执行后 PASS：countRound 消耗 1 点额度（未达上限）', async () => {
  let evals = 0
  const { result } = await runEngine(outcomeBp, {
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
  assert.equal(result.completion.type, 'EVALUATION_PASSED')
})

test('#127 CONFIRM → ROUTE_HALTED，保留 results，不发 WAITING_HUMAN', async () => {
  const { result } = await runEngine(outcomeBp, {
    intake: { go: 'NEXT' },
    execute: { status: 'DONE' },
    evaluate: { verdict: 'CONFIRM', completion_type: 'pending' },
  })
  assert.equal(result.status, 'ROUTE_HALTED')
  assert.equal(result.reason, 'HUMAN_DECISION')
  assert.equal(result.node, 'evaluate')
  assert.equal(result.results.evaluate.verdict, 'CONFIRM')
  assert.equal(result.completion, undefined)
})

test('#127 缺匹配业务边：ENDED_NO_OUTCOME_EDGE，不改写 results', async () => {
  const bp = JSON.parse(JSON.stringify(outcomeBp))
  const ev = bp.nodes.find((n) => n.id === 'evaluate')
  ev.output.schema.properties.verdict.enum.push('SKIP')
  bp.edges = bp.edges.filter((e) => e.outcome !== 'SKIP')
  const { result } = await runEngine(bp, {
    intake: { go: 'NEXT' },
    execute: { status: 'DONE' },
    evaluate: { verdict: 'SKIP', completion_type: 'none' },
  })
  assert.equal(result.status, 'ENDED_NO_OUTCOME_EDGE')
  assert.equal(result.results.evaluate.verdict, 'SKIP')
})

test('#127 新模式 agent 返回 null：无匹配则 TECHNICAL_FAILURE', async () => {
  const { result } = await runEngine(outcomeBp, {
    intake: { go: 'NEXT' },
    execute: null,
  })
  assert.equal(result.status, 'TECHNICAL_FAILURE')
})

test('#127 旧 hello 蓝图仍可 DONE', async () => {
  const first = await runEngine(hello, {
    dispatch: { complete: true },
    work: { status: 'completed' },
    gate: { verdict: 'ok' },
  })
  assert.equal(first.result.status, 'AWAITING_HUMAN_gate')
  const second = await runEngine(hello, { finish: { done: true } }, {
    entry: 'gate', approved: true, startRound: 0, history: [], feedback: '',
  })
  assert.equal(second.result.status, 'DONE')
  assert.equal(second.result.completion, null)
})

test('#127 投影透传 outcome / countRound / completionPath；skill 覆盖新状态', () => {
  const dsl = projectToVwf(outcomeBp)
  const ev = dsl.nodes.find((n) => n.id === 'evaluate')
  assert.equal(ev.output.outcomePath, '$.verdict')
  assert.equal(ev.output.completionPath, '$.completion_type')
  const opt = dsl.edges.find((e) => e.outcome === 'OPTIMIZE')
  assert.equal(opt.countRound, true)
  assert.equal(opt.on, undefined)
  const skill = skillWrap(outcomeBp)
  assert.ok(skill.includes('ROUTE_HALTED'))
  assert.ok(skill.includes('ENDED_NO_OUTCOME_EDGE'))
})
