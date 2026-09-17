// LOC-017 Integration Gate 内核侧验收：目标同步编排 + 同步证据 Revision 链 + 放行判定。
// 全部走真实 git 临时仓库与真实内核（workspace-isolation / formal-records / records-host），
// 只伪造进程边界之外的胶水。覆盖规格 B4/B6/B7/B13 与 UAT-02 的机械面。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  WORKSPACE_MODE,
  createRegistry, allocateWorkspace,
  computeIntegrationCheckpointFromRepo,
  acquireLock, releaseLock, activeLockFor,
} from '../workspace-isolation.mjs'
import { planTargetSync, mergeTarget, performTargetSync, buildSyncRecordEntry, integrationSyncRecordId } from '../integration-gate.mjs'
import { recordsCommit, recordsList, recordsGet, recordsAssertIntegration } from '../records-host.mjs'
import { digest8 } from '../revision-dependencies.mjs'
import { appendRecord, coverageStatus, NOT_COVERING_CURRENT, COVERING, toRef } from '../formal-records.mjs'

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
  const root = mkdtempSync(join(fixtureRoot, 'gate-repo-'))
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
  const dir = mkdtempSync(join(fixtureRoot, 'gate-root-'))
  cleanups.push(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } })
  return dir
}

function recordsDir() {
  const dir = mkdtempSync(join(fixtureRoot, 'gate-records-'))
  cleanups.push(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } })
  return dir
}

// 一块 Git ISOLATED_WRITE 现场：真 worktree，分支从 main 派生
function allocateWrite(registry, id, repo) {
  return allocateWorkspace(registry, {
    logical_run_id: id,
    workspace_id: 'ws-' + id,
    mode: WORKSPACE_MODE.ISOLATED_WRITE,
    work_root: workRoot(),
    repository_path: repo,
    base_ref: 'main',
    task_identity: id,
    allow_parallel: true,
  })
}

function commitFile(repo, file, content, message) {
  writeFileSync(join(repo, file), content)
  git(['add', '-A'], repo)
  git(['commit', '-q', '-m', message], repo)
  return git(['rev-parse', 'HEAD'], repo)
}

function commitInWorkspace(ws, file, content, message) {
  writeFileSync(join(ws.source_path, file), content)
  git(['add', '-A'], ws.source_path)
  git(['commit', '-q', '-m', message], ws.source_path)
  return git(['rev-parse', 'HEAD'], ws.source_path)
}

test('G1 plan：基线一致时目标未前进，worktree 已含目标（integrated_before）', () => {
  const repo = initRepo()
  const registry = createRegistry()
  const ws = allocateWrite(registry, 'run-a', repo)
  const plan = planTargetSync(registry, 'run-a', 'main')
  assert.equal(plan.ok, true)
  assert.equal(plan.target_head, ws.base_commit)
  assert.equal(plan.integrated_before, true)
  assert.equal(plan.resource_key, `repo:${ws.repository}:target:main:integration`)
  assert.equal(plan.sync_record_id, integrationSyncRecordId('run-a'))
})

test('G2 同步：目标前进后 merge 落地，recordSourceSync 只信实况，checkpoint 未再前进', () => {
  const repo = initRepo()
  const registry = createRegistry()
  const ws = allocateWrite(registry, 'run-b', repo)
  commitInWorkspace(ws, 'feat.txt', 'work\n', 'branch work')
  const newMain = commitFile(repo, 'main.txt', 'main advance\n', 'advance main')

  const before = computeIntegrationCheckpointFromRepo({ base_ref: 'main', base_commit: ws.base_commit, repository_path: repo, target_ref: 'main' })
  assert.equal(before.target_advanced, true)

  const plan = planTargetSync(registry, 'run-b', 'main')
  assert.equal(plan.ok, true)
  assert.equal(plan.integrated_before, false)
  assert.equal(plan.target_head, newMain)

  const merged = performTargetSync(registry, 'run-b', plan)
  assert.equal(merged.ok, true)
  assert.equal(merged.merge_result, 'merged')
  assert.equal(merged.target_head, newMain)
  assert.notEqual(merged.current_head, ws.base_commit, '同步后 workspace HEAD 前进')

  const after = computeIntegrationCheckpointFromRepo({ base_ref: 'main', base_commit: newMain, repository_path: repo, target_ref: 'main' })
  assert.equal(after.target_advanced, false, '以同步头为放行基线时目标未再前进（B3）')
  assert.equal(after.proofs_state, 'still_valid')
})

test('G3 冲突 fail closed：不改注册表、分支 HEAD 不动、给出冲突清单', () => {
  const repo = initRepo()
  const registry = createRegistry()
  const ws = allocateWrite(registry, 'run-c', repo)
  commitInWorkspace(ws, 'shared.txt', 'branch version\n', 'branch edits shared')
  commitFile(repo, 'shared.txt', 'main version\n', 'main edits shared')

  const plan = planTargetSync(registry, 'run-c', 'main')
  assert.equal(plan.ok, true)
  const headBefore = git(['rev-parse', 'HEAD'], ws.source_path)
  const registryHeadBefore = registry.workspaces.get('run-c').current_head
  const merged = mergeTarget(plan)
  assert.equal(merged.ok, false)
  assert.equal(merged.code, 'GATE_SYNC_CONFLICT')
  assert.deepEqual(merged.conflicts, ['shared.txt'])
  assert.equal(git(['rev-parse', 'HEAD'], ws.source_path), headBefore, '冲突时分支 HEAD 不变')
  assert.equal(registry.workspaces.get('run-c').current_head, registryHeadBefore, '冲突不写注册表（fail closed）')
})

