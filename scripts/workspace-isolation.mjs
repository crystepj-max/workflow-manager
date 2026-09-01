#!/usr/bin/env node
// Workspace / Resource / Integration Isolation 内核（#93 Core）
// Registry 默认内存；Git worktree + directory sandbox；锁按 resource_key 作用域。
// 证明失效只调用 #78，不平行实现 provenance。

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeCheckpoint } from './cwf-checkpoint.mjs'
import { coverageStatus, COVERING } from './formal-records.mjs'
import { validateRecord } from './cwf-validate.mjs'

export const WORKSPACE_MODE = {
  ISOLATED_WRITE: 'ISOLATED_WRITE',
  ISOLATED_READ: 'ISOLATED_READ',
  SANDBOX: 'SANDBOX',
  NONE: 'NONE',
}

export const TEMPLATE_ID = {
  CONSTRUCTION: 'construction',
  OPTIMIZE: 'optimize',
  DIAGNOSE: 'diagnose',
  EXPLORE: 'explore',
}

export const LIFECYCLE = {
  READY: 'READY',
  RUNNING: 'RUNNING',
  WAITING_HUMAN: 'WAITING_HUMAN',
  PAUSED: 'PAUSED',
  BLOCKED: 'BLOCKED',
  COMPLETED: 'COMPLETED',
  STOPPED: 'STOPPED',
  FAILED: 'FAILED',
}

export const PROVIDER = {
  GIT_WORKTREE: 'GitWorktreeWorkspace',
  DIRECTORY_SANDBOX: 'DirectorySandboxWorkspace',
  NONE: 'NoneWorkspace',
}

const RETAIN = new Set([LIFECYCLE.WAITING_HUMAN, LIFECYCLE.PAUSED, LIFECYCLE.BLOCKED])
const TERMINAL = new Set([LIFECYCLE.COMPLETED, LIFECYCLE.STOPPED, LIFECYCLE.FAILED])
const MODES = new Set(Object.values(WORKSPACE_MODE))
const LIFECYCLES = new Set(Object.values(LIFECYCLE))
const SAFE_ID = /^[a-z0-9][a-z0-9-]*$/
const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'design', 'workspace-isolation', 'schema.json')

let cachedSchema

export function loadWorkspaceSchema() {
  if (!cachedSchema) cachedSchema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8'))
  return cachedSchema
}

export function validateDef(defName, data) {
  const root = loadWorkspaceSchema()
  return validateRecord({ $ref: `#/definitions/${defName}`, definitions: root.definitions }, data)
}

export function resolveWorkspacePolicy(templateId, input = {}) {
  switch (templateId) {
    case TEMPLATE_ID.CONSTRUCTION:
      return { mode: WORKSPACE_MODE.ISOLATED_WRITE, shared_source: false, per_worker_scratch: false }
    case TEMPLATE_ID.OPTIMIZE: {
      const kind = input.resource_kind
      if (!kind) throw new Error('optimize 必须提供 resource_kind')
      if (kind === 'git' || kind === 'files') {
        return { mode: WORKSPACE_MODE.ISOLATED_WRITE, shared_source: false, per_worker_scratch: false }
      }
      if (kind === 'document' || kind === 'config' || kind === 'other') {
        return { mode: WORKSPACE_MODE.SANDBOX, shared_source: false, per_worker_scratch: false }
      }
      throw new Error(`未知 resource_kind: ${kind}`)
    }
    case TEMPLATE_ID.DIAGNOSE:
      return {
        mode: WORKSPACE_MODE.ISOLATED_WRITE,
        freeze_from: 'diagnose',
        shared_source: false,
        per_worker_scratch: false,
      }
    case TEMPLATE_ID.EXPLORE:
      return { mode: WORKSPACE_MODE.ISOLATED_READ, shared_source: true, per_worker_scratch: true }
    default:
      throw new Error(`未知 template_id: ${templateId}`)
  }
}

export function concurrencyKey({ repository, task_identity }) {
  return `${requireText(repository, 'repository')}::${requireText(task_identity, 'task_identity')}`
}

export function integrationResourceKey({ repository, target_ref }) {
  return `repo:${requireText(repository, 'repository')}:target:${requireText(target_ref, 'target_ref')}:integration`
}

