// #93 Workspace / Resource Isolation Core 验收
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  WORKSPACE_MODE, TEMPLATE_ID, LIFECYCLE, PROVIDER,
  resolveWorkspacePolicy, concurrencyKey, integrationResourceKey, mapFromPortableRun,
  createRegistry, allocateWorkspace, getRunWorkspace, setLifecycle, markAbandoned,
  recordSourceSync, workerScratchPath, assembleWorkerContext, writeWorkerFile, readWorkerFile,
  writeSourceFile, readSourceFile, buildAttemptProvenance, assertProofBinding,
  computeIntegrationCheckpoint, computeIntegrationCheckpointFromRepo, observeTargetHead,
  assertIntegrationAllowed,
  acquireLock, releaseLock, activeLockFor, cleanupWorkspace, recoverStale,
  loadWorkspaceSchema, validateDef,
} from '../workspace-isolation.mjs'
import * as isolation from '../workspace-isolation.mjs'
import {
  KIND, MEDIA, createStore, appendRecord, toRef, coverageStatus, NOT_COVERING_CURRENT,
} from '../formal-records.mjs'

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.scratch', 'ws-isolation-tests')
mkdirSync(fixtureRoot, { recursive: true })

const cleanups = []
after(() => {
  for (const fn of [...cleanups].reverse()) {
    try { fn() } catch { /* ignore */ }
  }
})

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim()
}

function initRepo() {
  const root = mkdtempSync(join(fixtureRoot, 'repo-'))
  git(['init', '-q', '-b', 'main', '--template='], root)
  git(['config', 'user.email', 't@t'], root)
  git(['config', 'user.name', 't'], root)
  writeFileSync(join(root, 'README.md'), 'base\n')
  git(['add', '-A'], root)
  git(['commit', '-q', '-m', 'init'], root)
  cleanups.push(() => { try { rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ } })
  return root
}

function workRoot() {
  const dir = mkdtempSync(join(fixtureRoot, 'root-'))
  cleanups.push(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } })
  return dir
}

function trackedRegistry() {
  const registry = createRegistry()
  cleanups.push(() => {
    for (const id of [...registry.workspaces.keys()]) {
      const ws = registry.workspaces.get(id)
      if (!ws) continue
      ws.lifecycle = LIFECYCLE.COMPLETED
      ws.hold_integration = false
      ws.hold_review = false
      try { cleanupWorkspace(registry, id) } catch { /* ignore */ }
    }
  })
  return registry
}

function prov() {
  return {
    logical_run_id: 'run-1',
    node: 'dev',
    attempt: 1,
    snapshot_revision: 'snap-1',
    provider: 'test',
    model: 'test',
    produced_by: 'test:dev',
    node_business_outcome: { ok: true },
  }
}

function jsonBody(value) {
  return { media_type: MEDIA.JSON, value }
}

test('schema 可加载；identity/lock 定义存在', () => {
  const schema = loadWorkspaceSchema()
  assert.ok(schema.definitions.workspaceIdentity)
  assert.ok(schema.definitions.resourceLock)
  assert.ok(schema.definitions.attemptProvenance)
  assert.ok(schema.definitions.cleanupAudit)
})

