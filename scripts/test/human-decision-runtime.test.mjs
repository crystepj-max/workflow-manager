import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { compileBlueprint } from '../generate.mjs'
import { runGeneratedScript, makeAgentScript } from './helpers/runtime-harness.mjs'
import validatorCore from '../validate-core.cjs'

const {
  validateBlueprint,
  HD_PACKAGE_REQUIRED,
  HD_PACKAGE_OPTIONAL_UNKNOWN,
  HD_EVENT_FIELDS,
  HD_CONTROL_RESULTS,
} = validatorCore

const here = path.dirname(fileURLToPath(import.meta.url))
const hd = JSON.parse(readFileSync(path.join(here, 'fixtures/human-decision-blueprint.json'), 'utf8'))
const mini = JSON.parse(readFileSync(path.join(here, 'fixtures/hello-blueprint.json'), 'utf8'))
const outcomeHd = JSON.parse(readFileSync(path.join(here, 'fixtures/outcome-evaluate-mini.json'), 'utf8'))

const runHd = (table, args = {}, bp = hd) => {
  const { script } = compileBlueprint(bp)
  return runGeneratedScript(script, { args: { taskId: 'hd-task', ...args }, agent: makeAgentScript(table) })
}

const workOk = {
  status: 'confirm',
  why: '需要人决定是否交付',
  current_state: '实现已完成，待拍板',
}

test('#118 夹具卫生：HD 蓝图通过校验', () => {
  assert.equal(validateBlueprint(hd).ok, true, JSON.stringify(validateBlueprint(hd).errors))
})

test('#118 命中 $human-decision 翻译为 WAITING_HUMAN，带可渲染 Package 与控制面事件', async () => {
  const { result } = await runHd({ 执行: workOk })
  assert.equal(result.status, 'WAITING_HUMAN')
  assert.equal(result.reason, 'ESCALATED_DECISION')
  assert.equal(result.node, 'work')
  assert.equal(typeof result.decision_id, 'string')
  assert.ok(result.decision_id.length > 0)
  assert.deepEqual(result.results.work.status, 'confirm', '原 Node Outcome 只读快照保留')
  for (const key of HD_PACKAGE_REQUIRED) {
    assert.ok(result.decision_package && result.decision_package[key], 'Package 缺 ' + key)
  }
  assert.ok(result.decision_package.options.some((o) => o.id === 'SHIP'))
  assert.equal(result.decision_package.subsequent_effects.SHIP.length > 0, true)
  for (const key of HD_PACKAGE_OPTIONAL_UNKNOWN) {
    assert.equal(result.decision_package[key], 'UNKNOWN')
  }
  const ev = result.control_event
  assert.ok(ev, '应有控制面事件')
  for (const key of HD_EVENT_FIELDS) assert.ok(key in ev, '事件缺 ' + key)
  assert.equal(ev.record_kind, 'DECISION')
  assert.equal(ev.trigger, 'SYSTEM_REQUEST')
  assert.equal(ev.lifecycle_at_request, 'WAITING_HUMAN')
  assert.equal(ev.decision_id, result.decision_id)
  assert.equal(ev.user_choice, null)
  assert.equal(result.resume.decision_id, result.decision_id)
})

test('#118 Package 缺硬必填不得挂起；显式 UNKNOWN 仍可挂起', async () => {
  const missing = await runHd({ 执行: workOk }, {
    injectHalt: { node: 'work', decision_package: { why: '只有原因' } },
  })
  assert.notEqual(missing.result.status, 'WAITING_HUMAN')
  assert.ok(String(missing.result.detail || missing.result.status).includes('Package') || missing.result.status === 'ERROR')

  const { result } = await runHd({ 执行: workOk })
  assert.equal(result.status, 'WAITING_HUMAN')
  assert.equal(result.decision_package.cost, 'UNKNOWN')
  assert.equal(result.decision_package.benefit, 'UNKNOWN')
  assert.equal(result.decision_package.risk, 'UNKNOWN')
  assert.equal(result.decision_package.recommendation, 'UNKNOWN')
})

