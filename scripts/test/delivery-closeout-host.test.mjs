// 收口事实整理与授权交付动作分离（LOC-037 / WR-014）验收
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  gatherFacts, planActions, executeCloseout, resolveTargetAdapter, setGitRunner, setCnbRunner, setGhRunner,
} from '../delivery-closeout-host.mjs'
import { operationsGet } from '../operations-host.mjs'

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

// CHORE-106：cnb 适配器对 close-task 走真实远端执行，测试统一用替身不触网。
// 真实形态见 delivery-closeout-host.mjs 的 defaultCnbRunner（调用 cnb CLI）。
const ISSUE_PARAMS = { 'close-task': { remote_repo: 'owner/repo', remote_issue: 42 } }
const cnbStub = (args) => {
  if (args[0] === 'issues' && args[1] === 'get-issue') return { ok: true, stdout: JSON.stringify({ state: 'open' }) }
  if (args[0] === 'issues' && args[1] === 'update-issue') return { ok: true, stdout: '{}' }
  return { ok: false, stderr: 'unexpected cnb call: ' + args.join(' ') }
}
setCnbRunner(cnbStub)

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
    action_params: ISSUE_PARAMS,
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
    action_params: ISSUE_PARAMS,
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

test('D4 目标 GitHub 走 GitHub 适配器：close-task 经 gh 执行且零 CNB 调用（CHORE-111 验收 6）', () => {
  setGitRunner((args) => {
    if (args[0] === 'remote' && args[2] === 'github') return { ok: true, stdout: 'git@github.com:o/r.git' }
    if (args[0] === 'remote' && args[2] === 'cnb') return { ok: true, stdout: 'https://cnb.cool/o/r.git' }
    if (args[0] === 'config' && args[2] === 'remote.pushDefault') return { ok: true, stdout: 'github' }
    return { ok: false }
  })
  const t = resolveTargetAdapter('/repo', 'dev', { delivery_scope: 'git' })
  assert.equal(t.ok, true, 'GitHub 适配器已接线，不再报 capability_unavailable')
  assert.equal(t.adapter, 'github')
  assert.equal(t.target_ref, 'github/o/r')
  const ghCalls = []
  setGhRunner((args) => {
    ghCalls.push(args.join(' '))
    if (args[1] === 'view') return { ok: true, stdout: JSON.stringify({ state: 'OPEN' }) }
    return { ok: true, stdout: 'https://github.com/o/r/issues/42' }
  })
  setCnbRunner(() => { throw new Error('GitHub 收口不得回落灾备镜像 CNB') })
  try {
    const planned = planActions({
      run_id: 'gh',
      delivery_scope: 'git',
      candidate_ref: { workspace_path: '/repo', branch: 'dev' },
    })
    assert.notEqual(planned.action_plan.blocked, true, '目标可交付，计划不得 blocked')
    const dir = opsDir()
    const result = executeCloseout({
      run_id: 'gh',
      delivery_scope: 'git',
      operations_dir: dir,
      candidate_ref: { workspace_path: '/repo', head: 'abc123', branch: 'dev' },
      authorization_ref: 'auth-2026-09-19#1',
      action_params: { 'close-task': { remote_repo: 'o/r', remote_issue: 42 } },
      include_cleanup: false,
    })
    assert.equal(result.status, 'DELIVERED')
    assert.equal(result.delivery_status, 'DELIVERED')
    assert.deepEqual(ghCalls, ['issue view 42 --repo o/r --json state', 'issue close 42 --repo o/r'])
    rmSync(dir, { recursive: true, force: true })
  } finally {
    setCnbRunner(cnbStub)
    setGhRunner(null)
  }
})

test('D4b 机器配置仍指向灾备镜像时按 GitHub 主源解析并留痕（UAT-03 / 验收 6）', () => {
  setGitRunner((args) => {
    if (args[0] === 'remote' && args[2] === 'origin') return { ok: true, stdout: 'https://github.com/crystepj-max/workflow-manager.git' }
    if (args[0] === 'remote' && args[2] === 'cnb') return { ok: true, stdout: 'https://cnb.cool/chris.ai/workflow-manager.git' }
    if (args[0] === 'config' && args[2] === 'remote.pushDefault') return { ok: true, stdout: 'cnb' }
    return { ok: false }
  })
  const t = resolveTargetAdapter('/repo', 'dev', { delivery_scope: 'git' })
  assert.equal(t.adapter, 'github', 'pushDefault=cnb 不得把对外动作发到灾备镜像')
  assert.equal(t.target_ref, 'github/crystepj-max/workflow-manager')
  assert.match(t.push_default_conflict, /remote\.pushDefault=cnb/)
  assert.match(t.push_default_conflict, /人工执行 git config/)
})