test('A 四套模板 Policy 解析器；NONE 不是默认', () => {
  assert.equal(resolveWorkspacePolicy(TEMPLATE_ID.CONSTRUCTION).mode, WORKSPACE_MODE.ISOLATED_WRITE)
  assert.equal(resolveWorkspacePolicy(TEMPLATE_ID.OPTIMIZE, { resource_kind: 'git' }).mode, WORKSPACE_MODE.ISOLATED_WRITE)
  assert.equal(resolveWorkspacePolicy(TEMPLATE_ID.OPTIMIZE, { resource_kind: 'files' }).mode, WORKSPACE_MODE.ISOLATED_WRITE)
  assert.equal(resolveWorkspacePolicy(TEMPLATE_ID.OPTIMIZE, { resource_kind: 'document' }).mode, WORKSPACE_MODE.SANDBOX)
  assert.equal(resolveWorkspacePolicy(TEMPLATE_ID.OPTIMIZE, { resource_kind: 'config' }).mode, WORKSPACE_MODE.SANDBOX)
  assert.equal(resolveWorkspacePolicy(TEMPLATE_ID.OPTIMIZE, { resource_kind: 'other' }).mode, WORKSPACE_MODE.SANDBOX)
  assert.throws(() => resolveWorkspacePolicy(TEMPLATE_ID.OPTIMIZE), /resource_kind/)
  const diag = resolveWorkspacePolicy(TEMPLATE_ID.DIAGNOSE)
  assert.equal(diag.mode, WORKSPACE_MODE.ISOLATED_WRITE)
  assert.equal(diag.freeze_from, 'diagnose')
  const exp = resolveWorkspacePolicy(TEMPLATE_ID.EXPLORE)
  assert.equal(exp.mode, WORKSPACE_MODE.ISOLATED_READ)
  assert.equal(exp.shared_source, true)
  assert.equal(exp.per_worker_scratch, true)
  for (const id of Object.values(TEMPLATE_ID)) {
    const extra = id === TEMPLATE_ID.OPTIMIZE ? { resource_kind: 'git' } : {}
    assert.notEqual(resolveWorkspacePolicy(id, extra).mode, WORKSPACE_MODE.NONE)
  }
})

test('A 每个需要文件环境的 Run 有独立 workspace_id/path；只能经 getRunWorkspace 取现场', () => {
  const repo = initRepo()
  const root = workRoot()
  const reg = trackedRegistry()
  const a = allocateWorkspace(reg, {
    logical_run_id: 'run-a', mode: WORKSPACE_MODE.ISOLATED_WRITE,
    repository_path: repo, repository: 'org/demo', work_root: root, task_identity: 't-a',
  })
  const b = allocateWorkspace(reg, {
    logical_run_id: 'run-b', mode: WORKSPACE_MODE.ISOLATED_WRITE,
    repository_path: repo, repository: 'org/demo', work_root: root, task_identity: 't-b',
  })
  assert.notEqual(a.workspace_id, b.workspace_id)
  assert.notEqual(a.workspace_path, b.workspace_path)
  assert.notEqual(a.source_path, b.source_path)
  assert.equal(getRunWorkspace(reg, 'run-a').workspace_id, a.workspace_id)
  assert.throws(() => getRunWorkspace(reg, 'missing-run'), /禁止猜路径/)
  assert.equal(isolation.guessWorkspacePath, undefined)
})

test('A 禁止共享主仓 cwd 作为 source', () => {
  const repo = initRepo()
  const root = workRoot()
  const reg = trackedRegistry()
  const forbidden = join(root, 'ws-run-x', 'source')
  assert.throws(() => allocateWorkspace(reg, {
    logical_run_id: 'run-x', mode: WORKSPACE_MODE.ISOLATED_WRITE,
    repository_path: repo, work_root: root, forbidden_source_paths: [forbidden],
  }), /共享主仓库 cwd/)
})

test('A Git 写任务创建独立 worktree + 稳定唯一 branch；未提交文件互不串扰', () => {
  const repo = initRepo()
  const root = workRoot()
  const reg = trackedRegistry()
  const a = allocateWorkspace(reg, {
    logical_run_id: 'run-a', mode: WORKSPACE_MODE.ISOLATED_WRITE,
    repository_path: repo, repository: 'org/demo', work_root: root, task_identity: 't-a',
  })
  const b = allocateWorkspace(reg, {
    logical_run_id: 'run-b', mode: WORKSPACE_MODE.ISOLATED_WRITE,
    repository_path: repo, repository: 'org/demo', work_root: root, task_identity: 't-b',
  })
  assert.equal(a.provider_id, PROVIDER.GIT_WORKTREE)
  assert.equal(a.work_branch, 'vwf/run/run-a')
  assert.equal(b.work_branch, 'vwf/run/run-b')
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], a.source_path), 'vwf/run/run-a')
  writeSourceFile(a, 'secret-a.txt', 'from-a')
  writeFileSync(join(a.resources.cache_dir, 'cache-a'), 'ca')
  assert.equal(existsSync(join(b.source_path, 'secret-a.txt')), false)
  assert.equal(existsSync(join(b.resources.cache_dir, 'cache-a')), false)
  assert.notEqual(git(['rev-parse', '--abbrev-ref', 'HEAD'], repo), 'vwf/run/run-a')
})