export function mapFromPortableRun(run) {
  if (!run || typeof run !== 'object') throw new Error('portable run 必须是对象')
  return {
    logical_run_id: run.run_id,
    workspace_id: run.workspace_id,
    repository: run.repository,
    base_ref: run.base_ref,
    base_commit: run.base_commit,
    work_branch: run.work_branch,
    current_head: run.current_head,
  }
}

export function createRegistry(options = {}) {
  return {
    workspaces: new Map(),
    locks: new Map(),
    locksByKey: new Map(),
    timeline: [],
    archived: new Map(),
    ports: new Set(),
    nextPort: Number.isInteger(options.firstPort) ? options.firstPort : 39100,
    lockSeq: 0,
    now: typeof options.now === 'function' ? options.now : () => new Date(),
  }
}

export function getRunWorkspace(registry, logicalRunId) {
  const id = requireText(logicalRunId, 'logical_run_id')
  const ws = registry.workspaces.get(id)
  if (!ws) throw new Error(`Run Workspace 不存在: ${id}（禁止猜路径）`)
  return clone(ws)
}

export function allocateWorkspace(registry, spec) {
  if (!spec || typeof spec !== 'object') throw new Error('allocateWorkspace 需要 spec')
  const logical_run_id = assertSafeId(spec.logical_run_id, 'logical_run_id')
  const existing = registry.workspaces.get(logical_run_id)
  if (existing) {
    return reuseWorkspace(registry, existing, spec)
  }

  const policy = spec.mode
    ? { mode: spec.mode }
    : resolveWorkspacePolicy(spec.template_id, spec)
  const mode = policy.mode
  if (!MODES.has(mode)) throw new Error(`非法 workspace_mode: ${mode}`)

  if (!spec.allow_parallel) {
    const key = spec.concurrency_key
      || (spec.repository && spec.task_identity
        ? concurrencyKey({ repository: spec.repository, task_identity: spec.task_identity })
        : undefined)
    if (key) assertConcurrency(registry, key, logical_run_id)
  }

  const created_at = iso(registry.now())
  const workspace_id = spec.workspace_id || `ws-${logical_run_id}`
  requireText(workspace_id, 'workspace_id')
  const workRoot = mode === WORKSPACE_MODE.NONE ? spec.work_root : requireText(spec.work_root, 'work_root')
  const records_path = join(requireText(workRoot || spec.records_root, 'work_root/records_root'), 'records', logical_run_id)
  mkdirSync(records_path, { recursive: true })

  const ws = {
    workspace_id,
    logical_run_id,
    workspace_mode: mode,
    workspace_path: null,
    source_path: null,
    records_path,
    provider_id: PROVIDER.NONE,
    repository: spec.repository || null,
    repository_path: spec.repository_path || null,
    base_ref: spec.base_ref || null,
    base_commit: spec.base_commit || null,
    work_branch: spec.work_branch || null,
    current_head: null,
    source_revision: 'none',
    config_snapshot_revision: spec.config_snapshot_revision || 'unspecified',
    lifecycle: LIFECYCLE.READY,
    concurrency_key: spec.concurrency_key
      || (spec.repository && spec.task_identity
        ? concurrencyKey({ repository: spec.repository, task_identity: spec.task_identity })
        : undefined),
    resources: {},
    created_at,
    abandoned: false,
    hold_integration: false,
    hold_review: false,
    policy,
  }

  try {
    if (mode === WORKSPACE_MODE.NONE) {
      ws.provider_id = PROVIDER.NONE
      ws.source_revision = 'none'
    } else {
      ws.workspace_path = join(workRoot, workspace_id)
      mkdirSync(ws.workspace_path, { recursive: true })
      if (mode === WORKSPACE_MODE.SANDBOX) {
        materializeSandbox(ws, spec)
      } else {
        materializeGit(ws, spec, mode)
      }
      assertNotSharedSource(ws.source_path, spec.forbidden_source_paths)
      allocateResources(registry, ws)
      mkdirSync(join(ws.workspace_path, 'workers'), { recursive: true })
      mkdirSync(join(ws.workspace_path, 'artifacts'), { recursive: true })
    }
  } catch (err) {
    rollbackAllocate(ws)
    throw err
  }

  const errors = validateDef('workspaceIdentity', identityView(ws))
  if (errors.length) throw new Error(`workspace 数据契约校验失败: ${errors.join('; ')}`)
  writeFileSync(join(records_path, 'identity.json'), JSON.stringify(identityView(ws), null, 2) + '\n')
  registry.workspaces.set(logical_run_id, ws)
  emit(registry, { type: 'workspace_allocated', logical_run_id, workspace_id, mode })
  return clone(ws)
}

