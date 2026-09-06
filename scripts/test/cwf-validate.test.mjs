// cwf-validate.mjs 测试：以仓库契约 schema + 示例链为正例，附代表性负例
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateRecord } from '../cwf-validate.mjs'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const schemaDir = join(repo, 'docs/design/construction-workflow')
const schema = JSON.parse(readFileSync(join(schemaDir, 'handoff.schema.json'), 'utf-8'))
const examplesDir = join(schemaDir, 'examples')

function rec(recordType, payload, stage) {
  return {
    record_type: recordType,
    record_version: schema.properties.record_version.const,
    created_at: '2026-08-30T08:00:00Z',
    produced_by: 'test',
    run: {
      run_id: 'r', issue_or_task_identity: '#1', workspace_id: 'w',
      repository: 'repo', base_ref: 'main', base_commit: 'abc',
      work_branch: 'b', current_head: 'h', stage, attempt: 1,
    },
    payload,
  }
}

const ckpt = { target_ref: 'main', target_head_at_check: 'abc', target_advanced: false, proofs_state: 'still_valid' }
const assembled = {
  requirements_baseline_ref: 'r', design_package_ref: 'd', dev_handoff_ref: 'v',
  review_proof_ref: 'rp', test_proof_ref: 'tp', integration_checkpoint: ckpt,
}
const decisionReq = { question: 'q', options: [{ name: 'a', tradeoffs: 't' }], recommendation: 'a' }
const decisionDone = { question: 'q', options: [{ name: 'a', tradeoffs: 't' }], chosen: 'a', rationale: 'r', decided_by: 'x', decided_at: '2026-08-30T08:00:00Z' }

test('契约示例链全部通过校验', () => {
  for (const f of readdirSync(examplesDir).filter(f => f.endsWith('.json'))) {
    const errors = validateRecord(schema, JSON.parse(readFileSync(join(examplesDir, f), 'utf-8')))
    assert.equal(errors.length, 0, `${f}: ${errors.join('; ')}`)
  }
})

test('负例：关键约束类各拒一例', () => {
  const bad = [
    // record_type 与 stage 绑定
    rec('review_proof', { verdict: 'approve', findings: [], verified_branch: 'b', verified_head: 'h', independent_session: true }, 'dev'),
    // pass 要求非空全通过映射
    rec('test_proof', { verdict: 'pass', acceptance_mapping: [], verified_branch: 'b', verified_head: 'h', independent_session: true }, 'test'),
    // blocked 要求理由
    rec('test_proof', { verdict: 'blocked', acceptance_mapping: [], verified_branch: 'b', verified_head: 'h', independent_session: true }, 'test'),
    // request_changes 要求 finding
    rec('review_proof', { verdict: 'request_changes', findings: [], verified_branch: 'b', verified_head: 'h', independent_session: true }, 'review'),
    // 待决/已决字段互斥
    rec('acceptance_package', { status: 'awaiting_decision', assembled, decision: 'accept', decided_by: 'x', decided_at: '2026-08-30T08:00:00Z' }, 'human_acceptance'),
    // reject 必填 feedback + 根因
    rec('acceptance_package', { status: 'decided', assembled, decision: 'reject', decided_by: 'x', decided_at: '2026-08-30T08:00:00Z', verified_branch: 'b', verified_head: 'h' }, 'human_acceptance'),
    // confirmed 基线禁止残留 gaps
    rec('requirements_baseline', { goal: 'g', scope: { include: ['a'], exclude: ['b'] }, acceptance: ['x'], gaps: [{ element: 'e', suggestion: 's' }], status: 'confirmed', outcome: 'baseline_ready', baseline_revision: 'v1', human_confirmation: { confirmed_by: 'x', confirmed_at: '2026-08-30T08:00:00Z' } }, 'requirements'),
    // design 未决门缺待决包
    rec('design_package', { summary: 's', outcome: 'decision_required', decision_required: true, decision_required_reasons: ['r'] }, 'design'),
    // 已决 gate 必须保留 decision_request
    rec('design_package', { summary: 's', outcome: 'package_ready', decision_required: true, decision_required_reasons: ['r'], decision: decisionDone }, 'design'),
    // closeout 缺集成标识
    rec('closeout_summary', { deliverables: [], integration: { checkpoint: 'c' }, acceptance_package_ref: 'ap', acceptance_outcome: 'accept', records_retained: true }, 'closeout'),
    // checkpoint target 已前进但未重跑
    rec('acceptance_package', { status: 'awaiting_decision', assembled: { ...assembled, integration_checkpoint: { target_ref: 'main', target_head_at_check: 'xyz', target_advanced: true, proofs_state: 'still_valid' } } }, 'human_acceptance'),
    // 空白 proof 绑定
    rec('review_proof', { verdict: 'approve', findings: [], verified_branch: 'b', verified_head: '  ', independent_session: true }, 'review'),
  ]
  for (const [i, record] of bad.entries()) {
    const errors = validateRecord(schema, record)
    assert.ok(errors.length > 0, `负例 #${i + 1} 应被拒但未拒`)
  }
})

test('正例探针：design 门两态翻转', () => {
  // 待决态（携带 decision_request，无 decision）
  const pending = rec('design_package', { summary: 's', outcome: 'decision_required', decision_required: true, decision_required_reasons: ['r'], decision_request: decisionReq }, 'design')
  assert.equal(validateRecord(schema, pending).length, 0)
  // 已决态（decision_request + decision 并存，outcome=package_ready）
  const resolved = rec('design_package', { summary: 's', outcome: 'package_ready', decision_required: true, decision_required_reasons: ['r'], decision_request: decisionReq, decision: decisionDone }, 'design')
  assert.equal(validateRecord(schema, resolved).length, 0)
})

test('正例探针：conditional_pass 有条件通过通道', () => {
  const cp = rec('acceptance_package', {
    status: 'decided', assembled, decision: 'conditional_pass', decided_by: 'x',
    decided_at: '2026-08-30T08:00:00Z', feedback: '优化意见：下次加批量清除', verified_branch: 'b', verified_head: 'h',
  }, 'human_acceptance')
  assert.equal(validateRecord(schema, cp).length, 0)
})

test('负例探针：user_accepted 已废弃', () => {
  const ua = rec('acceptance_package', {
    status: 'decided', assembled, decision: 'user_accepted', decided_by: 'x',
    decided_at: '2026-08-30T08:00:00Z', feedback: '旧语义', verified_branch: 'b', verified_head: 'h',
  }, 'human_acceptance')
  assert.ok(validateRecord(schema, ua).length > 0)
})