test('A Git 只读冻结 detached source；禁止写 source', () => {
  const repo = initRepo()
  const root = workRoot()
  const reg = trackedRegistry()
  const frozen = git(['rev-parse', 'HEAD'], repo)
  const ws = allocateWorkspace(reg, {
    logical_run_id: 'run-read', mode: WORKSPACE_MODE.ISOLATED_READ,
    repository_path: repo, repository: 'org/demo', work_root: root, base_commit: frozen,
  })
  assert.equal(ws.work_branch, null)
  assert.equal(ws.source_revision, frozen)
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], ws.source_path), 'HEAD')
  assert.equal(readSourceFile(ws, 'README.md'), 'base\n')
  assert.throws(() => writeSourceFile(ws, 'hack.txt', 'nope'), /ISOLATED_READ 禁止写入 source/)
  assert.throws(() => writeFileSync(join(ws.source_path, 'bypass.txt'), 'nope'))
  assert.equal(git(['status', '--porcelain'], ws.source_path), '')
})

test('A 同一 Run 验证节点绑定真实 HEAD；另一 workspace 的 Proof 不能背书', () => {
  const repo = initRepo()
  const root = workRoot()
  const reg = trackedRegistry()
  const a = allocateWorkspace(reg, {
    logical_run_id: 'run-a', mode: WORKSPACE_MODE.ISOLATED_WRITE,
    repository_path: repo, repository: 'org/demo', work_root: root, task_identity: 't-a',
  })
  const b = allocateWorkspace(reg, {
    logical_run_id: 'run-b', mode: WORKSPACE_MODE.ISOLATED_WRITE,
    repository_path: repo, repository: 'org/demo', work_root: root, task_identity: 't-b',
  })
  const proofA = buildAttemptProvenance(a, { node: 'review', attempt: 1 })
  assert.equal(validateDef('attemptProvenance', proofA).length, 0)
  assert.equal(assertProofBinding(a, proofA), true)
  assert.throws(() => assertProofBinding(b, proofA), /workspace_id/)
  const forged = { ...proofA, workspace_id: b.workspace_id, logical_run_id: b.logical_run_id }
  assert.throws(() => assertProofBinding(b, forged), /verified_head|verified_branch|source_revision|work_branch/)
})

test('A Fan-out worker 独立 scratch；专家上下文看不到兄弟 scratch', () => {
  const repo = initRepo()
  const root = workRoot()
  const reg = trackedRegistry()
  const ws = allocateWorkspace(reg, {
    logical_run_id: 'run-exp', template_id: TEMPLATE_ID.EXPLORE,
    repository_path: repo, repository: 'org/demo', work_root: root,
  })
  writeWorkerFile(ws, 'expert-a', 'notes.md', 'secret-a')
  writeWorkerFile(ws, 'expert-b', 'notes.md', 'secret-b')
  const ctxA = assembleWorkerContext(ws, 'expert-a')
  assert.equal(ctxA.sibling_scratch_paths.length, 0)
  assert.equal(ctxA.scratch_path, workerScratchPath(ws, 'expert-a'))
  assert.notEqual(ctxA.scratch_path, workerScratchPath(ws, 'expert-b'))
  assert.equal(readWorkerFile(ws, 'expert-a', 'notes.md'), 'secret-a')
  assert.throws(() => readWorkerFile(ws, 'expert-a', join('..', 'expert-b', 'notes.md')), /逃出|非法/)
})