export function setLifecycle(registry, logicalRunId, lifecycle, extra = {}) {
  if (!LIFECYCLES.has(lifecycle)) throw new Error(`非法 lifecycle: ${lifecycle}`)
  const ws = mutable(registry, logicalRunId)
  ws.lifecycle = lifecycle
  if (extra.hold_integration === true) ws.hold_integration = true
  if (extra.hold_integration === false) ws.hold_integration = false
  if (extra.hold_review === true) ws.hold_review = true
  if (extra.hold_review === false) ws.hold_review = false
  emit(registry, { type: 'lifecycle', logical_run_id: logicalRunId, lifecycle })
  persistIdentity(ws)
  return clone(ws)
}

export function markAbandoned(registry, logicalRunId) {
  const ws = mutable(registry, logicalRunId)
  ws.abandoned = true
  emit(registry, { type: 'abandoned', logical_run_id: logicalRunId })
  return clone(ws)
}

export function recordSourceSync(registry, logicalRunId, { current_head, source_revision } = {}) {
  const ws = mutable(registry, logicalRunId)
  if (current_head) ws.current_head = requireText(current_head, 'current_head')
  if (source_revision) ws.source_revision = requireText(source_revision, 'source_revision')
  emit(registry, { type: 'source_sync', logical_run_id: logicalRunId, current_head: ws.current_head })
  persistIdentity(ws)
  return clone(ws)
}

export function workerScratchPath(workspace, workerId) {
  if (!workspace.workspace_path) throw new Error('NONE workspace 没有 scratch')
  const id = assertSafeId(workerId, 'worker_id')
  const p = join(workspace.workspace_path, 'workers', id)
  mkdirSync(p, { recursive: true })
  return p
}

export function assembleWorkerContext(workspace, workerId) {
  return {
    workspace_id: workspace.workspace_id,
    source_path: workspace.source_path,
    scratch_path: workerScratchPath(workspace, workerId),
    sibling_scratch_paths: [],
  }
}

export function writeWorkerFile(workspace, workerId, rel, content) {
  const root = workerScratchPath(workspace, workerId)
  const target = resolveInside(root, rel)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
  return target
}

export function readWorkerFile(workspace, workerId, rel) {
  const root = workerScratchPath(workspace, workerId)
  return readFileSync(resolveInside(root, rel), 'utf-8')
}

export function writeSourceFile(workspace, rel, content) {
  if (workspace.workspace_mode === WORKSPACE_MODE.ISOLATED_READ) {
    throw new Error('ISOLATED_READ 禁止写入 source')
  }
  if (!workspace.source_path) throw new Error('当前 Mode 没有可写 source')
  const target = resolveInside(workspace.source_path, rel)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
  return target
}

export function readSourceFile(workspace, rel) {
  if (!workspace.source_path) throw new Error('当前 Mode 没有 source')
  return readFileSync(resolveInside(workspace.source_path, rel), 'utf-8')
}

export function buildAttemptProvenance(workspace, { node, attempt }) {
  let verified_head = workspace.current_head
  let verified_branch = workspace.work_branch
  if (workspace.source_path && isGitDir(workspace.source_path)) {
    verified_head = git(['rev-parse', 'HEAD'], workspace.source_path)
    const br = git(['rev-parse', '--abbrev-ref', 'HEAD'], workspace.source_path)
    verified_branch = br === 'HEAD' ? null : br
  }
  const prov = {
    workspace_id: workspace.workspace_id,
    logical_run_id: workspace.logical_run_id,
    source_revision: workspace.source_revision,
    base_commit: workspace.base_commit,
    work_branch: workspace.work_branch,
    verified_branch,
    verified_head: verified_head || workspace.source_revision,
    config_snapshot_revision: workspace.config_snapshot_revision,
    node: requireText(node, 'node'),
    attempt: requireAttempt(attempt),
  }
  const errors = validateDef('attemptProvenance', prov)
  if (errors.length) throw new Error(`attempt provenance 校验失败: ${errors.join('; ')}`)
  return prov
}

