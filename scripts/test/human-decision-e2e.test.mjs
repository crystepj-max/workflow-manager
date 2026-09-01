import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { compileBlueprint } from '../generate.mjs'
import { runGeneratedScript, makeAgentScript } from './helpers/runtime-harness.mjs'
import validatorCore from '../validate-core.cjs'

const { validateBlueprint, HD_PACKAGE_REQUIRED } = validatorCore

const here = path.dirname(fileURLToPath(import.meta.url))
const hd = JSON.parse(readFileSync(path.join(here, 'fixtures/human-decision-blueprint.json'), 'utf8'))
const mini = JSON.parse(readFileSync(path.join(here, 'fixtures/hello-blueprint.json'), 'utf8'))

const runBp = (bp, table, args = {}) => {
  const { script } = compileBlueprint(bp)
  return runGeneratedScript(script, { args: { taskId: args.taskId || 'e2e-task', ...args }, agent: makeAgentScript(table) })
}

const confirm = {
  status: 'confirm',
  why: '需要人决定是否交付',
  current_state: '实现已完成，待拍板',
}

test('#122 夹具卫生：E2E 蓝图通过校验', () => {
  assert.equal(validateBlueprint(hd).ok, true, JSON.stringify(validateBlueprint(hd).errors))
})

test('#122 一条路径：声明条件升级 → Package 可读 → 业务 Result 续跑到蓝图目标', async () => {
  const halt = await runBp(hd, { 执行: confirm })
  assert.equal(halt.result.status, 'WAITING_HUMAN')
  assert.equal(halt.result.reason, 'ESCALATED_DECISION')
  assert.equal(halt.result.taskId, 'e2e-task')
  assert.equal(typeof halt.result.decision_id, 'string')
  assert.ok(halt.result.decision_id.length > 0)
  for (const key of HD_PACKAGE_REQUIRED) {
    assert.ok(halt.result.decision_package && halt.result.decision_package[key], 'Package 缺 ' + key)
  }
  assert.equal(halt.result.results.work.status, 'confirm')

  const resumed = await runBp(hd, { 收口: { done: true } }, {
    taskId: halt.result.taskId,
    entry: halt.result.node,
    decision_id: halt.result.decision_id,
    user_choice: 'SHIP',
    results: halt.result.results,
  })
  assert.equal(resumed.result.status, 'DONE')
  assert.equal(resumed.result.taskId, 'e2e-task', '同一 task 身份继续')
  assert.equal(resumed.result.decision_id, halt.result.decision_id)
  assert.equal(resumed.result.user_choice, 'SHIP')
  assert.equal(resumed.result.results.work.status, 'confirm')
  assert.equal(resumed.result.results.finish.done, true)
  assert.equal(resumed.result.control_event.subsequent_path, 'finish')
  assert.deepEqual(resumed.agentCalls.map((c) => c.label), ['收口'])
})

test('#122 未命中声明条件不得升级到 Human Decision', async () => {
  const auto = await runBp(hd, { 执行: { status: 'auto' }, 收口: { done: true } })
  assert.notEqual(auto.result.status, 'WAITING_HUMAN')
  assert.equal(auto.result.status, 'DONE')
  assert.equal(auto.result.results.finish.done, true)
})

test('#122 无 HD 入边时不得升级（无声明）', async () => {
  const plain = JSON.parse(JSON.stringify(hd))
  plain.edges = [
    { from: 'work', to: 'finish', on: 'success' },
    { from: 'finish', to: '$end', on: 'success' },
  ]
  assert.equal(validateBlueprint(plain).ok, true, JSON.stringify(validateBlueprint(plain).errors))
  const r = await runBp(plain, { 执行: confirm, 收口: { done: true } })
  assert.notEqual(r.result.status, 'WAITING_HUMAN')
  assert.equal(r.result.status, 'DONE')
})

test('#122 STOP / USER_ACCEPTED / ADD_BUDGET 各一条', async () => {
  const halt = await runBp(hd, { 执行: confirm })
  assert.equal(halt.result.status, 'WAITING_HUMAN')

  const stopped = await runBp(hd, { 收口: { done: true } }, {
    taskId: halt.result.taskId,
    entry: halt.result.node,
    decision_id: halt.result.decision_id,
    user_choice: 'STOP',
    results: halt.result.results,
  })
  assert.equal(stopped.result.status, 'STOPPED')
  assert.ok(!stopped.agentCalls.some((c) => c.label === '收口'))

  const halt2 = await runBp(hd, { 执行: confirm }, { taskId: 'e2e-accept' })
  const accepted = await runBp(hd, { 收口: { done: true } }, {
    taskId: 'e2e-accept',
    entry: halt2.result.node,
    decision_id: halt2.result.decision_id,
    user_choice: 'USER_ACCEPTED',
    results: halt2.result.results,
  })
  assert.equal(accepted.result.status, 'DONE')
  assert.equal(accepted.result.results.work.status, 'confirm')
  assert.ok(!accepted.agentCalls.some((c) => c.label === '收口'))

  const halt3 = await runBp(hd, { 执行: confirm }, {
    taskId: 'e2e-budget',
    injectHalt: {
      node: 'work',
      reason: 'MAX_ROUNDS_REACHED',
      blocked_edge: { from: 'work', to: 'finish', on: 'success' },
    },
  })
  assert.equal(halt3.result.status, 'WAITING_HUMAN')
  assert.equal(halt3.result.reason, 'MAX_ROUNDS_REACHED')
  assert.ok(halt3.result.decision_package.options.some((o) => o.id === 'ADD_BUDGET'))
  const budgeted = await runBp(hd, { 收口: { done: true } }, {
    taskId: 'e2e-budget',
    entry: halt3.result.node,
    decision_id: halt3.result.decision_id,
    user_choice: 'ADD_BUDGET',
    results: halt3.result.results,
    blocked_edge: halt3.result.blocked_edge,
  })
  assert.equal(budgeted.result.status, 'DONE')
  assert.equal(budgeted.result.results.work.status, 'confirm')
  assert.deepEqual(budgeted.agentCalls.map((c) => c.label), ['收口'])
})

test('#122 残留门禁 approved:false 再挂起', async () => {
  const first = await runBp(mini, {
    dispatch: { complete: true },
    work: { status: 'completed' },
    gate: { verdict: 'ok' },
  }, { taskId: 'left-e2e' })
  assert.equal(first.result.status, 'AWAITING_HUMAN_gate')
  const again = await runBp(mini, {
    dispatch: { complete: true },
    work: { status: 'completed' },
    gate: { verdict: 'ok' },
  }, {
    taskId: 'left-e2e',
    entry: 'gate',
    approved: false,
    results: first.result.results,
  })
  assert.equal(again.result.status, 'AWAITING_HUMAN_gate')
  assert.ok(!again.agentCalls.some((c) => c.label && c.label.indexOf('收口') >= 0))
})