test('A TMP/build/cache/port/test_db 按 Run 隔离', () => {
  const root = workRoot()
  const reg = trackedRegistry()
  const a = allocateWorkspace(reg, {
    logical_run_id: 'run-a', mode: WORKSPACE_MODE.SANDBOX, work_root: root, task_identity: 't-a',
  })
  const b = allocateWorkspace(reg, {
    logical_run_id: 'run-b', mode: WORKSPACE_MODE.SANDBOX, work_root: root, task_identity: 't-b',
  })
  assert.notEqual(a.resources.tmpdir, b.resources.tmpdir)
  assert.notEqual(a.resources.cache_dir, b.resources.cache_dir)
  assert.notEqual(a.resources.port, b.resources.port)
  assert.notEqual(a.resources.test_db, b.resources.test_db)
  assert.match(a.resources.test_db, /^vwf_run_a$/)
  writeFileSync(join(a.resources.tmpdir, 't'), 'a')
  assert.equal(existsSync(join(b.resources.tmpdir, 't')), false)
})

test('A resource-scoped lock：不同 target 可并行；同一 target 受控串行；无 global closeout lock', () => {
  const reg = createRegistry()
  const keyA = integrationResourceKey({ repository: 'org/x', target_ref: 'main' })
  const keyB = integrationResourceKey({ repository: 'org/y', target_ref: 'main' })
  const la = acquireLock(reg, { logical_run_id: 'run-a', resource_key: keyA, owner: 'closeout' })
  const lb = acquireLock(reg, { logical_run_id: 'run-b', resource_key: keyB, owner: 'closeout' })
  assert.ok(la.lock_id)
  assert.ok(lb.lock_id)
  assert.throws(() => acquireLock(reg, {
    logical_run_id: 'run-c', resource_key: keyA, owner: 'closeout',
  }), /资源锁被占用/)
  releaseLock(reg, { lock_id: la.lock_id, owner: 'closeout', logical_run_id: 'run-a' })
  const lc = acquireLock(reg, { logical_run_id: 'run-c', resource_key: keyA, owner: 'closeout' })
  assert.equal(lc.logical_run_id, 'run-c')
  const held = acquireLock(reg, { logical_run_id: 'run-c', resource_key: keyA, owner: 'closeout' })
  assert.equal(held.lock_id, lc.lock_id)
  assert.throws(() => acquireLock(reg, {
    logical_run_id: 'run-c', resource_key: keyA, owner: 'thief',
  }), /owner 不匹配/)
  assert.throws(() => releaseLock(reg, {
    lock_id: lc.lock_id, owner: 'thief', logical_run_id: 'run-c',
  }), /owner\/run 不匹配/)
  assert.throws(() => releaseLock(reg, lc.lock_id), /必须提供/)
  assert.equal(isolation.acquireGlobalCloseoutLock, undefined)
  assert.equal(activeLockFor(reg, 'global:closeout'), undefined)
})

test('A concurrency_key 与 workspace 隔离分离', () => {
  const root = workRoot()
  const reg = trackedRegistry()
  allocateWorkspace(reg, {
    logical_run_id: 'run-a', mode: WORKSPACE_MODE.SANDBOX, work_root: root,
    repository: 'org/demo', task_identity: 'same-task',
  })
  assert.throws(() => allocateWorkspace(reg, {
    logical_run_id: 'run-b', mode: WORKSPACE_MODE.SANDBOX, work_root: root,
    repository: 'org/demo', task_identity: 'same-task',
  }), /concurrency_key 已有 Active Run/)
  const forked = allocateWorkspace(reg, {
    logical_run_id: 'run-b', mode: WORKSPACE_MODE.SANDBOX, work_root: root,
    repository: 'org/demo', task_identity: 'same-task', allow_parallel: true,
  })
  assert.ok(forked.workspace_path)
  assert.notEqual(forked.workspace_path, getRunWorkspace(reg, 'run-a').workspace_path)
  assert.equal(concurrencyKey({ repository: 'org/demo', task_identity: 'same-task' }), 'org/demo::same-task')
})