export function assertProofBinding(workspace, proof) {
  if (!proof || typeof proof !== 'object') throw new Error('proof 必须是对象')
  if (proof.workspace_id !== workspace.workspace_id) {
    throw new Error(`Proof workspace_id(${proof.workspace_id}) ≠ 本 Run(${workspace.workspace_id})`)
  }
  if (!workspace.source_path || !isGitDir(workspace.source_path)) {
    if (proof.verified_head && proof.verified_head !== workspace.current_head && proof.verified_head !== workspace.source_revision) {
      throw new Error('Proof verified_head 与 workspace 不一致')
    }
    return true
  }
  const actualHead = git(['rev-parse', 'HEAD'], workspace.source_path)
  if (proof.verified_head !== actualHead) {
    throw new Error(`Proof verified_head(${proof.verified_head}) ≠ 实际 HEAD(${actualHead})`)
  }
  if (workspace.work_branch) {
    const actualBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'], workspace.source_path)
    if (proof.verified_branch !== actualBranch) {
      throw new Error(`Proof verified_branch(${proof.verified_branch}) ≠ 实际分支(${actualBranch})`)
    }
  }
  return true
}

export function computeIntegrationCheckpoint({ base_ref, base_commit, target_head }) {
  return computeCheckpoint(
    { base_ref: requireText(base_ref, 'base_ref'), base_commit: requireText(base_commit, 'base_commit') },
    { targetHead: requireText(target_head, 'target_head') },
  )
}

export function assertIntegrationAllowed({ checkpoint, formalStore, targetRecordId, proofs }) {
  if (!checkpoint || typeof checkpoint !== 'object') throw new Error('checkpoint 必须是对象')
  if (!Array.isArray(proofs) || proofs.length === 0) {
    throw new Error('集成必须提供待校验 Proof')
  }
  const id = requireText(targetRecordId, 'targetRecordId')
  const stale = []
  for (const proof of proofs) {
    const st = coverageStatus(formalStore, proof, id)
    if (st.status !== COVERING) stale.push({ proof: proof.record_id, status: st.status })
  }
  if (checkpoint.target_advanced && stale.length > 0) {
    const err = new Error('target 已前进且存在未覆盖当前 Revision 的 Proof，拒绝沿用旧证明')
    err.stale = stale
    throw err
  }
  if (!checkpoint.target_advanced && stale.length > 0) {
    const err = new Error('当前 Revision 未被有效 Proof 覆盖，拒绝集成')
    err.stale = stale
    throw err
  }
  return { ok: true, proofs_state: checkpoint.target_advanced ? 'rerun_completed' : 'still_valid' }
}

export function acquireLock(registry, spec) {
  expireLocks(registry)
  const logical_run_id = requireText(spec.logical_run_id, 'logical_run_id')
  const resource_key = requireText(spec.resource_key, 'resource_key')
  const owner = requireText(spec.owner, 'owner')
  const ttl = Number.isInteger(spec.ttl_ms) && spec.ttl_ms > 0 ? spec.ttl_ms : 60 * 60 * 1000
  const activeId = registry.locksByKey.get(resource_key)
  if (activeId) {
    const held = registry.locks.get(activeId)
    if (held && !held.released_at) {
      if (held.logical_run_id !== logical_run_id) {
        throw new Error(`资源锁被占用: ${resource_key} by ${held.logical_run_id}`)
      }
      held.expires_at = iso(new Date(registry.now().getTime() + ttl))
      emit(registry, { type: 'lock_refreshed', lock_id: held.lock_id, resource_key })
      return clone(held)
    }
  }
  const acquired_at = iso(registry.now())
  const lock = {
    lock_id: `lk-${++registry.lockSeq}`,
    logical_run_id,
    resource_key,
    owner,
    acquired_at,
    expires_at: iso(new Date(registry.now().getTime() + ttl)),
  }
  const errors = validateDef('resourceLock', lock)
  if (errors.length) throw new Error(`lock 数据契约校验失败: ${errors.join('; ')}`)
  registry.locks.set(lock.lock_id, lock)
  registry.locksByKey.set(resource_key, lock.lock_id)
  emit(registry, { type: 'lock_acquired', lock_id: lock.lock_id, resource_key, logical_run_id })
  return clone(lock)
}