test('G4 脏工作区拒绝自动同步（不得自动吞改）', () => {
  const repo = initRepo()
  const registry = createRegistry()
  allocateWrite(registry, 'run-d', repo)
  writeFileSync(join(registry.workspaces.get('run-d').source_path, 'dirty.txt'), 'uncommitted\n')
  const plan = planTargetSync(registry, 'run-d', 'main')
  assert.equal(plan.ok, false)
  assert.equal(plan.code, 'GATE_SYNC_DIRTY')
})

test('G5 B4 证据链：真实同步 → 同步证据新 Revision → 重跑新 Proof 覆盖、旧 Proof stale 不删除', () => {
  const repo = initRepo()
  const registry = createRegistry()
  const ws = allocateWrite(registry, 'run-e', repo)
  commitInWorkspace(ws, 'feat.txt', 'work\n', 'branch work')
  const dir = recordsDir()
  const runId = 'run-e'
  const reviewNode = 'node:' + runId + ':review'
  const testNode = 'node:' + runId + ':test'
  const reviewProof = 'proof:' + runId + ':review'
  const testProof = 'proof:' + runId + ':test'

  const syncId = integrationSyncRecordId(runId)
  const nodeRi = (nodeId, body) => {
    const producer = nodeId.replace('node:' + runId + ':', '')
    return { mode: 'declared', items: [{ binding: 'from_' + producer, producer, version_ref: 'tmp-exec:1:' + digest8(body) }] }
  }
  const syncRi = (rev) => ({ mode: 'declared', items: [{ binding: 'sync', record_ref: { record_id: syncId, record_revision: rev }, version_ref: 'record:' + syncId + '@' + rev }] })

  // ① 首段：review/test 完成 → node_result + proof（精确依赖各自节点 Revision）
  const first = recordsCommit({
    records_dir: dir, logical_run_id: runId,
    entries: [
      { type: 'node_result', record_id: reviewNode, provenance: prov(runId, 'review', 1), body_value: { verdict: 'APPROVE' } },
      { type: 'proof', record_id: reviewProof, provenance: prov(runId, 'review', 1), body_value: { node: 'review', verified_head: ws.base_commit }, resolved_inputs: nodeRi(reviewNode, { verdict: 'APPROVE' }) },
      { type: 'node_result', record_id: testNode, provenance: prov(runId, 'test', 1), body_value: { verdict: 'PASS' } },
      { type: 'proof', record_id: testProof, provenance: prov(runId, 'test', 1), body_value: { node: 'test', verified_head: ws.base_commit }, resolved_inputs: nodeRi(testNode, { verdict: 'PASS' }) },
    ],
  })
  assert.equal(first.ok, true)

  // 放行前判定：目标已前进，旧 Proof 对同步记录 UNRELATED → 拒绝放行（B7/UAT-02 前提）
  commitFile(repo, 'main.txt', 'main advance\n', 'advance main')
  const plan = planTargetSync(registry, runId, 'main')
  const merged = performTargetSync(registry, runId, plan)
  assert.equal(merged.ok, true)

  const preAssert = recordsAssertIntegration({ records_dir: dir, logical_run_id: runId, target_record_id: syncId, proofs: [toRef({ record_id: reviewProof, record_revision: 1 }), toRef({ record_id: testProof, record_revision: 1 })], target_advanced: true })
  assert.equal(preAssert.ok, false, '同步后、重跑前：旧 Proof 不得为新集成背书')

  // ② 同步证据：无新 Revision 不得放行；追加后 Revision 前进
  const entry = buildSyncRecordEntry({
    logicalRunId: runId, target_head: merged.target_head, previous_synced_head: null,
    integrated_before: merged.integrated_before, merge_result: merged.merge_result,
    attempt: 1, snapshot_revision: '1',
  })
  assert.equal(entry.record_id, syncId)
  const c1 = recordsCommit({ records_dir: dir, logical_run_id: runId, entries: [entry] })
  assert.equal(c1.ok, true)
  const syncRev1 = c1.committed.find((c) => c.record_id === syncId).record_revision
  assert.equal(syncRev1, 1)
  const c2 = recordsCommit({ records_dir: dir, logical_run_id: runId, entries: [buildSyncRecordEntry({ logicalRunId: runId, target_head: merged.target_head, previous_synced_head: merged.target_head, integrated_before: true, merge_result: 'up_to_date', attempt: 2, snapshot_revision: '1' })] })
  assert.equal(c2.committed.find((c) => c.record_id === syncId).record_revision, 2, '重复同步产生新 Revision（B4 判定依据）')

  // ③ 重跑：review/test 节点重新完成 → 新 node Revision + 新 Proof（依赖含同步证据）
  recordsCommit({
    records_dir: dir, logical_run_id: runId,
    entries: [
      { type: 'node_result', record_id: reviewNode, provenance: prov(runId, 'review', 2), body_value: { verdict: 'APPROVE' } },
      { type: 'proof', record_id: reviewProof, provenance: prov(runId, 'review', 2), body_value: { node: 'review', verified_head: merged.current_head }, resolved_inputs: syncRi(2) },
      { type: 'node_result', record_id: testNode, provenance: prov(runId, 'test', 2), body_value: { verdict: 'PASS' } },
      { type: 'proof', record_id: testProof, provenance: prov(runId, 'test', 2), body_value: { node: 'test', verified_head: merged.current_head }, resolved_inputs: syncRi(2) },
    ],
  })

  const get = recordsGet({ records_dir: dir, logical_run_id: runId, record_id: reviewProof })
  assert.equal(get.found, true)
  assert.equal(get.revisions.length, 2, '旧 Proof 保留不删（B7）')
  const list = recordsList({ records_dir: dir, logical_run_id: runId })
  const staleRows = list.coverage.filter((c) => c.proof.record_id === reviewProof && c.proof.record_revision === 1 && c.status === NOT_COVERING_CURRENT)
  assert.ok(staleRows.length > 0, '旧 Proof 对新 Revision 判 not_covering_current（UAT-02）')

  // ④ 放行判定：新 Proof 全覆盖当前 Revision → 通过；旧 Proof → 拒绝
  const okAssert = recordsAssertIntegration({
    records_dir: dir, logical_run_id: runId, target_record_id: syncId,
    proofs: [toRef({ record_id: reviewProof, record_revision: 2 }), toRef({ record_id: testProof, record_revision: 2 })],
    target_advanced: true,
  })
  assert.equal(okAssert.ok, true)
  assert.equal(okAssert.proofs_state, 'rerun_completed', '已前进路径放行必须报告 rerun_completed（B4/B6）')
  const staleAssert = recordsAssertIntegration({
    records_dir: dir, logical_run_id: runId, target_record_id: syncId,
    proofs: [toRef({ record_id: reviewProof, record_revision: 1 }), toRef({ record_id: testProof, record_revision: 2 })],
    target_advanced: true,
  })
  assert.equal(staleAssert.ok, false)
  assert.ok(staleAssert.stale.some((s) => s.proof === reviewProof && s.status !== COVERING), '未覆盖当前 Revision 的 Proof 一律拒绝（UNRELATED / not_covering_current 同罪）')
  const emptyAssert = recordsAssertIntegration({ records_dir: dir, logical_run_id: runId, target_record_id: syncId, proofs: [], target_advanced: true })
  assert.equal(emptyAssert.ok, false, '无 Proof 不得放行（B6：不得由无 stale 推定）')
})

