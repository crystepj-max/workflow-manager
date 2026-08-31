// cwf-checkpoint.mjs 纯逻辑测试（git 状态注入）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeCheckpoint, verifyRerunEvidence } from '../cwf-checkpoint.mjs'

const run = {
  run_id: 'r', issue_or_task_identity: '#1', workspace_id: 'w',
  repository: 'repo', base_ref: 'main', base_commit: 'abc',
  work_branch: 'b', current_head: 'h', stage: 'human_acceptance', attempt: 1,
}

test('target 未前进 → still_valid', () => {
  const ckpt = computeCheckpoint(run, { targetHead: 'abc' })
  assert.equal(ckpt.target_advanced, false)
  assert.equal(ckpt.proofs_state, 'still_valid')
  assert.equal(ckpt.ok, true)
  assert.equal(ckpt.target_head_at_check, 'abc')
})

test('target 已前进 → 需要重跑 Proof', () => {
  const ckpt = computeCheckpoint(run, { targetHead: 'def' })
  assert.equal(ckpt.target_advanced, true)
  assert.equal(ckpt.ok, false)
  assert.match(ckpt.hint, /重跑/)
})

test('verifyRerunEvidence：sync 与证据绑定逐项判定', () => {
  const goodProofs = {
    review_proof: { record_type: 'review_proof', run: { attempt: 2 }, payload: { verified_head: 'head2' } },
    test_proof: { record_type: 'test_proof', run: { attempt: 2 }, payload: { verified_head: 'head2' } },
  }
  // 全部满足 → 无错
  assert.deepEqual(verifyRerunEvidence({ synced: true, currentHead: 'head2', attempt: 2, proofs: goodProofs }), [])
  // 未 sync → 拒绝
  assert.ok(verifyRerunEvidence({ synced: false, currentHead: 'head2', attempt: 2, proofs: goodProofs }).length > 0)
  // 证据过期（旧 HEAD）→ 拒绝
  const stale = { ...goodProofs, test_proof: { record_type: 'test_proof', run: { attempt: 2 }, payload: { verified_head: 'head1' } } }
  assert.ok(verifyRerunEvidence({ synced: true, currentHead: 'head2', attempt: 2, proofs: stale }).some(e => e.includes('证据过期')))
  // attempt 错位 → 拒绝
  const wrongAttempt = { ...goodProofs, review_proof: { record_type: 'review_proof', run: { attempt: 1 }, payload: { verified_head: 'head2' } } }
  assert.ok(verifyRerunEvidence({ synced: true, currentHead: 'head2', attempt: 2, proofs: wrongAttempt }).some(e => e.includes('先 reverify')))
  // 缺记录 → 拒绝
  assert.ok(verifyRerunEvidence({ synced: true, currentHead: 'head2', attempt: 2, proofs: { review_proof: null, test_proof: null } }).length > 0)
  // index 指向错误类型（review/test 指向同一条 review 记录）→ 拒绝
  const wrongType = {
    review_proof: { record_type: 'review_proof', run: { attempt: 2 }, payload: { verified_head: 'head2' } },
    test_proof: { record_type: 'review_proof', run: { attempt: 2 }, payload: { verified_head: 'head2' } },
  }
  assert.ok(verifyRerunEvidence({ synced: true, currentHead: 'head2', attempt: 2, proofs: wrongType }).some(e => e.includes('类型不符')))
})
