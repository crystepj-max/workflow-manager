// LOC-028：人工接受完成必须具备真实决定与版本来源
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { compileBlueprint } from '../generate.mjs'
import { runGeneratedScript, makeAgentScript } from './helpers/runtime-harness.mjs'
import { createDecisionRef, verifyDecisionRef, ACTOR_SOURCE_HOST } from '../human-completion.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const optimizeBp = JSON.parse(readFileSync(path.join(here, '../../templates/wf-optimize.json'), 'utf8'))
const constructionBp = JSON.parse(readFileSync(path.join(here, '../../templates/wf-construction-full-feature.json'), 'utf8'))

const runBp = (bp, table, args = {}) => {
  const { script } = compileBlueprint(bp)
  return runGeneratedScript(script, { args: { taskId: args.taskId || 'hc-task', ...args }, agent: makeAgentScript(table) })
}

const hostRef = (taskId, decisionId, choice, candidate_ref = null) => createDecisionRef({
  decision_id: decisionId,
  logical_run_id: taskId,
  checkpoint_id: decisionId,
  candidate_ref,
  choice,
})

const cand = (digest) => ({
  kind: 'git',
  resource_id: 'repo',
  scope_manifest: [],
  version: { content_sha256: digest, head: 'abc' },
})

const CAND = 'human-completion-candidate'
const constructionTable = (closeoutFollowups = 'note') => ({
  '实施前检查': { route: 'PASS', summary: 'ok', blockers: '无', baseline_version: 'V1' },
  '开发': { route: 'READY', summary: 'ok', self_check: 'ok' },
  '收敛审查': { route: 'APPROVE', verdict: 'APPROVE', summary: 'ok', blockers: '', verified_branch: 'dev/ac03', verified_head: 'h1', candidate_sha256: CAND },
  '测试': { route: 'PASS', result: 'PASSED', reason: 'ok', evidence: 'e', verified_branch: 'dev/ac03', verified_head: 'h1', candidate_sha256: CAND },
  'UAT 准备': { route: 'READY_FOR_HUMAN', summary_for_human: '待验收', why: 'w', current_state: 's', details: 'd' },
  '收口': { status: 'DELIVERED', completion_type: 'DELIVERED', summary: 'done', followups: closeoutFollowups },
})

test('decision_ref 内核：伪造 actor_source 拒绝', () => {
  assert.throws(() => createDecisionRef({
    decision_id: 'd1',
    logical_run_id: 'run-1',
    checkpoint_id: 'd1',
    candidate_ref: null,
    choice: 'ACCEPT',
    actor_source: 'model_output',
  }), /actor_source/)
  assert.equal(verifyDecisionRef(hostRef('run-1', 'd1', 'ACCEPT'), { logical_run_id: 'run-1', decision_id: 'd1', choice: 'ACCEPT' }).ok, true)
  assert.equal(verifyDecisionRef(hostRef('run-1', 'd1', 'ACCEPT'), { logical_run_id: 'other' }).ok, false)
})