test('A Integration Checkpoint 发现 target HEAD 变化', () => {
  const still = computeIntegrationCheckpoint({
    base_ref: 'main', base_commit: 'aaa', target_head: 'aaa',
  })
  assert.equal(still.target_advanced, false)
  assert.equal(still.proofs_state, 'still_valid')
  const moved = computeIntegrationCheckpoint({
    base_ref: 'main', base_commit: 'aaa', target_head: 'bbb',
  })
  assert.equal(moved.target_advanced, true)
  assert.equal(moved.ok, false)
  const repo = initRepo()
  const base = git(['rev-parse', 'HEAD'], repo)
  const liveStill = computeIntegrationCheckpointFromRepo({
    base_ref: 'HEAD', base_commit: base, repository_path: repo, target_ref: 'HEAD',
  })
  assert.equal(liveStill.target_advanced, false)
  assert.equal(observeTargetHead(repo, 'HEAD'), base)
  writeFileSync(join(repo, 'more.txt'), 'x')
  git(['add', 'more.txt'], repo)
  git(['commit', '-q', '-m', 'advance-target'], repo)
  const liveMoved = computeIntegrationCheckpointFromRepo({
    base_ref: 'HEAD', base_commit: base, repository_path: repo, target_ref: 'HEAD',
  })
  assert.equal(liveMoved.target_advanced, true)
})

test('A target 更新后旧 Proof 不能为新 Revision 背书（调用 #78）', () => {
  const store = createStore()
  const impl1 = appendRecord(store, {
    record_id: 'impl', kind: KIND.RESULT, body: jsonBody({ sha: 'old' }), provenance: prov(),
  })
  const proof = appendRecord(store, {
    record_id: 'review', kind: KIND.PROOF_DECISION,
    body: jsonBody({ verdict: 'approve' }),
    dependencies: [toRef(impl1)], based_on: toRef(impl1), provenance: prov({ node: 'review' }),
  })
  const checkpoint = computeIntegrationCheckpoint({
    base_ref: 'main', base_commit: 'aaa', target_head: 'bbb',
  })
  appendRecord(store, {
    record_id: 'impl', kind: KIND.RESULT, body: jsonBody({ sha: 'synced' }), provenance: prov({ attempt: 2 }),
  })
  assert.equal(coverageStatus(store, proof, 'impl').status, NOT_COVERING_CURRENT)
  assert.throws(() => assertIntegrationAllowed({
    checkpoint, formalStore: store, targetRecordId: 'impl', proofs: [proof],
  }), /拒绝沿用旧证明/)
  const proof2 = appendRecord(store, {
    record_id: 'review', kind: KIND.PROOF_DECISION,
    body: jsonBody({ verdict: 'approve' }),
    dependencies: [{ record_id: 'impl', record_revision: 2 }],
    based_on: { record_id: 'impl', record_revision: 2 },
    provenance: prov({ node: 'review', attempt: 2 }),
  })
  const ok = assertIntegrationAllowed({
    checkpoint, formalStore: store, targetRecordId: 'impl', proofs: [proof2],
  })
  assert.equal(ok.ok, true)
  assert.equal(ok.proofs_state, 'rerun_completed')
})

