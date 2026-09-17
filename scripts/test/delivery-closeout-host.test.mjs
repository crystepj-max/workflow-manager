// 收口事实整理与授权交付动作分离（LOC-037 / WR-014）验收
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  gatherFacts, planActions, executeCloseout, resolveTargetAdapter, setGitRunner,
} from '../delivery-closeout-host.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const HOST = join(here, '..', 'delivery-closeout-host.mjs')

const opsDir = () => mkdtempSync(join(tmpdir(), 'vwf-delivery-'))

function cli(cmd, input) {
  const stdout = execFileSync(process.execPath, [HOST, cmd, JSON.stringify(input)], { encoding: 'utf8' })
  return JSON.parse(stdout)
}

const BASE = {
  run_id: 'loc-037-test',
  candidate_ref: { workspace_path: '/tmp/non-git-docs', head: 'abc123', branch: null, digest: 'sha256-abc' },
  acceptance: { decision: 'accept', summary: 'UAT 通过' },
  reports: [{ name: 'uat-card', path: '.agent-runs/loc-037/uat-card.md' }],
}

test('D1 非 Git 本地交付：required_actions 为空，无 Git 调用，可 DELIVERED（UAT-01 / AC-01）', () => {
  const dir = opsDir()
  const gitLog = []
  setGitRunner((args) => { gitLog.push(args); return { ok: false } })
  const planned = planActions({ ...BASE, delivery_scope: 'non-git' })
  assert.equal(planned.action_plan.required_actions.length, 0)
  assert.equal(planned.action_plan.target_adapter, 'local')
  const result = executeCloseout({
    ...BASE,
    delivery_scope: 'non-git',
    operations_dir: dir,
    include_cleanup: false,
  })
  assert.equal(result.status, 'DELIVERED')
  assert.equal(result.delivery_status, 'DELIVERED')
  assert.equal(result.git_calls, 0)
  assert.ok(result.delivery_report.proofs.length >= 1)
  assert.equal(gitLog.length, 0, '非 Git 不调用 git')
  rmSync(dir, { recursive: true, force: true })
})

test('D2 有效授权不重问；缺失授权先交付事实再等待（UAT-02 / AC-02）', () => {
  const dir = opsDir()
  setGitRunner((args) => {
    if (args[0] === 'remote' && args[1] === 'get-url') return { ok: true, stdout: 'https://cnb.cool/owner/repo.git' }
    if (args[0] === 'config') return { ok: false }
    if (args[0] === 'rev-parse') return { ok: true, stdout: 'cnb/main' }
    return { ok: false }
  })
  const withAuth = executeCloseout({
    run_id: 'r-auth',
    delivery_scope: 'git',
    operations_dir: dir,
    candidate_ref: { workspace_path: '/repo', head: 'deadbeef', branch: 'dev-x' },
    authorization_ref: 'approval-2026-09-16#1',
    authorizations: [{ ref: 'approval-2026-09-16#1', scope: 'create-review:cnb/owner/repo', target: 'cnb/owner/repo', valid: true }],
    include_cleanup: false,
  })
  assert.equal(withAuth.status, 'DELIVERED')
  assert.equal(withAuth.action_results.length, 3)
  const second = executeCloseout({
    run_id: 'r-auth',
    delivery_scope: 'git',
    operations_dir: dir,
    candidate_ref: { workspace_path: '/repo', head: 'deadbeef', branch: 'dev-x' },
    authorization_ref: 'approval-2026-09-16#1',
    include_cleanup: false,
  })
  assert.equal(second.status, 'DELIVERED')
  assert.ok(second.action_results.every((r) => r.result.deduped === true || r.result.executed === false), '有效授权复用不重执行')
  const noAuth = executeCloseout({
    run_id: 'r-noauth',
    delivery_scope: 'git',
    operations_dir: dir,
    candidate_ref: { workspace_path: '/repo', head: 'beef', branch: 'dev-y' },
    authorizations: [],
    include_cleanup: false,
  })
  assert.equal(noAuth.status, 'AWAITING_AUTHORIZATION')
  assert.equal(noAuth.delivery_status, 'NOT_DELIVERED')
  assert.ok(noAuth.delivery_report)
  assert.equal(noAuth.action_results.length, 0)
  rmSync(dir, { recursive: true, force: true })
})

