// cwf-run-init.mjs 纯逻辑测试（分支命名净化与唯一性）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { branchName } from '../cwf-run-init.mjs'

test('branchName：run_id 净化后进入分支名', () => {
  assert.equal(branchName('cwf-123-01'), 'dev-cwf-123-01')
  assert.equal(branchName('CWF_105 Bootstrap'), 'dev-cwf-105-bootstrap')
  assert.equal(branchName('cwf--123..01'), 'dev-cwf-123-01')
  assert.equal(branchName('-cwf-9-'), 'dev-cwf-9')
})

test('branchName：同 issue 的不同 Run 分支不撞名', () => {
  assert.notEqual(branchName('cwf-123-01'), branchName('cwf-123-02'))
})