test('A WAITING_HUMAN / PAUSED / BLOCKED 不清理；终态 cleanup 可审计且保留 records', () => {
  const root = workRoot()
  const reg = trackedRegistry()
  const ws = allocateWorkspace(reg, {
    logical_run_id: 'run-life', mode: WORKSPACE_MODE.SANDBOX, work_root: root,
  })
  writeFileSync(join(ws.records_path, 'note.txt'), 'keep-me')
  for (const lc of [LIFECYCLE.WAITING_HUMAN, LIFECYCLE.PAUSED, LIFECYCLE.BLOCKED]) {
    setLifecycle(reg, 'run-life', lc)
    assert.throws(() => cleanupWorkspace(reg, 'run-life'), /不清理 workspace/)
    assert.equal(existsSync(ws.workspace_path), true)
  }
  setLifecycle(reg, 'run-life', LIFECYCLE.COMPLETED, { hold_integration: true })
  assert.throws(() => cleanupWorkspace(reg, 'run-life'), /未完成 Integration/)
  setLifecycle(reg, 'run-life', LIFECYCLE.COMPLETED, { hold_integration: false })
  const audit = cleanupWorkspace(reg, 'run-life')
  assert.equal(audit.records, 'retained')
  assert.equal(audit.artifacts, 'removed')
  assert.equal(existsSync(ws.records_path), true)
  assert.equal(readFileSync(join(ws.records_path, 'note.txt'), 'utf-8'), 'keep-me')
  assert.equal(existsSync(ws.workspace_path), false)
  assert.throws(() => getRunWorkspace(reg, 'run-life'), /禁止猜路径/)
})

test('A 异常退出：RETAIN 可恢复；RUNNING abandoned 可清理；过期锁释放', () => {
  const root = workRoot()
  const now = { t: new Date('2026-09-01T00:00:00Z') }
  const reg = createRegistry({ now: () => now.t })
  cleanups.push(() => {
    for (const id of [...reg.workspaces.keys()]) {
      const ws = reg.workspaces.get(id)
      if (!ws) continue
      ws.lifecycle = LIFECYCLE.COMPLETED
      try { cleanupWorkspace(reg, id, { force_abandoned: true }) } catch { /* ignore */ }
    }
  })
  allocateWorkspace(reg, {
    logical_run_id: 'run-wait', mode: WORKSPACE_MODE.SANDBOX, work_root: root, task_identity: 'w',
  })
  allocateWorkspace(reg, {
    logical_run_id: 'run-live', mode: WORKSPACE_MODE.SANDBOX, work_root: root, task_identity: 'l',
  })
  setLifecycle(reg, 'run-wait', LIFECYCLE.WAITING_HUMAN)
  setLifecycle(reg, 'run-live', LIFECYCLE.RUNNING)
  markAbandoned(reg, 'run-wait')
  markAbandoned(reg, 'run-live')
  acquireLock(reg, {
    logical_run_id: 'run-wait', resource_key: 'device:1', owner: 'run-wait', ttl_ms: 1000,
  })
  now.t = new Date('2026-09-01T00:00:02Z')
  const scan = recoverStale(reg)
  assert.ok(scan.recovered.includes('run-wait'))
  assert.ok(scan.cleanup_eligible.includes('run-live'))
  assert.equal(activeLockFor(reg, 'device:1'), undefined)
  assert.equal(existsSync(getRunWorkspace(reg, 'run-wait').workspace_path), true)
})

test('A 诊断模板二次 allocate 不切换 source lineage；config snapshot 不重建 workspace', () => {
  const repo = initRepo()
  const root = workRoot()
  const reg = trackedRegistry()
  const first = allocateWorkspace(reg, {
    logical_run_id: 'run-diag', template_id: TEMPLATE_ID.DIAGNOSE,
    repository_path: repo, repository: 'org/demo', work_root: root,
    config_snapshot_revision: 'prov-1',
  })
  const second = allocateWorkspace(reg, {
    logical_run_id: 'run-diag', template_id: TEMPLATE_ID.DIAGNOSE,
    repository_path: repo, work_root: root, config_snapshot_revision: 'prov-2',
  })
  assert.equal(second.source_path, first.source_path)
  assert.equal(second.workspace_id, first.workspace_id)
  assert.equal(second.source_revision, first.source_revision)
  assert.equal(second.config_snapshot_revision, 'prov-2')
})