test('AC-01：无决定 / 其他 Run / 旧候选 / 模型 actor 均不能 USER_ACCEPTED 收口', async () => {
  const halt = await runBp(optimizeBp, {
    目标确认: { route: 'READY', summary: 's', contract_digest: 'c1' },
    执行: { route: 'READY', summary: 's', changed: 'a.md' },
    评估: { route: 'CONFIRM', summary: 's', contract_digest: 'c1', gaps: '' },
  }, { taskId: 'ac01' })
  assert.equal(halt.result.status, 'WAITING_HUMAN')

  const noRef = await runBp(optimizeBp, {
    收口: { status: 'DELIVERED', completion_type: 'USER_ACCEPTED', summary: 'x', followups: '' },
  }, { taskId: 'ac01', decision_id: halt.result.decision_id, user_choice: 'ACCEPT', results: halt.result.results })
  assert.equal(noRef.result.completion, null)

  const otherRun = await runBp(optimizeBp, {
    收口: { status: 'DELIVERED', completion_type: 'USER_ACCEPTED', summary: 'x', followups: '' },
  }, {
    taskId: 'ac01',
    decision_id: halt.result.decision_id,
    user_choice: 'ACCEPT',
    results: halt.result.results,
    decision_ref: hostRef('other-run', halt.result.decision_id, 'ACCEPT'),
  })
  assert.equal(otherRun.result.completion, null)

  const staleCand = await runBp(optimizeBp, {
    收口: { status: 'DELIVERED', completion_type: 'USER_ACCEPTED', summary: 'x', followups: '' },
  }, {
    taskId: 'ac01',
    decision_id: halt.result.decision_id,
    user_choice: 'ACCEPT',
    results: halt.result.results,
    workspace_capability: 'cap',
    candidate_ref: cand('live-digest'),
    decision_ref: hostRef('ac01', halt.result.decision_id, 'ACCEPT', cand('old-digest')),
  })
  assert.equal(staleCand.result.completion, null)

  const forged = await runBp(optimizeBp, {
    收口: { status: 'DELIVERED', completion_type: 'USER_ACCEPTED', summary: 'x', followups: '' },
  }, {
    taskId: 'ac01',
    decision_id: halt.result.decision_id,
    user_choice: 'ACCEPT',
    results: halt.result.results,
    decision_ref: {
      decision_id: halt.result.decision_id,
      logical_run_id: 'ac01',
      checkpoint_id: halt.result.decision_id,
      candidate_ref: null,
      choice: 'ACCEPT',
      actor_source: 'model_self_report',
      decided_at: new Date().toISOString(),
    },
  })
  assert.equal(forged.result.completion, null)
})

test('AC-02：PASS 自动 EVALUATION_PASSED；真实 ACCEPT + decision_ref → USER_ACCEPTED', async () => {
  const pass = await runBp(optimizeBp, {
    目标确认: { route: 'READY', summary: 's', contract_digest: 'c1' },
    执行: { route: 'READY', summary: 's', changed: 'a.md' },
    评估: { route: 'PASS', summary: 's', contract_digest: 'c1', gaps: '' },
    收口: { status: 'DELIVERED', completion_type: 'EVALUATION_PASSED', summary: 'x', followups: '' },
  }, { taskId: 'ac02-pass' })
  assert.equal(pass.result.completion && pass.result.completion.type, 'EVALUATION_PASSED')

  const halt = await runBp(optimizeBp, {
    目标确认: { route: 'READY', summary: 's', contract_digest: 'c1' },
    执行: { route: 'READY', summary: 's', changed: 'a.md' },
    评估: { route: 'CONFIRM', summary: 's', contract_digest: 'c1', gaps: '' },
  }, { taskId: 'ac02-accept' })
  const accept = await runBp(optimizeBp, {
    收口: { status: 'DELIVERED', completion_type: 'USER_ACCEPTED', summary: 'x', followups: '' },
  }, {
    taskId: 'ac02-accept',
    decision_id: halt.result.decision_id,
    user_choice: 'ACCEPT',
    results: halt.result.results,
    decision_ref: hostRef('ac02-accept', halt.result.decision_id, 'ACCEPT'),
  })
  assert.equal(accept.result.completion && accept.result.completion.type, 'USER_ACCEPTED')
})