test('D3 必要 merge 失败不得 DELIVERED；可选清理失败可交付并列残留（UAT-03 / AC-03）', () => {
  const dir = opsDir()
  setGitRunner((args) => {
    if (args[0] === 'remote' && args[1] === 'get-url') return { ok: true, stdout: 'https://cnb.cool/o/r.git' }
    if (args[0] === 'rev-parse') return { ok: true, stdout: 'cnb/main' }
    return { ok: false }
  })
  const mergeFail = executeCloseout({
    run_id: 'r-fail',
    delivery_scope: 'git',
    operations_dir: dir,
    candidate_ref: { workspace_path: '/repo', head: 'aaa', branch: 'dev-f' },
    authorization_ref: 'auth-1',
    action_params: { merge: { simulate_failure: true, failure_message: 'merge blocked' } },
    include_cleanup: false,
  })
  assert.equal(mergeFail.status, 'ACTION_FAILED')
  assert.equal(mergeFail.delivery_status, 'NOT_DELIVERED')
  const cleanupOnly = executeCloseout({
    ...BASE,
    delivery_scope: 'non-git',
    operations_dir: dir,
    include_cleanup: true,
    workspace_dirty: true,
    recycle: { skip: false, run: { env_resources: { plugin_namespace: 'ns-1' } }, dev_home: '/fake' },
  })
  assert.equal(cleanupOnly.status, 'DELIVERED')
  assert.ok(cleanupOnly.cleanup_pending.length >= 1)
  assert.match(cleanupOnly.cleanup_pending[0].reason, /未保全/)
  rmSync(dir, { recursive: true, force: true })
})

test('D4 目标 GitHub 报 capability_unavailable 且不调用 CNB（UAT-03 / AC-01 后半）', () => {
  setGitRunner((args) => {
    if (args[0] === 'remote' && args[2] === 'github') return { ok: true, stdout: 'git@github.com:o/r.git' }
    if (args[0] === 'remote' && args[2] === 'cnb') return { ok: true, stdout: 'https://cnb.cool/o/r.git' }
    if (args[0] === 'config' && args[2] === 'remote.pushDefault') return { ok: true, stdout: 'github' }
    return { ok: false }
  })
  const t = resolveTargetAdapter('/repo', 'dev', { delivery_scope: 'git' })
  assert.equal(t.ok, false)
  assert.equal(t.code, 'capability_unavailable')
  assert.equal(t.adapter, 'github')
  const planned = planActions({
    run_id: 'gh',
    delivery_scope: 'git',
    candidate_ref: { workspace_path: '/repo', branch: 'dev' },
  })
  assert.equal(planned.action_plan.blocked, true)
  const result = executeCloseout({
    run_id: 'gh',
    delivery_scope: 'git',
    operations_dir: opsDir(),
    candidate_ref: { workspace_path: '/repo', branch: 'dev' },
    authorization_ref: 'auth',
  })
  assert.equal(result.status, 'capability_unavailable')
  assert.equal(result.delivery_status, 'NOT_DELIVERED')
})

test('D5 候选未改；脏工作区/活跃成员不回收（UAT-04 / AC-04）', () => {
  const dir = opsDir()
  setGitRunner(() => ({ ok: false }))
  const facts = gatherFacts(BASE)
  const digest = facts.delivery_report.candidate_ref.digest
  const result = executeCloseout({
    ...BASE,
    delivery_scope: 'non-git',
    operations_dir: dir,
    include_cleanup: true,
    workspace_dirty: true,
    active_env_peers: ['loc-038-r1'],
    recycle: { run: { env_resources: { plugin_namespace: 'loc-037-r1' } }, dev_home: '/fake' },
  })
  assert.equal(result.candidate_unchanged, true)
  assert.equal(result.delivery_report.candidate_ref.digest, digest)
  assert.ok(result.cleanup_pending.some((c) => c.resource === 'worktree'), '脏工作区应列入 cleanup_pending')
  const withPeers = executeCloseout({
    ...BASE,
    delivery_scope: 'non-git',
    operations_dir: opsDir(),
    include_cleanup: true,
    active_env_peers: ['loc-038-r1'],
    recycle: { run: { env_resources: { plugin_namespace: 'loc-037-r1' } }, dev_home: '/fake' },
  })
  assert.ok(withPeers.cleanup_pending.some((c) => c.resource === 'env_group'), '活跃同组成员应阻止回收')
  rmSync(dir, { recursive: true, force: true })
})

test('D6 CLI 子进程：gather-facts / plan-actions / closeout', () => {
  const dir = opsDir()
  const facts = cli('gather-facts', BASE)
  assert.equal(facts.ok, true)
  assert.equal(facts.delivery_report.read_only, true)
  const plan = cli('plan-actions', { ...BASE, delivery_scope: 'non-git' })
  assert.equal(plan.action_plan.required_actions.length, 0)
  const close = cli('closeout', { ...BASE, delivery_scope: 'non-git', operations_dir: dir, include_cleanup: false })
  assert.equal(close.status, 'DELIVERED')
  rmSync(dir, { recursive: true, force: true })
})
