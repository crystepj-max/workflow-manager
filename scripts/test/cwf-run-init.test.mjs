// cwf-run-init.mjs 纯逻辑测试（分支命名、run_id 安全、身份比对）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { branchName, assertRunIdSafe, findIdentityMismatch, parseBudget } from '../cwf-run-init.mjs'

test('branchName：run_id 直接进分支名（单射）', () => {
  assert.equal(branchName('cwf-123-01'), 'dev-cwf-123-01')
  assert.notEqual(branchName('cwf-123-01'), branchName('cwf-123-02'))
})

test('assertRunIdSafe：仅接受已净化的小写连字符形态', () => {
  assert.doesNotThrow(() => assertRunIdSafe('cwf-123-01'))
  assert.throws(() => assertRunIdSafe('team/run-1'), /非法 run_id/) // 路径分隔符
  assert.throws(() => assertRunIdSafe('..'), /非法 run_id/)         // 穿越
  assert.throws(() => assertRunIdSafe('../x'), /非法 run_id/)
  assert.throws(() => assertRunIdSafe('CWF_105 Bootstrap'), /非法 run_id/) // 大写/下划线/空格
  assert.throws(() => assertRunIdSafe('A_B'), /非法 run_id/)        // 与 a-b 防归一化碰撞
})

test('findIdentityMismatch：幂等复用前校验身份一致', () => {
  const stored = { issue_or_task_identity: '#123', base_ref: 'main', rollback_budget: 3 }
  const same = { issue_or_task_identity: '#123', base_ref: 'main', rollback_budget: 3 }
  assert.deepEqual(findIdentityMismatch(stored, same), [])
  assert.equal(findIdentityMismatch(stored, { ...same, issue_or_task_identity: '#124' }).length, 1)
  assert.equal(findIdentityMismatch(stored, { ...same, base_ref: 'dev' }).length, 1)
  assert.equal(findIdentityMismatch(stored, { ...same, rollback_budget: 5 }).length, 1)
})

test('parseBudget：完整非负整数校验', () => {
  assert.equal(parseBudget('3'), 3)
  assert.equal(parseBudget('0'), 0)
  assert.throws(() => parseBudget('nope'), /非法回退额度/)
  assert.throws(() => parseBudget('3junk'), /非法回退额度/)
  assert.throws(() => parseBudget('-1'), /非法回退额度/)
  assert.throws(() => parseBudget(''), /非法回退额度/)
})