test('G6 集成锁语义：同 run+owner 重复 acquire 即心跳续期；跨 run 抢锁拒绝', () => {
  const repo = initRepo()
  const registry = createRegistry()
  allocateWrite(registry, 'run-f', repo)
  allocateWrite(registry, 'run-g', repo)
  const key = `repo:${registry.workspaces.get('run-f').repository}:target:main:integration`
  const l1 = acquireLock(registry, { logical_run_id: 'run-f', resource_key: key, owner: 'integration-gate', ttl_ms: 1000 })
  const refreshed = acquireLock(registry, { logical_run_id: 'run-f', resource_key: key, owner: 'integration-gate', ttl_ms: 1000 })
  assert.equal(refreshed.lock_id, l1.lock_id, '同 run+owner 心跳续期（B9）')
  assert.throws(() => acquireLock(registry, { logical_run_id: 'run-g', resource_key: key, owner: 'integration-gate' }), /资源锁被占用/, '跨 run 抢锁拒绝（B10/B11）')
  const active = activeLockFor(registry, key)
  assert.equal(active.logical_run_id, 'run-f')
  releaseLock(registry, { lock_id: l1.lock_id, owner: 'integration-gate', logical_run_id: 'run-f', reason: 'gate done' })
  assert.equal(activeLockFor(registry, key), undefined, '释放后可被后续 Run 获取')
})

test('G7 非 Git 运行不适用闸门（B1）：SANDBOX/NONE plan 直接拒绝', () => {
  const registry = createRegistry()
  const root = workRoot()
  const ws = allocateWorkspace(registry, {
    logical_run_id: 'run-sandbox', workspace_id: 'ws-sandbox',
    mode: 'SANDBOX', work_root: root, task_identity: 'run-sandbox', allow_parallel: true,
  })
  const plan = planTargetSync(registry, 'run-sandbox', 'main')
  assert.equal(plan.ok, false)
  assert.equal(plan.code, 'GATE_NOT_GIT_WORKSPACE')
})

function prov(runId, node, attempt) {
  return {
    logical_run_id: runId, node, attempt,
    snapshot_revision: '1', provider: 'default', model: 'default',
    produced_by: 'vwf:integration-gate-test', node_business_outcome: null,
  }
}