test('#118 无蓝图声明时运行时拒绝自行升级；残留 manualCheck 仍发 AWAITING_HUMAN_<id>', async () => {
  const undeclared = await runHd({ 执行: workOk, 收口: { done: true } }, {
    injectHalt: { node: 'finish', reason: 'ESCALATED_DECISION' },
  })
  assert.notEqual(undeclared.result.status, 'WAITING_HUMAN')
  assert.ok(String(undeclared.result.detail || '').includes('声明') || undeclared.result.status === 'ERROR')

  const leftover = await runHd({
    dispatch: { complete: true },
    work: { status: 'completed' },
    gate: { verdict: 'ok' },
  }, { taskId: 'left' }, mini)
  assert.equal(leftover.result.status, 'AWAITING_HUMAN_gate')
})

test('#118 测试注入 ROUTE_HALTED 同样翻译为 WAITING_HUMAN', async () => {
  const { result } = await runHd({ 执行: workOk }, {
    injectHalt: { status: 'ROUTE_HALTED', node: 'work', reason: 'HUMAN_DECISION' },
  })
  assert.equal(result.status, 'WAITING_HUMAN')
  assert.equal(result.reason, 'ESCALATED_DECISION')
  assert.equal(result.node, 'work')
})

test('#118 新模式 outcomePath 命中 $human-decision 翻译为 WAITING_HUMAN（不靠 injectHalt）', async () => {
  const { result } = await runHd({
    intake: { go: 'NEXT' },
    execute: { status: 'DONE' },
    evaluate: { verdict: 'CONFIRM', completion_type: 'pending' },
  }, { taskId: 'hd-outcome' }, outcomeHd)
  assert.equal(result.status, 'WAITING_HUMAN')
  assert.equal(result.reason, 'ESCALATED_DECISION')
  assert.equal(result.node, 'evaluate')
  assert.equal(result.results.evaluate.verdict, 'CONFIRM')
  for (const key of HD_PACKAGE_REQUIRED) {
    assert.ok(result.decision_package && result.decision_package[key], 'Package 缺 ' + key)
  }
  assert.ok(result.decision_package.options.some((o) => o.id === 'USER_ACCEPTED'))
  assert.equal(result.control_event.record_kind, 'DECISION')
  assert.equal(result.control_event.user_choice, null)
  assert.equal(result.control_event.triggering_node_outcome.verdict, 'CONFIRM')
})

test('#119 选择写入追加控制面事件且不改原 decision_id', async () => {
  const halt = await runHd({ 执行: workOk })
  const requestId = halt.result.decision_id
  assert.equal(halt.result.control_event.user_choice, null)
  const r2 = await runHd({ 收口: { done: true } }, {
    decision_id: requestId,
    user_choice: 'STOP',
    results: halt.result.results,
  })
  assert.equal(r2.result.status, 'STOPPED')
  const ev = r2.result.control_event
  assert.ok(ev, '续跑须追加选择事件')
  for (const key of HD_EVENT_FIELDS) assert.ok(key in ev, '选择事件缺 ' + key)
  assert.equal(ev.record_kind, 'DECISION')
  assert.equal(ev.decision_id, requestId, 'decision_id 不可覆盖')
  assert.equal(ev.user_choice, 'STOP')
  assert.ok(ev.impact)
  assert.equal(ev.subsequent_path, 'STOP')
  assert.equal(halt.result.control_event.user_choice, null, '请求事件不得被改写')
  assert.equal(halt.result.control_event.decision_id, requestId)
})

test('#119 STOP 后本 Run 不再执行；不派生新 Run', async () => {
  const halt = await runHd({ 执行: workOk })
  const r2 = await runHd({ 收口: { done: true } }, {
    entry: halt.result.node,
    decision_id: halt.result.decision_id,
    user_choice: 'STOP',
    results: halt.result.results,
  })
  assert.equal(r2.result.status, 'STOPPED')
  assert.equal(r2.result.decision_id, halt.result.decision_id)
  assert.deepEqual(r2.result.results.work.status, 'confirm')
  assert.ok(!r2.agentCalls.some((c) => c.label === '收口'), 'STOP 不得续跑下游')
})

