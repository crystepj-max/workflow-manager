// cwf-run-init.mjs 纯逻辑测试（分支命名净化与唯一性）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { branchName, assertRunIdSafe, findIdentityMismatch } from '../cwf-run-init.mjs'

test('branchName：run_id 净化后进入分支名', () => {
  assert.equal(branchName('cwf-123-01'), 'dev-cwf-123-01')
  assert.equal(branchName('CWF_105 Bootstrap'), 'dev-cwf-105-bootstrap')
  assert.equal(branchName('cwf--123..01'), 'dev-cwf-123-01')
  assert.equal(branchName('-cwf-9-'), 'dev-cwf-9')
})

test('branchName：同 issue 的不同 Run 分支不撞名', () => {
  assert.notEqual(branchName('cwf-123-01'), branchName('cwf-123-02'))
})

test('assertRunIdSafe：拒绝路径分隔符与穿越', () => {
  assert.doesNotThrow(() => assertRunIdSafe('cwf-123-01'))
  assert.throws(() => assertRunIdSafe('team/run-1'), /非法 run_id/)
  assert.throws(() => assertRunIdSafe('..'), /非法 run_id/)
  assert.throws(() => assertRunIdSafe('../x'), /非法 run_id/)
})

test('findIdentityMismatch：幂等复用前校验身份一致', () => {
  const stored = { issue_or_task_identity: '#123', base_ref: 'main', rollback_budget: 3 }
  const same = { issue_or_task_identity: '#123', base_ref: 'main', rollback_budget: 3 }
  assert.deepEqual(findIdentityMismatch(stored, same), [])
  const diffIssue = { ...same, issue_or_task_identity: '#124' }
  assert.equal(findIdentityMismatch(stored, diffIssue).length, 1)
  const diffBase = { ...same, base_ref: 'dev' }
  assert.equal(findIdentityMismatch(stored, diffBase).length, 1)
  const diffBudget = { ...same, rollback_budget: 5 }
  assert.equal(findIdentityMismatch(stored, diffBudget).length, 1)
})