test('D4c GitHub issue 已关闭时只确认，不重复发关闭请求（WR-012 防重）', () => {
  setGitRunner((args) => {
    if (args[0] === 'remote' && args[2] === 'origin') return { ok: true, stdout: 'https://github.com/o/r.git' }
    if (args[0] === 'config') return { ok: false }
    return { ok: false }
  })
  const calls = []
  setGhRunner((args) => {
    calls.push(args.join(' '))
    if (args[1] === 'view') return { ok: true, stdout: JSON.stringify({ state: 'CLOSED' }) }
    return { ok: true, stdout: '' }
  })
  try {
    const dir = opsDir()
    const result = executeCloseout({
      run_id: 'gh-closed',
      delivery_scope: 'git',
      operations_dir: dir,
      candidate_ref: { workspace_path: '/repo', head: 'abc123', branch: 'dev' },
      authorization_ref: 'auth-1',
      action_params: { 'close-task': { remote_repo: 'o/r', remote_issue: 42 } },
      include_cleanup: false,
    })
    assert.equal(result.status, 'DELIVERED')
    assert.deepEqual(calls, ['issue view 42 --repo o/r --json state'], '已关闭的 issue 不再发第二次关闭')
    rmSync(dir, { recursive: true, force: true })
  } finally {
    setGhRunner(null)
  }
})

