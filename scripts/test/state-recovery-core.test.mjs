// LOC-044 状态与恢复内核：单源规则与六类行为对照（纯 Node，无宿主 I/O）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCheckpointCompact,
  formatCheckpointLogLine,
  parseCheckpointLogLine,
  extractCheckpointFromLogs,
  checkpointToResumeFields,
  buildHumanWaitResume,
  buildPauseResumePayload,
  buildBlockedRunBody,
  canonicalStopFromResult,
  lifecycleForStatus,
  isHumanWaitStatus,
  isParkedHumanDecision,
} from '../state-recovery-core.cjs'
import { compileBlueprint } from '../generate.mjs'
import { runGeneratedScript, makeAgentScript } from './helpers/runtime-harness.mjs'

const sampleState = {
  entry: 'review',
  results: { dev: { route: 'READY' } },
  history: [{ round: 1, stage: 'dev', from: 'dev', to: 'review' }],
  round: 1,
  feedback: 'fix tests',
  budgetUsed: 1,
  maxRounds: 3,
  decisionSeq: 2,
  technicalBudget: { u: 2, g: [], m: 1000, mg: 0, p: { max_attempts: 3 } },
}

test('AC-01：检查点紧凑形往返一致（生成器字段 ↔ 宿主解析）', () => {
  const compact = buildCheckpointCompact(sampleState)
  const line = formatCheckpointLogLine(compact)
  assert.match(line, /^\[pw-ckpt\]/)
  const parsed = parseCheckpointLogLine(line)
  assert.deepEqual(parsed, {
    entry: 'review',
    results: sampleState.results,
    history: sampleState.history,
    round: 1,
    feedback: 'fix tests',
    budgetUsed: 1,
    maxRounds: 3,
    decisionSeq: 2,
    degraded: false,
    technical_budget: sampleState.technicalBudget,
  })
})

test('S01/S06：extractCheckpointFromLogs 跳过 $end 并向前找真实检查点', () => {
  const good = formatCheckpointLogLine(buildCheckpointCompact({ entry: 'dev', results: {}, history: [], round: 0, budgetUsed: 0, maxRounds: 3, decisionSeq: 0 }))
  const end = formatCheckpointLogLine(buildCheckpointCompact({ entry: '$end', results: {}, history: [], round: 0, budgetUsed: 0, maxRounds: 3, decisionSeq: 0 }))
  const ck = extractCheckpointFromLogs(['noise', end, good])
  assert.equal(ck.entry, 'dev')
  assert.equal(ck.degraded, false)
})

test('S06：损坏/缺失检查点诚实降级', () => {
  assert.equal(extractCheckpointFromLogs(['bad [pw-ckpt]{']).degraded, true)
  assert.equal(extractCheckpointFromLogs([]).degraded, true)
})

test('S03：人工等待 resume 载荷字段与检查点映射一致', () => {
  const resume = buildHumanWaitResume({
    entry: 'review',
    decisionId: 't:review:1:2',
    round: 1,
    history: sampleState.history,
    feedback: 'fix tests',
    results: sampleState.results,
    blockedEdge: null,
    budgetUsed: 1,
    maxRounds: 3,
    decisionSeq: 2,
    technicalBudget: sampleState.technicalBudget,
  })
  assert.equal(resume.entry, 'review')
  assert.equal(resume.decision_id, 't:review:1:2')
  assert.equal(resume.startRound, 1)
  assert.deepEqual(resume.technical_budget, sampleState.technicalBudget)
})

test('S05：暂停恢复载荷构造（Guidance + 待生效基线修订）', () => {
  const built = buildPauseResumePayload({
    pauseResume: {
      entry: 'dev',
      results: { dev: { route: 'READY' } },
      history: [],
      round: 0,
      feedback: '',
      budgetUsed: 0,
      maxRounds: 3,
      decisionSeq: 0,
    },
    baselineRevisions: [{ revision: 2, text: 'new scope' }],
    baselineAppliedUpto: 1,
    rev1Entry: 'preflight',
    guidance: [{ mode: 'coach', text: 'focus on tests' }],
    extraArgs: { evaluation_baseline_version: 1 },
  })
  assert.equal(built.args.entry, 'preflight')
  assert.equal(built.pendingRebase, true)
  assert.match(built.args.guidance_text, /focus on tests/)
  assert.equal(built.args.baseline_amendment, 'new scope')
})

test('S02/S04：blockedRun 体与生命周期映射', () => {
  const body = buildBlockedRunBody({
    termination: { business_outcome: 'RETURN_DEV', lifecycle: 'BLOCKED', reason_code: 'AUTO_REWORK_EXHAUSTED', resumable: true, resume_node: 'dev' },
    failedNode: 'review',
    lastOutcome: { route: 'RETURN_DEV' },
    blockedExtra: { rounds_used: 2, max_rounds: 2 },
    taskId: 't1',
    round: 2,
    results: {},
    history: [],
    budgetUsed: 2,
    maxRounds: 2,
  })
  assert.equal(body.status, 'BLOCKED')
  assert.equal(body.blocked.reason_code, 'AUTO_REWORK_EXHAUSTED')
  assert.equal(lifecycleForStatus('BLOCKED', 'completed'), 'BLOCKED')
  assert.equal(lifecycleForStatus('DONE', 'completed'), 'COMPLETED')
})

test('S01：canonicalStop 与 isHumanWait 口径', () => {
  assert.equal(canonicalStopFromResult({ value: { status: 'WAITING_HUMAN' } }), 'WAITING_HUMAN')
  assert.equal(canonicalStopFromResult({ value: { status: 'NOPE' } }), '')
  assert.equal(isHumanWaitStatus('AWAITING_HUMAN_dev'), true)
  assert.ok(isParkedHumanDecision({ status: 'WAITING_HUMAN', decision_id: 'x', decision_package: {} }))
})

test('生成脚本内联内核：pwCk 行格式与内核 parseCheckpointLogLine 一致', async () => {
  const bp = {
    id: 'ck-inline', displayName: 'ck', description: '', entry: 'dev',
    control: { maxRounds: 1 }, heteroCheck: 'off',
    bindings: { models: { dev: { provider: 'p', model: 'm' }, review: { provider: 'p', model: 'm' } } },
    nodes: [
      { id: 'dev', profile: 'dev', label: '开发', goal: 'g', output: { schema: { type: 'object', properties: { route: { type: 'string', enum: ['READY'] } }, required: ['route'], additionalProperties: false }, outcomePath: '$.route' } },
      { id: 'review', profile: 'review', label: '审查', goal: 'g', output: { schema: { type: 'object', properties: { route: { type: 'string', enum: ['APPROVE'] } }, required: ['route'], additionalProperties: false }, outcomePath: '$.route' } },
    ],
    edges: [
      { from: 'dev', to: 'review', outcome: 'READY' },
      { from: 'review', to: '$end', outcome: 'APPROVE' },
    ],
  }
  const { script } = compileBlueprint(bp)
  assert.match(script, /function extractCheckpointFromLogs/)
  assert.match(script, /function buildBlockedRunBody/)
  const { logs } = await runGeneratedScript(script, {
    args: { taskId: 'ck-inline' },
    agent: makeAgentScript({ 开发: { route: 'READY' }, 审查: { route: 'APPROVE' } }),
  })
  const ck = extractCheckpointFromLogs(logs)
  assert.equal(ck.entry, 'review')
  assert.equal(ck.results.dev.route, 'READY')
})
