// cwf-checkpoint.mjs 纯逻辑测试（git 状态注入）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeCheckpoint } from '../cwf-checkpoint.mjs'

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