test('D4d GitHub 关闭失败时判 NOT_DELIVERED 并列待人工关闭，不回落 CNB（验收 6/7）', () => {
  setGitRunner((args) => {
    if (args[0] === 'remote' && args[2] === 'origin') return { ok: true, stdout: 'https://github.com/o/r.git' }
    return { ok: false }
  })
  setCnbRunner(() => { throw new Error('不得回落 CNB') })
  setGhRunner(() => ({ ok: false, stderr: 'gh: HTTP 401' }))
  try {
    const dir = opsDir()
    const result = executeCloseout({
      run_id: 'gh-fail',
      delivery_scope: 'git',
      operations_dir: dir,
      candidate_ref: { workspace_path: '/repo', head: 'abc123', branch: 'dev' },
      authorization_ref: 'auth-1',
      action_params: { 'close-task': { remote_repo: 'o/r', remote_issue: 42 } },
      include_cleanup: false,
    })
    assert.equal(result.delivery_status, 'NOT_DELIVERED', '必要动作失败不得判已交付')
    assert.equal(result.pending_manual_close.length, 1)
    assert.equal(result.pending_manual_close[0].hint, 'gh issue close 42 --repo o/r')
    rmSync(dir, { recursive: true, force: true })
  } finally {
    setCnbRunner(cnbStub)
    setGhRunner(null)
  }
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

// ── CHORE-106：close-task 必须产生真实远端效果（不接受「声明了却不执行」）──────

const GIT_RUNNER = (args) => {
  if (args[0] === 'remote' && args[1] === 'get-url') return { ok: true, stdout: 'https://cnb.cool/owner/repo.git' }
  if (args[0] === 'config') return { ok: false }
  if (args[0] === 'rev-parse') return { ok: true, stdout: 'cnb/main' }
  return { ok: false }
}

const gitInput = (runId, extra = {}) => ({
  run_id: runId,
  delivery_scope: 'git',
  candidate_ref: { workspace_path: '/repo', head: 'deadbeef', branch: 'dev-x' },
  authorization_ref: 'auth-close',
  include_cleanup: false,
  ...extra,
})

test('D7 close-task 产生真实远端效果：按定位调用关闭并确认成功（CHORE-106 AC-1）', () => {
  const dir = opsDir()
  setGitRunner(GIT_RUNNER)
  const calls = []
  setCnbRunner((args) => {
    calls.push(args)
    if (args[1] === 'get-issue') return { ok: true, stdout: JSON.stringify({ state: 'open' }) }
    if (args[1] === 'update-issue') return { ok: true, stdout: '{}' }
    return { ok: false, stderr: 'unexpected ' + args.join(' ') }
  })
  const result = executeCloseout(gitInput('r-close-1', {
    operations_dir: dir,
    action_params: { 'close-task': { remote_repo: 'owner/repo', remote_issue: 'cnb#106' } },
  }))
  assert.equal(result.status, 'DELIVERED')
  assert.equal(result.delivery_status, 'DELIVERED')
  assert.equal(result.pending_manual_close.length, 0, '成功关闭不应留待人工项')
  const closeCall = calls.find((a) => a[1] === 'update-issue')
  assert.ok(closeCall, '必须发出真实关闭请求（不得只记账）')
  assert.deepEqual(closeCall.slice(0, 8), ['issues', 'update-issue', '--repo', 'owner/repo', '--number', '106', '--state', 'closed'])
  const slot = result.action_results.find((r) => r.action === 'close-task')
  assert.equal(slot.result.status, 'confirmed_success')
  assert.equal(slot.result.remote_ref.id, 'cnb-issue-106', '回读凭证指向被关闭的 issue')
  // 账本可独立核查到 confirmed_success（验收标准 1）
  const ledgerEntry = operationsGet({ operations_dir: dir, run_id: 'r-close-1', logical_action: 'close-task' })
  assert.equal(ledgerEntry.ok, true)
  assert.equal(ledgerEntry.status, 'confirmed_success')
  assert.equal(ledgerEntry.operation.remote_ref.id, 'cnb-issue-106')
  rmSync(dir, { recursive: true, force: true })
})

test('D8 远端已关闭时不重复发关闭请求（WR-012 防重，CHORE-106 AC-2）', () => {
  const dir = opsDir()
  setGitRunner(GIT_RUNNER)
  const calls = []
  setCnbRunner((args) => {
    calls.push(args)
    if (args[1] === 'get-issue') return { ok: true, stdout: JSON.stringify({ state: 'closed' }) }
    if (args[1] === 'update-issue') return { ok: true, stdout: '{}' }
    return { ok: false, stderr: 'unexpected ' + args.join(' ') }
  })
  const result = executeCloseout(gitInput('r-close-idem', {
    operations_dir: dir,
    action_params: { 'close-task': { remote_repo: 'owner/repo', remote_issue: 106 } },
  }))
  assert.equal(result.status, 'DELIVERED')
  assert.equal(calls.filter((a) => a[1] === 'update-issue').length, 0, '已关闭不得再次发出关闭请求')
  const slot = result.action_results.find((r) => r.action === 'close-task')
  assert.equal(slot.result.result.prior_state, 'closed')
  rmSync(dir, { recursive: true, force: true })
})

test('D9 缺远端定位：不得 DELIVERED 且显式列待人工关闭（CHORE-106 AC-3）', () => {
  const dir = opsDir()
  setGitRunner(GIT_RUNNER)
  const result = executeCloseout(gitInput('r-close-noloc', { operations_dir: dir }))
  assert.equal(result.status, 'ACTION_FAILED')
  assert.equal(result.delivery_status, 'NOT_DELIVERED')
  assert.equal(result.pending_manual_close.length, 1)
  assert.match(result.pending_manual_close[0].reason, /缺少远端 issue 定位/)
  assert.match(result.message, /待人工关闭/)
  rmSync(dir, { recursive: true, force: true })
})

test('D10 远端关闭失败：不得 DELIVERED 并给人工补救命令（CHORE-106 AC-3）', () => {
  const dir = opsDir()
  setGitRunner(GIT_RUNNER)
  setCnbRunner((args) => {
    if (args[1] === 'get-issue') return { ok: true, stdout: JSON.stringify({ state: 'open' }) }
    if (args[1] === 'update-issue') return { ok: false, stderr: 'permission denied' }
    return { ok: false, stderr: 'unexpected ' + args.join(' ') }
  })
  const result = executeCloseout(gitInput('r-close-fail', {
    operations_dir: dir,
    action_params: { 'close-task': { remote_repo: 'owner/repo', remote_issue: 106 } },
  }))
  assert.equal(result.status, 'ACTION_FAILED')
  assert.equal(result.delivery_status, 'NOT_DELIVERED')
  assert.match(result.pending_manual_close[0].reason, /关闭远端 issue 失败/)
  assert.match(result.pending_manual_close[0].hint, /update-issue --repo owner\/repo --number 106/)
  rmSync(dir, { recursive: true, force: true })
})

test('D11 远端状态不可确认：按 unknown 受阻不误报成功（CHORE-106 AC-3）', () => {
  const dir = opsDir()
  setGitRunner(GIT_RUNNER)
  setCnbRunner(() => ({ ok: false, stderr: 'network unreachable' }))
  const result = executeCloseout(gitInput('r-close-unknown', {
    operations_dir: dir,
    action_params: { 'close-task': { remote_repo: 'owner/repo', remote_issue: 106 } },
  }))
  assert.equal(result.delivery_status, 'NOT_DELIVERED')
  const slot = result.action_results.find((r) => r.action === 'close-task')
  assert.equal(slot.result.blocked, true)
  assert.equal(slot.result.code, 'NEEDS_RECONCILIATION')
  assert.equal(result.pending_manual_close.length, 1)
  rmSync(dir, { recursive: true, force: true })
})