export function releaseLock(registry, lockId, extra = {}) {
  const lock = registry.locks.get(requireText(lockId, 'lock_id'))
  if (!lock) throw new Error(`锁不存在: ${lockId}`)
  if (lock.released_at) return clone(lock)
  lock.released_at = iso(registry.now())
  lock.release_reason = extra.reason || 'released'
  if (registry.locksByKey.get(lock.resource_key) === lock.lock_id) {
    registry.locksByKey.delete(lock.resource_key)
  }
  emit(registry, { type: 'lock_released', lock_id: lock.lock_id, resource_key: lock.resource_key })
  return clone(lock)
}

export function activeLockFor(registry, resourceKey) {
  expireLocks(registry)
  const id = registry.locksByKey.get(resourceKey)
  if (!id) return undefined
  const lock = registry.locks.get(id)
  if (!lock || lock.released_at) return undefined
  return clone(lock)
}

export function cleanupWorkspace(registry, logicalRunId, opts = {}) {
  const ws = mutable(registry, logicalRunId)
  if (RETAIN.has(ws.lifecycle)) {
    throw new Error(`${ws.lifecycle} 不清理 workspace`)
  }
  if (ws.hold_integration || ws.hold_review) {
    throw new Error('仍有未完成 Integration 或人工复验，不得立即删除')
  }
  if (!TERMINAL.has(ws.lifecycle) && !opts.force_abandoned) {
    throw new Error('非终态 workspace 不可 cleanup')
  }

  const audit = {
    logical_run_id: ws.logical_run_id,
    workspace_id: ws.workspace_id,
    at: iso(registry.now()),
    worktree: 'skipped',
    branch: 'skipped',
    artifacts: 'skipped',
    records: 'retained',
  }

  if (ws.provider_id === PROVIDER.GIT_WORKTREE && ws.source_path && ws.repository_path) {
    audit.worktree = removeGitWorktree(ws)
    audit.branch = opts.keep_branch ? 'kept' : deleteGitBranch(ws)
  } else if (ws.provider_id === PROVIDER.GIT_WORKTREE) {
    audit.worktree = 'absent'
    audit.branch = 'absent'
  }

  if (ws.workspace_path && existsSync(ws.workspace_path)) {
    rmSync(ws.workspace_path, { recursive: true, force: true })
    audit.artifacts = 'removed'
  } else if (ws.workspace_path) {
    audit.artifacts = 'absent'
  }

  const errors = validateDef('cleanupAudit', audit)
  if (errors.length) throw new Error(`cleanup 审计校验失败: ${errors.join('; ')}`)
  if (!existsSync(ws.records_path)) {
    throw new Error('cleanup 不得删除 records_path，但记录目录已不存在')
  }

  registry.archived.set(logicalRunId, { identity: identityView(ws), audit })
  registry.workspaces.delete(logicalRunId)
  emit(registry, { type: 'workspace_cleaned', logical_run_id: logicalRunId, audit })
  return audit
}

export function recoverStale(registry) {
  expireLocks(registry)
  const recovered = []
  const cleanup_eligible = []
  const expired_locks = registry.timeline
    .filter(e => e.type === 'lock_released' && e.reason === 'expired')
    .map(e => e.lock_id)
  for (const ws of registry.workspaces.values()) {
    if (RETAIN.has(ws.lifecycle)) {
      if (ws.abandoned) recovered.push(ws.logical_run_id)
      continue
    }
    if (ws.abandoned && (TERMINAL.has(ws.lifecycle) || ws.lifecycle === LIFECYCLE.RUNNING)) {
      cleanup_eligible.push(ws.logical_run_id)
    }
  }
  emit(registry, { type: 'stale_scan', recovered, cleanup_eligible })
  return { recovered, cleanup_eligible, expired_locks }
}