test('A portable run 映射；Git sync 只接受实况 HEAD', () => {
  const mapped = mapFromPortableRun({
    run_id: 'cwf-93-01', workspace_id: 'wt-dev-cwf-93-01',
    repository: 'org/demo', base_ref: 'main', base_commit: 'abc',
    work_branch: 'dev-cwf-93-01', current_head: 'abc',
  })
  assert.equal(mapped.logical_run_id, 'cwf-93-01')
  assert.equal(mapped.workspace_id, 'wt-dev-cwf-93-01')
  const repo = initRepo()
  const root = workRoot()
  const reg = trackedRegistry()
  const ws = allocateWorkspace(reg, {
    logical_run_id: 'run-sync', mode: WORKSPACE_MODE.ISOLATED_WRITE,
    repository_path: repo, repository: 'org/demo', work_root: root,
  })
  writeSourceFile(ws, 'next.txt', 'n')
  git(['add', 'next.txt'], ws.source_path)
  git(['commit', '-q', '-m', 'advance'], ws.source_path)
  const actual = git(['rev-parse', 'HEAD'], ws.source_path)
  assert.notEqual(actual, ws.current_head)
  assert.throws(() => recordSourceSync(reg, 'run-sync', { current_head: 'deadbeef' }), /禁止自报 HEAD/)
  const synced = recordSourceSync(reg, 'run-sync')
  assert.equal(synced.current_head, actual)
  assert.equal(synced.source_revision, actual)
})

test('A NONE 有 workspace 身份但无文件 source', () => {
  const root = workRoot()
  const reg = trackedRegistry()
  const ws = allocateWorkspace(reg, {
    logical_run_id: 'run-none', mode: WORKSPACE_MODE.NONE, work_root: root,
  })
  assert.equal(ws.provider_id, PROVIDER.NONE)
  assert.equal(ws.workspace_path, null)
  assert.equal(getRunWorkspace(reg, 'run-none').logical_run_id, 'run-none')
  assert.throws(() => writeSourceFile(ws, 'x.txt', 'n'), /没有可写 source/)
})

test('R1 workspace_id 必须净化且唯一', () => {
  const root = workRoot()
  const reg = trackedRegistry()
  assert.throws(() => allocateWorkspace(reg, {
    logical_run_id: 'run-a', mode: WORKSPACE_MODE.SANDBOX, work_root: root,
    workspace_id: '../records',
  }), /非法 workspace_id/)
  assert.throws(() => allocateWorkspace(reg, {
    logical_run_id: 'run-rec', mode: WORKSPACE_MODE.SANDBOX, work_root: root,
    workspace_id: 'records', task_identity: 't-rec',
  }), /保留名/)
  allocateWorkspace(reg, {
    logical_run_id: 'run-a', mode: WORKSPACE_MODE.SANDBOX, work_root: root,
    workspace_id: 'ws-shared', task_identity: 't-a',
  })
  assert.throws(() => allocateWorkspace(reg, {
    logical_run_id: 'run-b', mode: WORKSPACE_MODE.SANDBOX, work_root: root,
    workspace_id: 'ws-shared', task_identity: 't-b',
  }), /workspace_id 已被占用/)
})

test('R3 Proof 绑定核对 lineage 字段', () => {
  const repo = initRepo()
  const root = workRoot()
  const reg = trackedRegistry()
  const a = allocateWorkspace(reg, {
    logical_run_id: 'run-a', mode: WORKSPACE_MODE.ISOLATED_WRITE,
    repository_path: repo, repository: 'org/demo', work_root: root, task_identity: 't-a',
  })
  const proof = buildAttemptProvenance(a, { node: 'review', attempt: 1 })
  assert.equal(assertProofBinding(a, proof), true)
  assert.throws(() => assertProofBinding(a, { ...proof, logical_run_id: 'run-other' }), /logical_run_id/)
  assert.throws(() => assertProofBinding(a, { ...proof, config_snapshot_revision: 'forged' }), /config_snapshot_revision/)
})