test('AC-03：建设三态走原定路径；USER_ACCEPTED 控制项被拒绝', async () => {
  const table = constructionTable('note')
  const halt = await runBp(constructionBp, table, { taskId: 'ac03', work_branch: 'dev/ac03' })
  assert.equal(halt.result.status, 'WAITING_HUMAN')
  assert.equal(halt.result.node, 'uat')
  assert.ok(!halt.result.decision_package.options.some((o) => o.id === 'USER_ACCEPTED'))

  const bypass = await runBp(constructionBp, table, {
    taskId: 'ac03',
    work_branch: 'dev/ac03',
    decision_id: halt.result.decision_id,
    user_choice: 'USER_ACCEPTED',
    results: halt.result.results,
  })
  assert.equal(bypass.result.status, 'WAITING_HUMAN')
  assert.equal(bypass.result.rejected_choice, 'USER_ACCEPTED')

  const reject = await runBp(constructionBp, {
    ...table,
    '开发': { route: 'READY', summary: 'fix', self_check: 'ok' },
  }, {
    taskId: 'ac03',
    work_branch: 'dev/ac03',
    decision_id: halt.result.decision_id,
    user_choice: 'REJECT',
    results: halt.result.results,
    decision_ref: hostRef('ac03', halt.result.decision_id, 'REJECT'),
  })
  assert.equal(reject.agentCalls.some((c) => c.label === '开发'), true)

  const halt2 = await runBp(constructionBp, table, { taskId: 'ac03b', work_branch: 'dev/ac03' })
  const conditional = await runBp(constructionBp, table, {
    taskId: 'ac03b',
    work_branch: 'dev/ac03',
    decision_id: halt2.result.decision_id,
    user_choice: 'CONDITIONAL_PASS',
    results: halt2.result.results,
    decision_ref: hostRef('ac03b', halt2.result.decision_id, 'CONDITIONAL_PASS'),
  })
  assert.equal(conditional.result.status, 'DONE')
  assert.equal(conditional.result.completion && conditional.result.completion.type, 'DELIVERED')
  assert.equal(conditional.result.results.closeout.followups, 'note')
})

test('AC-04：同一决定重复恢复不重复收口；候选变化后拒绝', async () => {
  const halt = await runBp(optimizeBp, {
    目标确认: { route: 'READY', summary: 's', contract_digest: 'c1' },
    执行: { route: 'READY', summary: 's', changed: 'a.md' },
    评估: { route: 'CONFIRM', summary: 's', contract_digest: 'c1', gaps: '' },
  }, { taskId: 'ac04' })
  const ref = hostRef('ac04', halt.result.decision_id, 'ACCEPT', cand('v1'))
  const first = await runBp(optimizeBp, {
    收口: { status: 'DELIVERED', completion_type: 'USER_ACCEPTED', summary: 'x', followups: '' },
  }, {
    taskId: 'ac04',
    decision_id: halt.result.decision_id,
    user_choice: 'ACCEPT',
    results: halt.result.results,
    decision_ref: ref,
    consumed_decisions: {},
  })
  assert.equal(first.result.completion && first.result.completion.type, 'USER_ACCEPTED')
  assert.ok(first.result.consumed_decision)

  const replay = await runBp(optimizeBp, {
    收口: { status: 'DELIVERED', completion_type: 'USER_ACCEPTED', summary: 'x', followups: '' },
  }, {
    taskId: 'ac04',
    decision_id: halt.result.decision_id,
    user_choice: 'ACCEPT',
    results: halt.result.results,
    decision_ref: ref,
    consumed_decisions: { [halt.result.decision_id]: first.result.consumed_decision },
  })
  assert.equal(replay.result.idempotent_replay, true)
  assert.equal(replay.agentCalls.length, 0)

  const changed = await runBp(optimizeBp, {
    收口: { status: 'DELIVERED', completion_type: 'USER_ACCEPTED', summary: 'x', followups: '' },
  }, {
    taskId: 'ac04',
    decision_id: halt.result.decision_id,
    user_choice: 'ACCEPT',
    results: halt.result.results,
    decision_ref: hostRef('ac04', halt.result.decision_id, 'ACCEPT', cand('v2')),
    consumed_decisions: { [halt.result.decision_id]: first.result.consumed_decision },
  })
  assert.equal(changed.result.status, 'ERROR')
  assert.match(String(changed.result.detail || ''), /变化/)
})