function reuseWorkspace(registry, existing, spec) {
  if (spec.mode && spec.mode !== existing.workspace_mode) {
    throw new Error('禁止切换已有 Run 的 Workspace Mode / Source Workspace')
  }
  if (spec.template_id) {
    const policy = resolveWorkspacePolicy(spec.template_id, spec)
    if (policy.mode !== existing.workspace_mode) {
      throw new Error('禁止切换已有 Run 的 Workspace Mode / Source Workspace')
    }
  }
  if (spec.repository_path && existing.repository_path && resolve(spec.repository_path) !== resolve(existing.repository_path)) {
    throw new Error('禁止切换已有 Run 的仓库')
  }
  if (spec.config_snapshot_revision && spec.config_snapshot_revision !== existing.config_snapshot_revision) {
    existing.config_snapshot_revision = spec.config_snapshot_revision
    emit(registry, { type: 'config_snapshot_changed', logical_run_id: existing.logical_run_id })
    persistIdentity(existing)
  }
  return clone(existing)
}

function materializeGit(ws, spec, mode) {
  const repo = requireText(spec.repository_path, 'repository_path')
  ws.repository_path = repo
  ws.repository = spec.repository || gitRepoSlug(repo)
  const baseRef = spec.base_ref || 'HEAD'
  const baseCommit = spec.base_commit || git(['rev-parse', baseRef], repo)
  ws.base_ref = spec.base_ref || baseRef
  ws.base_commit = baseCommit
  ws.provider_id = PROVIDER.GIT_WORKTREE
  const source = join(ws.workspace_path, 'source')
  if (mode === WORKSPACE_MODE.ISOLATED_WRITE) {
    const branch = spec.work_branch || `vwf/run/${ws.logical_run_id}`
    git(['branch', branch, baseCommit], repo)
    git(['worktree', 'add', source, branch], repo)
    ws.work_branch = branch
  } else {
    git(['worktree', 'add', '--detach', source, baseCommit], repo)
    ws.work_branch = null
  }
  ws.source_path = source
  ws.current_head = git(['rev-parse', 'HEAD'], source)
  ws.source_revision = ws.current_head
}

function materializeSandbox(ws) {
  ws.provider_id = PROVIDER.DIRECTORY_SANDBOX
  ws.source_path = join(ws.workspace_path, 'source')
  mkdirSync(ws.source_path, { recursive: true })
  ws.repository = ws.repository || 'local-sandbox'
  ws.base_ref = null
  ws.base_commit = null
  ws.work_branch = null
  ws.current_head = null
  ws.source_revision = 'unversioned'
}

function allocateResources(registry, ws) {
  const tmpdir = join(ws.workspace_path, 'tmp')
  const build_dir = join(ws.workspace_path, 'build')
  const cache_dir = join(ws.workspace_path, 'cache')
  mkdirSync(tmpdir, { recursive: true })
  mkdirSync(build_dir, { recursive: true })
  mkdirSync(cache_dir, { recursive: true })
  let port = registry.nextPort++
  while (registry.ports.has(port)) port = registry.nextPort++
  registry.ports.add(port)
  ws.resources = {
    tmpdir,
    build_dir,
    cache_dir,
    port,
    test_db: `vwf_${ws.logical_run_id.replace(/-/g, '_')}`,
  }
}

function assertNotSharedSource(sourcePath, forbidden) {
  const extra = Array.isArray(forbidden) ? forbidden : []
  const list = [process.cwd(), ...extra]
  const resolved = resolve(sourcePath)
  for (const raw of list) {
    if (!raw) continue
    if (resolved === resolve(raw)) {
      throw new Error('禁止使用共享主仓库 cwd 作为 Run Workspace source')
    }
  }
}

function assertConcurrency(registry, key, logicalRunId) {
  for (const ws of registry.workspaces.values()) {
    if (ws.concurrency_key === key && ws.logical_run_id !== logicalRunId && !TERMINAL.has(ws.lifecycle)) {
      throw new Error(`concurrency_key 已有 Active Run: ${ws.logical_run_id}`)
    }
  }
}

function expireLocks(registry) {
  const now = registry.now()
  for (const lock of registry.locks.values()) {
    if (lock.released_at) continue
    if (new Date(lock.expires_at) <= now) {
      lock.released_at = iso(now)
      lock.release_reason = 'expired'
      if (registry.locksByKey.get(lock.resource_key) === lock.lock_id) {
        registry.locksByKey.delete(lock.resource_key)
      }
      emit(registry, { type: 'lock_released', lock_id: lock.lock_id, resource_key: lock.resource_key, reason: 'expired' })
    }
  }
}

