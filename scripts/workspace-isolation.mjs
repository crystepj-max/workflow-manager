#!/usr/bin/env node
// Workspace / Resource / Integration Isolation 内核（#93 Core）
// Registry 默认内存；Git worktree + directory sandbox；锁按 resource_key 作用域。
// 证明失效只调用 #78，不平行实现 provenance。

import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
const RESERVED_WORKSPACE_IDS = new Set(['records'])
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
  const workspace_id = assertSafeId(spec.workspace_id || `ws-${logical_run_id}`, 'workspace_id')
  if (RESERVED_WORKSPACE_IDS.has(workspace_id)) {
    throw new Error(`workspace_id 为保留名: ${workspace_id}`)
  }
  for (const other of registry.workspaces.values()) {
    if (other.workspace_id === workspace_id) {
      throw new Error(`workspace_id 已被占用: ${workspace_id}`)
    }
  }
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
      assertInsideRoot(workRoot, ws.workspace_path, 'workspace_path')
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
  if (ws.source_path && isGitDir(ws.source_path)) {
    const actual = git(['rev-parse', 'HEAD'], ws.source_path)
    if (current_head && current_head !== actual) {
      throw new Error(`recordSourceSync 禁止自报 HEAD（${current_head} ≠ 实况 ${actual}）`)
    }
    if (source_revision && source_revision !== actual) {
      throw new Error(`recordSourceSync 禁止自报 source_revision（${source_revision} ≠ 实况 ${actual}）`)
    }
    ws.current_head = actual
    ws.source_revision = actual
  } else {
    if (current_head) ws.current_head = requireText(current_head, 'current_head')
    if (source_revision) ws.source_revision = requireText(source_revision, 'source_revision')
  }
  emit(registry, { type: 'source_sync', logical_run_id: logicalRunId, current_head: ws.current_head })
  persistIdentity(ws)
  return clone(ws)
}

