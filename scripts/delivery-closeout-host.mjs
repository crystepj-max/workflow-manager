#!/usr/bin/env node
// 收口事实整理与授权交付动作分离（LOC-037 / WR-014）
//
// 阶段一（只读）：gatherFacts —— 整理候选版本、证明、人工决定与未完成项，不改候选。
// 阶段二（授权后）：planActions + executeCloseout —— 按动作计划调用 LOC-032
// execute-or-reconcile；必要动作失败不得 DELIVERED；可选清理失败记 cleanup_pending。
//
// 适配器：local/no-op（非 Git 纯本地交付）、github（主源，经 `gh` CLI）、cnb（灾备镜像，沿用既有 CLI 封装）。
// 未知适配器 → capability_unavailable。GitHub 与 CNB 互不回落：主源动作失败绝不改发灾备镜像。
//
// 用法：
//   node scripts/delivery-closeout-host.mjs gather-facts '<json>'
//   node scripts/delivery-closeout-host.mjs plan-actions '<json>'
//   node scripts/delivery-closeout-host.mjs closeout '<json>'
// stdout 一行 JSON；exit 0 = 业务结果（含 ok:false），1 = 命令内部异常，2 = 用法错误。

import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { operationsExecute, registerProvider } from './operations-host.mjs'
import { recycleRun } from './cwf-env-recycle.mjs'
import { githubSlugOf } from './local-task-registry.mjs'

const KNOWN_ADAPTERS = ['local', 'no-op', 'cnb', 'github']
const DEFAULT_GIT_ACTIONS = ['create-review', 'merge', 'close-task']
const OPTIONAL_CLEANUP = 'cleanup-env'

const sha256Hex = (text) => createHash('sha256').update(text).digest('hex')

function requireText(v, label) {
  if (typeof v !== 'string' || !/\S/.test(v)) throw new Error(`${label} 必须是非空字符串`)
  return v
}

function bizError(code, error, extra) {
  return { ok: false, code, error, ...(extra || {}) }
}

// ── 可注入 git 执行器（测试替身 / 真实 git）────────────────────────────────────
let gitRunner = defaultGitRunner
export function setGitRunner(fn) {
  gitRunner = fn || defaultGitRunner
}

function defaultGitRunner(args, cwd) {
  try {
    const out = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    return { ok: true, stdout: out }
  } catch (e) {
    return { ok: false, stderr: String((e && e.stderr) || (e && e.message) || e), code: e && e.status }
  }
}

function git(args, cwd) {
  return gitRunner(args, cwd)
}

// ── 可注入远端执行器（测试替身 / 真实 CLI）───────────────────────────────────
// CHORE-106：close-task 必须产生真实远端效果。执行器可注入，测试不触网；
// 真实形态调用 `cnb` CLI，凭据沿用平台既有登录态（与 remote-issue-sync 同通道）。
let cnbRunner = defaultCnbRunner
export function setCnbRunner(fn) {
  cnbRunner = fn || defaultCnbRunner
}