function removeGitWorktree(ws) {
  try {
    git(['worktree', 'remove', '--force', ws.source_path], ws.repository_path)
    return 'removed'
  } catch {
    try { rmSync(ws.source_path, { recursive: true, force: true }) } catch { /* ignore */ }
    try { git(['worktree', 'prune'], ws.repository_path) } catch { /* ignore */ }
    return existsSync(ws.source_path) ? 'absent' : 'removed'
  }
}

function deleteGitBranch(ws) {
  if (!ws.work_branch) return 'absent'
  try {
    git(['branch', '-D', ws.work_branch], ws.repository_path)
    return 'deleted'
  } catch {
    return 'absent'
  }
}

function rollbackAllocate(ws) {
  if (ws.provider_id === PROVIDER.GIT_WORKTREE && ws.repository_path && ws.source_path) {
    try { removeGitWorktree(ws) } catch { /* ignore */ }
    try { deleteGitBranch(ws) } catch { /* ignore */ }
  }
  if (ws.workspace_path && existsSync(ws.workspace_path)) {
    try { rmSync(ws.workspace_path, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

function persistIdentity(ws) {
  mkdirSync(ws.records_path, { recursive: true })
  writeFileSync(join(ws.records_path, 'identity.json'), JSON.stringify(identityView(ws), null, 2) + '\n')
}

function identityView(ws) {
  const view = {
    workspace_id: ws.workspace_id,
    logical_run_id: ws.logical_run_id,
    workspace_mode: ws.workspace_mode,
    workspace_path: ws.workspace_path,
    source_path: ws.source_path,
    records_path: ws.records_path,
    provider_id: ws.provider_id,
    repository: ws.repository,
    base_ref: ws.base_ref,
    base_commit: ws.base_commit,
    work_branch: ws.work_branch,
    current_head: ws.current_head,
    source_revision: ws.source_revision,
    config_snapshot_revision: ws.config_snapshot_revision,
    lifecycle: ws.lifecycle,
    created_at: ws.created_at,
    resources: { ...ws.resources },
  }
  if (ws.concurrency_key) view.concurrency_key = ws.concurrency_key
  return view
}

function mutable(registry, logicalRunId) {
  const ws = registry.workspaces.get(requireText(logicalRunId, 'logical_run_id'))
  if (!ws) throw new Error(`Run Workspace 不存在: ${logicalRunId}（禁止猜路径）`)
  return ws
}

function emit(registry, event) {
  registry.timeline.push({ at: iso(registry.now()), ...event })
}

function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch (e) {
    const detail = `${e.stderr || e.stdout || e.message}`.trim()
    const err = new Error(detail || e.message)
    err.cause = e
    throw err
  }
}

function gitRepoSlug(repoPath) {
  try {
    const url = git(['remote', 'get-url', 'origin'], repoPath)
    return url.replace(/\.git$/, '').replace(/^.*[:/]([^/]+\/[^/]+)$/, '$1')
  } catch {
    return repoPath
  }
}

function isGitDir(dir) {
  try {
    git(['rev-parse', '--is-inside-work-tree'], dir)
    return true
  } catch {
    return false
  }
}

function resolveInside(root, rel) {
  if (typeof rel !== 'string' || !rel.trim() || rel.includes('\0')) {
    throw new Error('非法相对路径')
  }
  if (isAbsolute(rel)) throw new Error('禁止绝对路径')
  const target = resolve(root, rel)
  const rootR = resolve(root)
  if (target !== rootR && !target.startsWith(rootR + sep)) {
    throw new Error('路径逃出允许根目录')
  }
  return target
}

function assertSafeId(value, label) {
  const v = requireText(value, label)
  if (!SAFE_ID.test(v)) throw new Error(`非法 ${label}: ${v}（须为小写字母/数字/连字符）`)
  return v
}

function requireText(v, label) {
  if (typeof v !== 'string' || !/\S/.test(v)) throw new Error(`${label} 必须是非空字符串`)
  return v
}

function requireAttempt(n) {
  if (!Number.isInteger(n) || n < 1) throw new Error('attempt 必须是正整数')
  return n
}

function iso(d) {
  return (d instanceof Date ? d : new Date(d)).toISOString()
}

function clone(v) {
  return structuredClone(v)
}