test('R4 符号链接不得逃出 source/scratch 根', () => {
  const repo = initRepo()
  const outside = mkdtempSync(join(fixtureRoot, 'outside-'))
  cleanups.push(() => { try { rmSync(outside, { recursive: true, force: true }) } catch { /* ignore */ } })
  writeFileSync(join(outside, 'leaked.txt'), 'secret')
  symlinkSync(outside, join(repo, 'output'))
  git(['add', 'output'], repo)
  git(['commit', '-q', '-m', 'add-symlink'], repo)
  const root = workRoot()
  const reg = trackedRegistry()
  const ws = allocateWorkspace(reg, {
    logical_run_id: 'run-link', mode: WORKSPACE_MODE.ISOLATED_WRITE,
    repository_path: repo, repository: 'org/demo', work_root: root, task_identity: 't-link',
  })
  assert.throws(() => readSourceFile(ws, join('output', 'leaked.txt')), /逃出/)
  assert.throws(() => writeSourceFile(ws, join('output', 'pwned.txt'), 'x'), /逃出/)
  writeWorkerFile(ws, 'expert-a', 'ok.md', 'in')
  symlinkSync(outside, join(workerScratchPath(ws, 'expert-a'), 'out'))
  assert.throws(() => readWorkerFile(ws, 'expert-a', join('out', 'leaked.txt')), /逃出/)
})

test('R5 Git HEAD 前进后未 sync 不得绑定 Proof', () => {
  const repo = initRepo()
  const root = workRoot()
  const reg = trackedRegistry()
  const ws = allocateWorkspace(reg, {
    logical_run_id: 'run-stale', mode: WORKSPACE_MODE.ISOLATED_WRITE,
    repository_path: repo, repository: 'org/demo', work_root: root, task_identity: 't-stale',
  })
  const oldRev = ws.source_revision
  writeSourceFile(ws, 'next.txt', 'n')
  git(['add', 'next.txt'], ws.source_path)
  git(['commit', '-q', '-m', 'advance'], ws.source_path)
  const live = git(['rev-parse', 'HEAD'], ws.source_path)
  assert.notEqual(live, oldRev)
  assert.throws(() => buildAttemptProvenance(ws, { node: 'review', attempt: 1 }), /recordSourceSync/)
  assert.throws(() => assertProofBinding(ws, {
    workspace_id: ws.workspace_id,
    logical_run_id: ws.logical_run_id,
    source_revision: oldRev,
    base_commit: ws.base_commit,
    work_branch: ws.work_branch,
    verified_branch: ws.work_branch,
    verified_head: live,
    config_snapshot_revision: ws.config_snapshot_revision,
    node: 'review',
    attempt: 1,
  }), /source_revision/)
  recordSourceSync(reg, 'run-stale')
  const synced = getRunWorkspace(reg, 'run-stale')
  assert.equal(assertProofBinding(synced, buildAttemptProvenance(synced, { node: 'review', attempt: 1 })), true)
})

test('R6 force_abandoned 只能清理已标记 abandoned 的 RUNNING', () => {
  const root = workRoot()
  const reg = trackedRegistry()
  const live = allocateWorkspace(reg, {
    logical_run_id: 'run-live', mode: WORKSPACE_MODE.SANDBOX, work_root: root, task_identity: 'live',
  })
  setLifecycle(reg, 'run-live', LIFECYCLE.RUNNING)
  assert.throws(() => cleanupWorkspace(reg, 'run-live', { force_abandoned: true }), /非终态/)
  assert.equal(existsSync(live.workspace_path), true)
  const ready = allocateWorkspace(reg, {
    logical_run_id: 'run-ready', mode: WORKSPACE_MODE.SANDBOX, work_root: root, task_identity: 'ready',
  })
  markAbandoned(reg, 'run-ready')
  assert.throws(() => cleanupWorkspace(reg, 'run-ready', { force_abandoned: true }), /非终态/)
  assert.equal(existsSync(ready.workspace_path), true)
  setLifecycle(reg, 'run-live', LIFECYCLE.RUNNING)
  markAbandoned(reg, 'run-live')
  const audit = cleanupWorkspace(reg, 'run-live', { force_abandoned: true })
  assert.equal(audit.artifacts, 'removed')
  assert.equal(existsSync(live.workspace_path), false)
})