function defaultCnbRunner(args) {
  try {
    const out = execFileSync('cnb', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    return { ok: true, stdout: out }
  } catch (e) {
    return { ok: false, stderr: String((e && e.stderr) || (e && e.message) || e), code: e && e.status }
  }
}

// CHORE-111：GitHub 为主源，close-task 经 `gh` CLI 产生真实远端效果；同样可注入不触网。
let ghRunner = defaultGhRunner
export function setGhRunner(fn) {
  ghRunner = fn || defaultGhRunner
}

function defaultGhRunner(args) {
  try {
    const out = execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    return { ok: true, stdout: out }
  } catch (e) {
    return { ok: false, stderr: String((e && e.stderr) || (e && e.message) || e), code: e && e.status }
  }
}

// 远端 issue 定位：close-task 的规范参数（缺一不可，否则无法自动关闭）
function closeTaskTarget(params) {
  const repo = params && typeof params.remote_repo === 'string' ? params.remote_repo.trim() : ''
  const raw = params && params.remote_issue !== undefined && params.remote_issue !== null ? String(params.remote_issue).trim() : ''
  const issue = raw.replace(/^[a-z]+#/i, '').trim() // 兼容 `cnb#106` 写法
  if (!repo || !issue || !/^\d+$/.test(issue)) return null
  return { repo, issue }
}

// 远端 issue 当前状态（WR-012 防重的前提）：closed / open / unknown
function cnbIssueState(repo, issue) {
  const r = cnbRunner(['issues', 'get-issue', '--repo', repo, '--number', String(issue), '--verbose'])
  if (!r.ok || !r.stdout) return 'unknown'
  let parsed = null
  try {
    parsed = JSON.parse(r.stdout)
  } catch (e) {
    return 'unknown'
  }
  const state = String((parsed && (parsed.state || (parsed.data && parsed.data.state))) || '').toLowerCase()
  if (state === 'closed') return 'closed'
  if (state === 'open') return 'open'
  return 'unknown'
}

// GitHub 侧 issue 状态（WR-012 防重的前提）：closed / open / unknown
function ghIssueState(repo, issue) {
  const r = ghRunner(['issue', 'view', String(issue), '--repo', repo, '--json', 'state'])
  if (!r.ok || !r.stdout) return 'unknown'
  try {
    const parsed = JSON.parse(r.stdout)
    const state = String((parsed && parsed.state) || '').toLowerCase()
    if (state === 'closed') return 'closed'
    if (state === 'open') return 'open'
  } catch { /* 输出不是 JSON：状态不可确认，交由 ops 层 reconcile */ }
  return 'unknown'
}

// ── CNB 适配器（注册到 operations-host，供 execute-or-reconcile 调用）────────
const cnbStoreFile = (operationsDir) => requireText(operationsDir, 'operations_dir') + '/provider-cnb.json'

const cnbProvider = (() => {
  const empty = () => ({ effects: {}, execute_calls_total: 0, reconcile_calls_total: 0, replays: 0, git_calls: 0 })
  function load(operationsDir) {
    const file = cnbStoreFile(operationsDir)
    if (!existsSync(file)) return { file, store: empty() }
    const data = JSON.parse(readFileSync(file, 'utf8'))
    return { file, store: { ...empty(), ...data, effects: data.effects && typeof data.effects === 'object' ? data.effects : {} } }
  }
  function save(file, store) {
    const tmp = file + '.' + process.pid + '.' + randomUUID().slice(0, 8) + '.tmp'
    writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n')
    renameSync(tmp, file)
  }
  return {
    id: 'cnb',
    supports_idempotency_key: true,
    execute(input) {
      const { operations_dir, logical_action, target, params, idempotency_key } = input || {}
      mkdirSync(operations_dir, { recursive: true })
      const { file, store } = load(operations_dir)
      store.execute_calls_total += 1
      store.git_calls += 1
      const existing = store.effects[idempotency_key]
      if (existing) {
        store.replays += 1
        save(file, store)
        return { status: 'confirmed_success', remote_ref: existing.remote_ref, result: existing.result, replayed: true }
      }
      if (params && params.simulate_failure === true) {
        return { status: 'confirmed_failure', error: params.failure_message || 'cnb simulated failure' }
      }
      // CHORE-106：close-task 必须产生真实远端效果，不允许「声明了却不执行」。
      // 缺定位或关闭失败 = confirmed_failure（收口据此判 NOT_DELIVERED 并列待人工关闭）；
      // 状态不可确认 = unknown（交由 ops 层 reconcile，禁止盲目重复关闭）。
      if (logical_action === 'close-task') {
        const located = closeTaskTarget(params)
        if (!located) {
          return {
            status: 'confirmed_failure',
            error: 'close-task 缺少远端 issue 定位（remote_repo + remote_issue）：无法自动关闭，须人工关闭远端 issue',
          }
        }
        const state = cnbIssueState(located.repo, located.issue)
        if (state === 'unknown') {
          return { status: 'unknown', detail: '无法确认远端 issue ' + located.repo + '#' + located.issue + ' 的当前状态' }
        }
        // WR-012 防重：已关闭则只确认，不再发一次关闭请求
        if (state === 'open') {
          const closed = cnbRunner(['issues', 'update-issue', '--repo', located.repo, '--number', located.issue, '--state', 'closed', '--state-reason', 'completed'])
          if (!closed.ok) {
            return { status: 'confirmed_failure', error: '关闭远端 issue 失败：' + String(closed.stderr || closed.stdout || '').slice(0, 300) }
          }
        }
        const remote_ref = { system: 'cnb', id: 'cnb-issue-' + located.issue, version: 1, target: located.repo + '#' + located.issue }
        const result = { logical_action, target, params: params ?? null, remote_repo: located.repo, remote_issue: located.issue, issue_state: 'closed', prior_state: state }
        store.effects[idempotency_key] = { logical_action, target, remote_ref, result, created_at: new Date().toISOString() }
        save(file, store)
        return { status: 'confirmed_success', remote_ref, result }
      }
      const n = Object.keys(store.effects).length + 1
      const remote_ref = { system: 'cnb', id: 'cnb-' + logical_action + '-' + n, version: 1, target }
      const result = { logical_action, target, params: params ?? null, pushed_head: params?.head || null }
      store.effects[idempotency_key] = { logical_action, target, remote_ref, result, created_at: new Date().toISOString() }
      save(file, store)
      return { status: 'confirmed_success', remote_ref, result }
    },
    reconcile(input) {
      try {
        const { operations_dir, idempotency_key } = input || {}
        const { file, store } = load(operations_dir)
        store.reconcile_calls_total += 1
        save(file, store)
        const effect = store.effects[idempotency_key]
        if (effect) return { status: 'confirmed_success', remote_ref: effect.remote_ref, result: effect.result }
        return { status: 'confirmed_not_executed', detail: 'cnb 无此幂等键的效果记录' }
      } catch (e) {
        return { status: 'unknown', detail: 'cnb 效果日志不可读：' + String((e && e.message) || e) }
      }
    },
  }
})()

let cnbRegistered = false
function ensureCnbProvider() {
  if (!cnbRegistered) {
    registerProvider('cnb', cnbProvider)
    cnbRegistered = true
  }
}

// ── GitHub 适配器（CHORE-111：主源）─────────────────────────────────────────
// 与 cnb 适配器同形态、并存不覆盖其行为：close-task 走真实 `gh` 调用；
// create-review / merge 沿用既有约定——真实 Git/PR 动作由调用方在收口之外完成，
// 这里只登记效果，不代为创建或合并 PR（避免对外动作重复执行）。
const githubStoreFile = (operationsDir) => requireText(operationsDir, 'operations_dir') + '/provider-github.json'

const githubProvider = (() => {
  const empty = () => ({ effects: {}, execute_calls_total: 0, reconcile_calls_total: 0, replays: 0, git_calls: 0 })
  function load(operationsDir) {
    const file = githubStoreFile(operationsDir)
    if (!existsSync(file)) return { file, store: empty() }
    const data = JSON.parse(readFileSync(file, 'utf8'))
    return { file, store: { ...empty(), ...data, effects: data.effects && typeof data.effects === 'object' ? data.effects : {} } }
  }
  function save(file, store) {
    const tmp = file + '.' + process.pid + '.' + randomUUID().slice(0, 8) + '.tmp'
    writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n')
    renameSync(tmp, file)
  }
  return {
    id: 'github',
    supports_idempotency_key: true,
    execute(input) {
      const { operations_dir, logical_action, target, params, idempotency_key } = input || {}
      mkdirSync(operations_dir, { recursive: true })
      const { file, store } = load(operations_dir)
      store.execute_calls_total += 1
      store.git_calls += 1
      const existing = store.effects[idempotency_key]
      if (existing) {
        store.replays += 1
        save(file, store)
        return { status: 'confirmed_success', remote_ref: existing.remote_ref, result: existing.result, replayed: true }
      }
      if (params && params.simulate_failure === true) {
        return { status: 'confirmed_failure', error: params.failure_message || 'github simulated failure' }
      }
      if (logical_action === 'close-task') {
        const located = closeTaskTarget(params)
        if (!located) {
          return {
            status: 'confirmed_failure',
            error: 'close-task 缺少远端 issue 定位（remote_repo + remote_issue）：无法自动关闭，须人工关闭 GitHub issue',
          }
        }
        const state = ghIssueState(located.repo, located.issue)
        if (state === 'unknown') {
          return { status: 'unknown', detail: '无法确认 GitHub issue ' + located.repo + '#' + located.issue + ' 的当前状态' }
        }
        // WR-012 防重：已关闭则只确认，不再发一次关闭请求
        if (state === 'open') {
          const closed = ghRunner(['issue', 'close', String(located.issue), '--repo', located.repo])
          if (!closed.ok) {
            return { status: 'confirmed_failure', error: '关闭 GitHub issue 失败：' + String(closed.stderr || closed.stdout || '').slice(0, 300) }
          }
        }
        const remote_ref = { system: 'github', id: 'github-issue-' + located.issue, version: 1, target: located.repo + '#' + located.issue }
        const result = { logical_action, target, params: params ?? null, remote_repo: located.repo, remote_issue: located.issue, issue_state: 'closed', prior_state: state }
        store.effects[idempotency_key] = { logical_action, target, remote_ref, result, created_at: new Date().toISOString() }
        save(file, store)
        return { status: 'confirmed_success', remote_ref, result }
      }
      const n = Object.keys(store.effects).length + 1
      const remote_ref = { system: 'github', id: 'github-' + logical_action + '-' + n, version: 1, target }
      const result = { logical_action, target, params: params ?? null, pushed_head: params?.head || null }
      store.effects[idempotency_key] = { logical_action, target, remote_ref, result, created_at: new Date().toISOString() }
      save(file, store)
      return { status: 'confirmed_success', remote_ref, result }
    },
    reconcile(input) {
      try {
        const { operations_dir, idempotency_key } = input || {}
        const { file, store } = load(operations_dir)
        store.reconcile_calls_total += 1
        save(file, store)
        const effect = store.effects[idempotency_key]
        if (effect) return { status: 'confirmed_success', remote_ref: effect.remote_ref, result: effect.result }
        return { status: 'confirmed_not_executed', detail: 'github 无此幂等键的效果记录' }
      } catch (e) {
        return { status: 'unknown', detail: 'github 效果日志不可读：' + String((e && e.message) || e) }
      }
    },
  }
})()

let githubRegistered = false
function ensureGithubProvider() {
  if (!githubRegistered) {
    registerProvider('github', githubProvider)
    githubRegistered = true
  }
}

// ── 目标解析：读 remote.pushDefault / 分支上游，不硬编码 origin ───────────────
export function resolveTargetAdapter(repoPath, workBranch, overrides = {}) {
  if (overrides.target_adapter) {
    const id = String(overrides.target_adapter)
    if (KNOWN_ADAPTERS.indexOf(id) < 0) return { ok: false, code: 'capability_unavailable', adapter: id, reason: '未知适配器 ' + id }
    return { ok: true, adapter: id, target_ref: overrides.target_ref || id, is_git: id !== 'local' && id !== 'no-op' }
  }
  const wantsGit = overrides.delivery_scope === 'git' || overrides.delivery_scope === 'full' || overrides.force_git === true
  const hasGitDir = repoPath && existsSync(join(repoPath, '.git'))
  if (!wantsGit && (!repoPath || !hasGitDir)) {
    return { ok: true, adapter: 'local', target_ref: 'local/no-git', is_git: false }
  }
  const pushDefault = git(['config', '--get', 'remote.pushDefault'], repoPath)
  const upstream = workBranch ? git(['rev-parse', '--abbrev-ref', `${workBranch}@{upstream}`], repoPath) : { ok: false }
  let remoteName = null
  if (pushDefault.ok && pushDefault.stdout) remoteName = pushDefault.stdout
  else if (upstream.ok && upstream.stdout && upstream.stdout.includes('/')) {
    remoteName = upstream.stdout.split('/')[0]
  }
  const remotes = {}
  for (const name of ['cnb', 'github', 'origin']) {
    const url = git(['remote', 'get-url', name], repoPath)
    if (url.ok && url.stdout) remotes[name] = url.stdout
  }
  // CHORE-111 主源优先：仓库只要配了 GitHub 远端就以 GitHub 为交付目标。机器本地 `remote.pushDefault`
  // 可能仍写着 cnb（灾备镜像），不得据此把对外动作发到镜像仓库——差异如实记录在 push_default_conflict，
  // 配置本身属机器状态，改不改由人工决定，本脚本不改 git config。
  const githubName =
    ['github', 'origin'].find((name) => githubSlugOf(remotes[name])) ||
    Object.keys(remotes).find((name) => githubSlugOf(remotes[name]))
  if (githubName) {
    const slug = githubSlugOf(remotes[githubName])
    const resolved = { ok: true, adapter: 'github', target_ref: 'github/' + slug, remote: githubName, is_git: true }
    if (remoteName && remoteName !== githubName) {
      resolved.push_default_conflict = 'remote.pushDefault=' + remoteName + '，已按 GitHub 主源解析；如需改配置请人工执行 git config remote.pushDefault ' + githubName
    }
    return resolved
  }
  if (remotes.cnb) {
    const slug = remotes.cnb.replace(/\.git$/, '').split('/').slice(-2).join('/')
    return { ok: true, adapter: 'cnb', target_ref: 'cnb/' + slug, remote: 'cnb', is_git: true }
  }
  return { ok: true, adapter: 'local', target_ref: remoteName ? remoteName + '/local' : 'local/git-no-remote', is_git: true }
}

// ── 授权校验 ─────────────────────────────────────────────────────────────────
function findAuthorization(authorizations, scope, targetRef) {
  const list = Array.isArray(authorizations) ? authorizations : []
  return list.find((a) => a && a.valid === true && a.scope === scope && (!a.target || a.target === targetRef || a.target === '*'))
}

function authScopeFor(action, targetRef) {
  return action + ':' + targetRef
}

// ── 阶段一：只读事实整理 ─────────────────────────────────────────────────────
export function gatherFacts(input) {
  const runId = requireText((input || {}).run_id, 'run_id')
  const candidate = (input || {}).candidate_ref || {}
  const repoPath = candidate.workspace_path || candidate.repo_path || null
  let head = candidate.head || null
  let branch = candidate.branch || null
  let digest = candidate.digest || null
  const gitCalls = { count: 0 }
  const wrappedGit = (args, cwd) => {
    gitCalls.count += 1
    return git(args, cwd)
  }
  const prev = gitRunner
  gitRunner = wrappedGit
  try {
    if (repoPath && existsSync(join(repoPath, '.git'))) {
      if (!head) {
        const r = git(['rev-parse', 'HEAD'], repoPath)
        if (r.ok) head = r.stdout
      }
      if (!branch) {
        const r = git(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath)
        if (r.ok) branch = r.stdout
      }
    }
    if (!digest && head) digest = 'sha256-' + sha256Hex(head)
    else if (!digest && repoPath) digest = 'sha256-' + sha256Hex(repoPath)
  } finally {
    gitRunner = prev
  }
  const reports = Array.isArray((input || {}).reports) ? input.reports : []
  const acceptance = (input || {}).acceptance || {}
  const limitations = Array.isArray((input || {}).limitations) ? input.limitations : []
  const incomplete = Array.isArray((input || {}).incomplete_items) ? input.incomplete_items : []
  const delivery_report = {
    run_id: runId,
    candidate_ref: { workspace_path: repoPath, head, branch, digest },
    acceptance_decision: acceptance.decision || null,
    acceptance_summary: acceptance.summary || null,
    proofs: reports.map((r) => ({ name: r.name || r.path, path: r.path || r.name, status: r.status || 'present' })),
    incomplete_items: incomplete,
    limitations,
    gathered_at: new Date().toISOString(),
    read_only: true,
  }
  return { ok: true, delivery_report, git_calls: gitCalls.count }
}

// ── 动作计划 ─────────────────────────────────────────────────────────────────
export function planActions(input) {
  const runId = requireText((input || {}).run_id, 'run_id')
  const scope = String((input || {}).delivery_scope || 'git')
  const candidate = (input || {}).candidate_ref || {}
  const repoPath = candidate.workspace_path || candidate.repo_path || null
  const workBranch = candidate.branch || (input || {}).work_branch || null
  const target = resolveTargetAdapter(repoPath, workBranch, { ...(input || {}), delivery_scope: scope })
  if (!target.ok) {
    return {
      ok: true,
      action_plan: {
        run_id: runId,
        required_actions: [],
        optional_actions: [],
        authorization_ref: null,
        target_adapter: target.adapter,
        target_ref: null,
        candidate_ref: candidate,
        blocked: true,
        block_reason: target.reason,
      },
      target,
    }
  }
  const adapter = target.adapter === 'no-op' ? 'local' : target.adapter
  let required_actions = []
  let optional_actions = []
  if (scope === 'non-git' || (adapter === 'local' && !target.is_git && scope !== 'git')) {
    required_actions = []
    if ((input || {}).include_cleanup === true) optional_actions = [OPTIONAL_CLEANUP]
  } else if (scope === 'git' || scope === 'full' || target.is_git) {
    required_actions = [...DEFAULT_GIT_ACTIONS]
    optional_actions = [OPTIONAL_CLEANUP]
  }
  if ((input || {}).include_cleanup === false) optional_actions = optional_actions.filter((a) => a !== OPTIONAL_CLEANUP)
  const authorizations = (input || {}).authorizations || []
  const authRef = (input || {}).authorization_ref || null
  let authorization_ref = authRef
  if (!authorization_ref && required_actions.length) {
    const scopeKey = authScopeFor(required_actions[0], target.target_ref)
    const found = findAuthorization(authorizations, scopeKey, target.target_ref)
    if (found) authorization_ref = found.ref
  }
  const action_plan = {
    run_id: runId,
    required_actions,
    optional_actions,
    authorization_ref,
    target_adapter: adapter,
    target_ref: target.target_ref,
    candidate_ref: candidate,
    missing_authorization: required_actions.length > 0 && !authorization_ref,
  }
  return { ok: true, action_plan, target }
}

// ── 阶段二：执行收口 ─────────────────────────────────────────────────────────
export function executeCloseout(input) {
  ensureCnbProvider()
  ensureGithubProvider()
  const runId = requireText((input || {}).run_id, 'run_id')
  const operations_dir = requireText((input || {}).operations_dir, 'operations_dir')
  mkdirSync(operations_dir, { recursive: true })
  const gitCallLog = []
  const prev = gitRunner
  gitRunner = (args, cwd) => {
    gitCallLog.push({ cmd: ['git', ...args], cwd })
    return prev(args, cwd)
  }
  try {
    const facts = gatherFacts(input)
    if (!facts.ok) return facts
    const initialDigest = facts.delivery_report.candidate_ref.digest
    const planned = planActions(input)
    if (!planned.ok) return planned
    const plan = planned.action_plan
    if (plan.blocked) {
      return {
        ok: true,
        status: 'capability_unavailable',
        delivery_report: facts.delivery_report,
        action_plan: plan,
        action_results: [],
        cleanup_pending: [],
        pending_manual_close: [],
        git_calls: gitCallLog.length,
        delivery_status: 'NOT_DELIVERED',
      }
    }
    if (plan.missing_authorization) {
      return {
        ok: true,
        status: 'AWAITING_AUTHORIZATION',
        delivery_report: facts.delivery_report,
        action_plan: plan,
        action_results: [],
        cleanup_pending: [],
        pending_manual_close: [],
        git_calls: gitCallLog.length,
        delivery_status: 'NOT_DELIVERED',
        message: '必要动作缺少有效授权：已整理交付事实，等待授权后执行',
      }
    }
    const action_results = []
    // CHORE-106：close-task 未确认成功时，显式落「待人工关闭」，不让缺口静默消失
    const pending_manual_close = []
    let requiredFailed = false
    const provider = plan.target_adapter === 'cnb' || plan.target_adapter === 'github' ? plan.target_adapter : 'local-count'
    for (const action of plan.required_actions) {
      if (action === OPTIONAL_CLEANUP) continue
      const scope = authScopeFor(action, plan.target_ref)
      const execInput = {
        operations_dir,
        run_id: runId,
        logical_action: action,
        target: plan.target_ref + '#' + (plan.candidate_ref.branch || 'head'),
        authorization_scope: scope,
        authorization_ref: plan.authorization_ref,
        provider,
        params: {
          head: plan.candidate_ref.head,
          branch: plan.candidate_ref.branch,
          ...(input.action_params && input.action_params[action] ? input.action_params[action] : {}),
        },
      }
      const result = operationsExecute(execInput)
      action_results.push({ action, required: true, result })
      const confirmedOk = result.ok && result.status === 'confirmed_success'
      if (action === 'close-task' && !confirmedOk) {
        const located = closeTaskTarget(execInput.params)
        pending_manual_close.push({
          action: 'close-task',
          remote_repo: located ? located.repo : (execInput.params && execInput.params.remote_repo) || null,
          remote_issue: located ? located.issue : (execInput.params && execInput.params.remote_issue) || null,
          reason: (result && (result.error || result.detail)) || (result && result.code) || 'close-task 未确认成功',
          hint: located
            ? (plan.target_adapter === 'github'
                ? 'gh issue close ' + located.issue + ' --repo ' + located.repo
                : 'cnb issues update-issue --repo ' + located.repo + ' --number ' + located.issue + ' --state closed --state-reason completed')
            : '补 remote_repo/remote_issue 后重跑收口，或人工关闭远端 issue',
        })
      }
      if (!result.ok || result.status === 'confirmed_failure' || result.code) {
        requiredFailed = true
        break
      }
      if (result.status !== 'confirmed_success') {
        requiredFailed = true
        break
      }
    }
    const cleanup_pending = []
    if (!requiredFailed) {
      for (const action of plan.optional_actions) {
        if (action !== OPTIONAL_CLEANUP) continue
        const dirty = (input || {}).workspace_dirty === true
        const activePeers = Array.isArray((input || {}).active_env_peers) ? input.active_env_peers : []
        if (dirty) {
          cleanup_pending.push({ resource: 'worktree', reason: '含未保全改动，禁止强删', path: plan.candidate_ref.workspace_path })
        } else if (activePeers.length > 0) {
          cleanup_pending.push({ resource: 'env_group', reason: '同组仍有活跃成员：' + activePeers.join(', '), peers: activePeers })
        } else {
          const recycleInput = (input || {}).recycle || {}
          if (recycleInput.skip !== true) {
            const recycleResult = recycleRun(recycleInput.run || { env_resources: recycleInput.env_resources }, recycleInput.dev_home || '/dev/null', recycleInput.opts || {})
            if (!recycleResult.ok) {
              cleanup_pending.push({ resource: 'dev_dsh', reason: recycleResult.reason || recycleResult.status, detail: recycleResult })
            }
          }
        }
      }
    }
    const finalFacts = gatherFacts(input)
    const candidateUnchanged = finalFacts.delivery_report.candidate_ref.digest === initialDigest
    if (!candidateUnchanged) {
      return bizError('CANDIDATE_MODIFIED', '收口过程中候选内容发生变化，不得 DELIVERED', {
        delivery_report: facts.delivery_report,
        action_plan: plan,
        action_results,
      })
    }
    const allRequiredOk = plan.required_actions.length === 0 || plan.required_actions.every((a) => {
      const r = action_results.find((x) => x.action === a)
      return r && r.result && r.result.ok && r.result.status === 'confirmed_success'
    })
    const delivered = !requiredFailed && allRequiredOk
    return {
      ok: true,
      status: delivered ? 'DELIVERED' : 'ACTION_FAILED',
      delivery_status: delivered ? 'DELIVERED' : 'NOT_DELIVERED',
      delivery_report: facts.delivery_report,
      action_plan: plan,
      action_results,
      cleanup_pending,
      pending_manual_close,
      git_calls: gitCallLog.length,
      candidate_unchanged: candidateUnchanged,
      message: delivered
        ? (cleanup_pending.length ? '交付完成；可选清理待处理' : '交付完成')
        : (pending_manual_close.length
          ? '必要动作未全部确认成功，不得 DELIVERED；待人工关闭远端 issue：' + pending_manual_close.map((p) => (p.remote_issue ? p.remote_repo + '#' + p.remote_issue : '未定位')).join('、')
          : '必要动作未全部确认成功，不得 DELIVERED'),
    }
  } finally {
    gitRunner = prev
  }
}

const COMMANDS = { 'gather-facts': gatherFacts, 'plan-actions': planActions, closeout: executeCloseout }

if (process.argv.length >= 2 && /delivery-closeout-host\.mjs$/.test(String(process.argv[1] || ''))) {
  const cmd = process.argv[2]
  const fn = COMMANDS[cmd]
  if (!fn) {
    console.error('用法: node scripts/delivery-closeout-host.mjs <gather-facts|plan-actions|closeout> \'<json>\'')
    process.exit(2)
  }
  let input = {}
  try {
    input = process.argv[3] ? JSON.parse(process.argv[3]) : {}
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: '输入 JSON 不可解析：' + e.message }))
    process.exit(1)
  }
  try {
    console.log(JSON.stringify(fn(input)))
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: String((e && e.message) || e) }))
    process.exit(1)
  }
}