test('#119 USER_ACCEPTED 完成且不把原 Outcome 改成 PASS', async () => {
  const halt = await runHd({ 执行: workOk })
  const r2 = await runHd({ 收口: { done: true } }, {
    entry: halt.result.node,
    decision_id: halt.result.decision_id,
    user_choice: 'USER_ACCEPTED',
    results: halt.result.results,
  })
  assert.equal(r2.result.status, 'DONE')
  assert.equal(r2.result.results.work.status, 'confirm')
  assert.notEqual(r2.result.results.work.status, 'PASS')
  assert.ok(!r2.agentCalls.some((c) => c.label === '收口'))
})

test('#119 ADD_BUDGET 保留原 Outcome 并从被拦边续跑', async () => {
  const halt = await runHd({ 执行: workOk }, {
    injectHalt: {
      node: 'work',
      reason: 'MAX_ROUNDS_REACHED',
      blocked_edge: { from: 'work', to: 'finish', on: 'success' },
    },
  })
  assert.equal(halt.result.status, 'WAITING_HUMAN')
  assert.equal(halt.result.reason, 'MAX_ROUNDS_REACHED')
  assert.equal(halt.result.results.work.status, 'confirm')
  assert.ok(HD_CONTROL_RESULTS.every((id) => halt.result.decision_package.options.some((o) => o.id === id)))
  const r2 = await runHd({ 收口: { done: true } }, {
    entry: 'work',
    decision_id: halt.result.decision_id,
    user_choice: 'ADD_BUDGET',
    results: halt.result.results,
    blocked_edge: halt.result.blocked_edge,
  })
  assert.equal(r2.result.status, 'DONE')
  assert.equal(r2.result.results.work.status, 'confirm')
  assert.deepEqual(r2.agentCalls.map((c) => c.label), ['收口'])
  assert.equal(r2.result.control_event.user_choice, 'ADD_BUDGET')
  assert.equal(r2.result.control_event.subsequent_path, 'finish')
  assert.equal(r2.result.control_event.decision_id, halt.result.decision_id)
})

test('#121 业务 Result 沿蓝图 $human-decision 出边续跑且不改写原 Outcome', async () => {
  const halt = await runHd({ 执行: workOk })
  assert.equal(halt.result.status, 'WAITING_HUMAN')
  const requestEvent = halt.result.control_event
  const r2 = await runHd({ 收口: { done: true } }, {
    entry: halt.result.node,
    decision_id: halt.result.decision_id,
    user_choice: 'SHIP',
    results: halt.result.results,
  })
  assert.equal(r2.result.status, 'DONE')
  assert.equal(r2.result.decision_id, halt.result.decision_id)
  assert.equal(r2.result.user_choice, 'SHIP')
  assert.equal(r2.result.results.work.status, 'confirm', '触发时 Node Outcome 不得改写')
  assert.notEqual(r2.result.results.work.status, 'PASS')
  assert.equal(r2.result.results.finish.done, true)
  assert.deepEqual(r2.agentCalls.map((c) => c.label), ['收口'], '不得重跑触发节点')
  const ev = r2.result.control_event
  assert.ok(ev, '须追加选择事件')
  assert.equal(ev.decision_id, halt.result.decision_id)
  assert.equal(ev.user_choice, 'SHIP')
  assert.equal(ev.subsequent_path, 'finish')
  assert.equal(requestEvent.user_choice, null, '原请求事件不得覆盖')
})

test('#121 无对应出边的业务选择被拒绝并保持等待', async () => {
  const halt = await runHd({ 执行: workOk })
  const r2 = await runHd({ 收口: { done: true } }, {
    entry: halt.result.node,
    decision_id: halt.result.decision_id,
    user_choice: 'HOLD',
    results: halt.result.results,
  })
  assert.equal(r2.result.status, 'WAITING_HUMAN', '无出边须保持等待')
  assert.equal(r2.result.decision_id, halt.result.decision_id, 'decision_id 不可覆盖')
  assert.equal(r2.result.results.work.status, 'confirm')
  assert.ok(!r2.agentCalls.some((c) => c.label === '收口'), '拒绝选择不得续跑下游')
  assert.equal(r2.result.control_event.user_choice, null)
  assert.equal(r2.result.rejected_choice, 'HOLD')
})