export function workerScratchPath(workspace, workerId) {
  if (!workspace.workspace_path) throw new Error('NONE workspace 没有 scratch')
  const id = assertSafeId(workerId, 'worker_id')
  const wsReal = canonicalDir(workspace.workspace_path, 'workspace_path')
  const workers = join(workspace.workspace_path, 'workers')
  ensureRealDirContained(workers, wsReal, 'workers')
  const p = join(workers, id)
  ensureRealDirContained(p, realpathSync(workers), 'scratch')
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
  const target = resolveInside(root, rel, workspace.workspace_path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
  return target
}

export function readWorkerFile(workspace, workerId, rel) {
  const root = workerScratchPath(workspace, workerId)
  return readFileSync(resolveInside(root, rel, workspace.workspace_path), 'utf-8')
}

export function writeSourceFile(workspace, rel, content) {
  if (workspace.workspace_mode === WORKSPACE_MODE.ISOLATED_READ) {
    throw new Error('ISOLATED_READ 禁止写入 source')
  }
  if (!workspace.source_path) throw new Error('当前 Mode 没有可写 source')
  const target = resolveInside(workspace.source_path, rel, workspace.workspace_path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
  return target
}

export function readSourceFile(workspace, rel) {
  if (!workspace.source_path) throw new Error('当前 Mode 没有 source')
  return readFileSync(resolveInside(workspace.source_path, rel, workspace.workspace_path), 'utf-8')
}

export function buildAttemptProvenance(workspace, { node, attempt }) {
  let verified_head = workspace.current_head
  let verified_branch = workspace.work_branch
  if (workspace.source_path && isGitDir(workspace.source_path)) {
    verified_head = git(['rev-parse', 'HEAD'], workspace.source_path)
    const br = git(['rev-parse', '--abbrev-ref', 'HEAD'], workspace.source_path)
    verified_branch = br === 'HEAD' ? null : br
    if (workspace.source_revision !== verified_head) {
      throw new Error('Git workspace 的 source_revision 落后于实况 HEAD，需要先 recordSourceSync')
    }
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
  const fields = [
    ['workspace_id', proof.workspace_id, workspace.workspace_id],
    ['logical_run_id', proof.logical_run_id, workspace.logical_run_id],
    ['source_revision', proof.source_revision, workspace.source_revision],
    ['base_commit', proof.base_commit, workspace.base_commit],
    ['work_branch', proof.work_branch, workspace.work_branch],
    ['config_snapshot_revision', proof.config_snapshot_revision, workspace.config_snapshot_revision],
  ]
  for (const [label, got, expected] of fields) {
    if (got !== expected) throw new Error(`Proof ${label}(${got}) ≠ workspace(${expected})`)
  }
  if (!workspace.source_path || !isGitDir(workspace.source_path)) {
    if (proof.verified_head !== workspace.current_head && proof.verified_head !== workspace.source_revision) {
      throw new Error('Proof verified_head 与 workspace 不一致')
    }
    return true
  }
  const actualHead = git(['rev-parse', 'HEAD'], workspace.source_path)
  if (proof.verified_head !== actualHead) {
    throw new Error(`Proof verified_head(${proof.verified_head}) ≠ 实际 HEAD(${actualHead})`)
  }
  if (proof.source_revision !== actualHead) {
    throw new Error(`Proof source_revision(${proof.source_revision}) ≠ 实际 HEAD(${actualHead})`)
  }
  if (workspace.source_revision !== actualHead) {
    throw new Error(`workspace source_revision(${workspace.source_revision}) ≠ 实际 HEAD(${actualHead})`)
  }
  if (workspace.work_branch) {
    const actualBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'], workspace.source_path)
    if (proof.verified_branch !== actualBranch) {
      throw new Error(`Proof verified_branch(${proof.verified_branch}) ≠ 实际分支(${actualBranch})`)
    }
  }
  return true
}

export function observeTargetHead(repositoryPath, ref) {
  return git(['rev-parse', requireText(ref, 'ref')], requireText(repositoryPath, 'repository_path'))
}

export function computeIntegrationCheckpoint({ base_ref, base_commit, target_head }) {
  return computeCheckpoint(
    { base_ref: requireText(base_ref, 'base_ref'), base_commit: requireText(base_commit, 'base_commit') },
    { targetHead: requireText(target_head, 'target_head') },
  )
}

export function computeIntegrationCheckpointFromRepo({
  base_ref, base_commit, repository_path, target_ref,
}) {
  const observed = observeTargetHead(repository_path, target_ref || base_ref)
  return computeIntegrationCheckpoint({ base_ref, base_commit, target_head: observed })
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
      if (held.owner !== owner) {
        throw new Error(`锁 owner 不匹配，拒绝刷新: ${held.owner} ≠ ${owner}`)
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

export function releaseLock(registry, spec) {
  if (!spec || typeof spec !== 'object') {
    throw new Error('releaseLock 必须提供 { lock_id, owner, logical_run_id }')
  }
  const lock = registry.locks.get(requireText(spec.lock_id, 'lock_id'))
  if (!lock) throw new Error(`锁不存在: ${spec.lock_id}`)
  if (lock.released_at) return clone(lock)
  if (lock.logical_run_id !== requireText(spec.logical_run_id, 'logical_run_id')
      || lock.owner !== requireText(spec.owner, 'owner')) {
    throw new Error('锁 owner/run 不匹配，拒绝释放')
  }
  lock.released_at = iso(registry.now())
  lock.release_reason = spec.reason || 'released'
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
  const staleForce = opts.force_abandoned === true
    && ws.abandoned === true
    && ws.lifecycle === LIFECYCLE.RUNNING
  if (!TERMINAL.has(ws.lifecycle) && !staleForce) {
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
  if (mode === WORKSPACE_MODE.ISOLATED_READ) freezeReadOnlyTree(source)
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

function assertInsideRoot(root, target, label) {
  const rootR = resolve(root)
  const t = resolve(target)
  if (t === rootR || !t.startsWith(rootR + sep)) {
    throw new Error(`${label} 逃出 work_root`)
  }
}

function walkNoFollow(dir, visit) {
  if (!dir || !existsSync(dir)) return
  const st = lstatSync(dir)
  visit(dir, st)
  if (!st.isDirectory() || st.isSymbolicLink()) return
  for (const name of readdirSync(dir)) {
    walkNoFollow(join(dir, name), visit)
  }
}

function stripWriteBits(dir) {
  walkNoFollow(dir, (p, st) => {
    if (st.isSymbolicLink()) return
    chmodSync(p, (st.mode & 0o777) & ~0o222)
  })
}

function restoreOwnerWrite(dir) {
  walkNoFollow(dir, (p, st) => {
    if (st.isSymbolicLink()) return
    chmodSync(p, (st.mode & 0o777) | 0o200)
  })
}

function setImmutableFlag(dir, enable) {
  walkNoFollow(dir, (p, st) => {
    if (st.isSymbolicLink()) return
    try {
      if (process.platform === 'darwin') {
        execFileSync('chflags', [enable ? 'uchg' : 'nouchg', p], { stdio: 'pipe' })
      } else if (process.platform === 'linux') {
        execFileSync('chattr', [enable ? '+i' : '-i', p], { stdio: 'pipe' })
      }
    } catch {
      /* 无 CAP_LINUX_IMMUTABLE / overlay 等环境：只读改为 best-effort */
    }
  })
}

function freezeReadOnlyTree(dir) {
  stripWriteBits(dir)
  setImmutableFlag(dir, true)
  const probe = join(dir, '.vwf-readonly-probe')
  try {
    writeFileSync(probe, 'x')
  } catch (e) {
    if (e && (e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'EROFS')) return
    throw e
  }
  try { rmSync(probe) } catch { /* ignore */ }
  // UID 0 且无 immutable 能力时无法挡住直接写；API 层 writeSourceFile 仍拒绝
}

function thawReadOnlyTree(dir) {
  try { setImmutableFlag(dir, false) } catch { /* ignore */ }
  try { restoreOwnerWrite(dir) } catch { /* ignore */ }
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
  try { thawReadOnlyTree(ws.source_path) } catch { /* ignore */ }
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

function isContained(root, candidate) {
  const rootR = resolve(root)
  const t = resolve(candidate)
  return t === rootR || t.startsWith(rootR + sep)
}

function canonicalDir(path, label) {
  const st = lstatSync(path)
  if (st.isSymbolicLink()) throw new Error(`${label} 不得为符号链接`)
  if (!st.isDirectory()) throw new Error(`${label} 必须是目录`)
  return realpathSync(path)
}

function ensureRealDirContained(path, containerReal, label) {
  let st
  try {
    st = lstatSync(path)
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
    mkdirSync(path)
    st = lstatSync(path)
  }
  if (st.isSymbolicLink()) throw new Error(`${label} 不得为符号链接`)
  if (!st.isDirectory()) throw new Error(`${label} 必须是目录`)
  const real = realpathSync(path)
  if (!isContained(containerReal, real)) throw new Error(`${label} 逃出允许根目录`)
  return real
}

function resolveInside(root, rel, ancestor) {
  if (typeof rel !== 'string' || !rel.trim() || rel.includes('\0')) {
    throw new Error('非法相对路径')
  }
  if (isAbsolute(rel)) throw new Error('禁止绝对路径')
  if (existsSync(root)) {
    const st = lstatSync(root)
    if (st.isSymbolicLink()) throw new Error('路径逃出允许根目录')
  }
  const rootReal = existsSync(root) ? realpathSync(root) : resolve(root)
  if (ancestor) {
    const ancestorReal = canonicalDir(ancestor, 'workspace_path')
    if (!isContained(ancestorReal, rootReal)) throw new Error('路径逃出允许根目录')
  }
  const parts = rel.split(/[/\\]/)
  let cur = rootReal
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (!part || part === '.') continue
    if (part === '..') throw new Error('路径逃出允许根目录')
    const next = join(cur, part)
    if (!existsSync(next)) {
      const rest = parts.slice(i).filter(p => p && p !== '.')
      if (rest.some(p => p === '..')) throw new Error('路径逃出允许根目录')
      const candidate = rest.length ? join(cur, ...rest) : cur
      if (!isContained(rootReal, candidate)) throw new Error('路径逃出允许根目录')
      if (ancestor && !isContained(canonicalDir(ancestor, 'workspace_path'), candidate)) {
        throw new Error('路径逃出允许根目录')
      }
      return candidate
    }
    const st = lstatSync(next)
    if (st.isSymbolicLink()) {
      let real
      try {
        real = realpathSync(next)
      } catch {
        throw new Error('路径逃出允许根目录')
      }
      if (!isContained(rootReal, real)) throw new Error('路径逃出允许根目录')
      cur = real
    } else {
      if (!isContained(rootReal, next)) throw new Error('路径逃出允许根目录')
      cur = next
    }
  }
  return cur
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
