#!/usr/bin/env node
// #93 DSH Runtime Integration 真机验收脚本
// 验证：同仓双 Run 并行隔离、integration lock 串行、workspace 现场绑定
// 运行：node scripts/test/runtime-integration-e2e.mjs

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const fixtureRoot = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.scratch', 'rt-integ-' + Date.now()))

function cleanup() {
  try { rmSync(fixtureRoot, { recursive: true, force: true }) } catch { /* ignore */ }
}

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
  return root
}

function runNode(args, cwd) {
  try {
    const stdout = execFileSync(process.execPath, args, { cwd, encoding: 'utf-8', maxBuffer: 1024 * 1024 })
    return { ok: true, stdout: stdout.trim() }
  } catch (e) {
    return { ok: false, stdout: (e.stdout || '').trim(), stderr: (e.stderr || '').trim(), code: e.status }
  }
}

// ── 测试 1：同仓双 Run 并行，workspace 隔离 ──────────────────────────────
function testDualRunIsolation() {
  console.log('\n━━ 测试 1：同仓双 Run 并行隔离 ━━')
  const repo = initRepo()
  const workRoot = mkdtempSync(join(fixtureRoot, 'work-'))
  const hostScript = join(dirname(fileURLToPath(import.meta.url)), '..', 'workspace-isolation-host.mjs')

  // Run A
  const allocA = runNode([hostScript, 'allocate', JSON.stringify({
    logical_run_id: 'run-a', template_id: 'construction',
    repository_path: repo, repository: 'org/demo',
    work_root: workRoot, task_identity: 'issue-93-a',
  })])
  if (!allocA.ok) { console.error('Run A allocate 失败:', allocA.stderr); return false }
  const wsA = JSON.parse(allocA.stdout).workspace

  // Run B
  const allocB = runNode([hostScript, 'allocate', JSON.stringify({
    logical_run_id: 'run-b', template_id: 'construction',
    repository_path: repo, repository: 'org/demo',
    work_root: workRoot, task_identity: 'issue-93-b',
  })])
  if (!allocB.ok) { console.error('Run B allocate 失败:', allocB.stderr); return false }
  const wsB = JSON.parse(allocB.stdout).workspace

  // 验证：独立 workspace_id / workspace_path / source_path
  if (wsA.workspace_id === wsB.workspace_id) { console.error('workspace_id 冲突'); return false }
  if (wsA.workspace_path === wsB.workspace_path) { console.error('workspace_path 冲突'); return false }
  if (wsA.source_path === wsB.source_path) { console.error('source_path 冲突'); return false }
  console.log('  ✓ workspace_id/path/source 独立')

  // 验证：独立 branch
  const branchA = git(['rev-parse', '--abbrev-ref', 'HEAD'], wsA.source_path)
  const branchB = git(['rev-parse', '--abbrev-ref', 'HEAD'], wsB.source_path)
  if (branchA !== 'vwf/run/run-a') { console.error('Run A branch 错误:', branchA); return false }
  if (branchB !== 'vwf/run/run-b') { console.error('Run B branch 错误:', branchB); return false }
  console.log('  ✓ branch 独立:', branchA, '|', branchB)

  // 验证：A 写 source，B 不可见
  const writeA = runNode([hostScript, 'writeSourceFile', JSON.stringify({
    workspace: wsA, rel: 'secret-a.txt', content: 'from-a',
  })])
  if (!writeA.ok) { console.error('Run A write 失败:', writeA.stderr); return false }
  const visibleInB = existsSync(join(wsB.source_path, 'secret-a.txt'))
  if (visibleInB) { console.error('Run A 的未提交文件对 B 可见！'); return false }
  console.log('  ✓ A 的未提交文件对 B 不可见')

  // 验证：A 写 cache，B 不可见
  writeFileSync(join(wsA.resources.cache_dir, 'cache-a'), 'ca')
  const cacheInB = existsSync(join(wsB.resources.cache_dir, 'cache-a'))
  if (cacheInB) { console.error('Run A 的 cache 对 B 可见！'); return false }
  console.log('  ✓ A 的 cache 对 B 不可见')

  // 验证：source_revision 等于实况 HEAD
  const headA = git(['rev-parse', 'HEAD'], wsA.source_path)
  if (wsA.source_revision !== headA) { console.error('source_revision 不匹配:', wsA.source_revision, '!=', headA); return false }
  console.log('  ✓ source_revision 等于实况 HEAD')

  // 清理
  runNode([hostScript, 'cleanup', JSON.stringify({ logical_run_id: 'run-a', work_root: workRoot, opts: {} })])
  runNode([hostScript, 'cleanup', JSON.stringify({ logical_run_id: 'run-b', work_root: workRoot, opts: {} })])

  console.log('  ✅ 测试 1 通过')
  return true
}

// ── 测试 2：integration lock 串行 ────────────────────────────────────────
function testIntegrationLock() {
  console.log('\n━━ 测试 2：integration lock 串行 ━━')
  const workRoot = mkdtempSync(join(fixtureRoot, 'lock-'))
  const hostScript = join(dirname(fileURLToPath(import.meta.url)), '..', 'workspace-isolation-host.mjs')

  // Run A 获取锁
  const lockA = runNode([hostScript, 'acquireLock', JSON.stringify({
    logical_run_id: 'run-a', resource_key: 'repo:org/demo:target:main:integration',
    owner: 'run-a', ttl_ms: 30000, work_root: workRoot,
  })])
  if (!lockA.ok) { console.error('Run A acquireLock 失败:', lockA.stderr); return false }
  const lockAObj = JSON.parse(lockA.stdout).lock
  console.log('  ✓ Run A 获取锁:', lockAObj.lock_id)

  // Run B 尝试获取同一锁 → 被拒（包装脚本返回 ok:false）
  const lockB = runNode([hostScript, 'acquireLock', JSON.stringify({
    logical_run_id: 'run-b', resource_key: 'repo:org/demo:target:main:integration',
    owner: 'run-b', ttl_ms: 30000, work_root: workRoot,
  })])
  // acquireLock 在锁被占用时 throw，包装脚本 catch 后返回 ok:false
  let lockBFailed = false
  if (!lockB.ok) {
    lockBFailed = true
  } else {
    try {
      const parsed = JSON.parse(lockB.stdout)
      if (!parsed.ok) lockBFailed = true
    } catch { lockBFailed = true }
  }
  if (!lockBFailed) {
    console.error('Run B 不应获取到锁！')
    return false
  }
  console.log('  ✓ Run B 获取锁被拒（正确）')

  // Run A 释放锁
  const releaseA = runNode([hostScript, 'releaseLock', JSON.stringify({
    lock_id: lockAObj.lock_id, owner: 'run-a', logical_run_id: 'run-a',
    reason: 'closeout complete', work_root: workRoot,
  })])
  if (!releaseA.ok) { console.error('Run A releaseLock 失败:', releaseA.stderr); return false }
  console.log('  ✓ Run A 释放锁')

  // Run B 再次获取 → 成功
  const lockB2 = runNode([hostScript, 'acquireLock', JSON.stringify({
    logical_run_id: 'run-b', resource_key: 'repo:org/demo:target:main:integration',
    owner: 'run-b', ttl_ms: 30000, work_root: workRoot,
  })])
  if (!lockB2.ok) { console.error('Run B 二次获取锁失败:', lockB2.stderr); return false }
  const lockBObj = JSON.parse(lockB2.stdout).lock
  console.log('  ✓ Run B 释放后获取锁:', lockBObj.lock_id)

  // 清理
  runNode([hostScript, 'releaseLock', JSON.stringify({
    lock_id: lockBObj.lock_id, owner: 'run-b', logical_run_id: 'run-b',
    reason: 'cleanup', work_root: workRoot,
  })])

  console.log('  ✅ 测试 2 通过')
  return true
}

// ── 测试 3：Provider/Model Snapshot 变化不重建 workspace ─────────────────
function testSnapshotUpdate() {
  console.log('\n━━ 测试 3：Provider/Model Snapshot 变化不重建 workspace ━━')
  const repo = initRepo()
  const workRoot = mkdtempSync(join(fixtureRoot, 'snap-'))
  const hostScript = join(dirname(fileURLToPath(import.meta.url)), '..', 'workspace-isolation-host.mjs')

  const alloc1 = runNode([hostScript, 'allocate', JSON.stringify({
    logical_run_id: 'run-snap', template_id: 'construction',
    repository_path: repo, repository: 'org/demo',
    work_root: workRoot, task_identity: 'issue-93-snap',
  })])
  if (!alloc1.ok) { console.error('allocate 失败:', alloc1.stderr); return false }
  const ws1 = JSON.parse(alloc1.stdout).workspace
  const sourcePath1 = ws1.source_path

  // 模拟 Provider/Model Snapshot 变化：只更新 config_snapshot_revision
  // 在真实 DSH 中，这由 host.js 在节点执行前检测并调用 recordSourceSync
  // 这里验证 workspace 路径不变
  const sync = runNode([hostScript, 'recordSourceSync', JSON.stringify({
    logical_run_id: 'run-snap', work_root: workRoot,
    current_head: ws1.source_revision, // 不变
  })])
  if (!sync.ok) { console.error('recordSourceSync 失败:', sync.stderr); return false }
  const syncParsed = JSON.parse(sync.stdout)
  if (!syncParsed.ok) { console.error('recordSourceSync 业务错误:', syncParsed.error); return false }
  const ws2 = syncParsed.workspace

  if (!ws2 || ws2.source_path !== sourcePath1) {
    console.error('Snapshot 更新导致 source_path 变化:', sourcePath1, '->', ws2 && ws2.source_path)
    return false
  }
  console.log('  ✓ source_path 保持不变:', sourcePath1)

  // 清理
  runNode([hostScript, 'cleanup', JSON.stringify({ logical_run_id: 'run-snap', work_root: workRoot, opts: {} })])

  console.log('  ✅ 测试 3 通过')
  return true
}

// ── 测试 4：验证节点绑定同一 Workspace / 实况 HEAD ───────────────────────
function testProofBinding() {
  console.log('\n━━ 测试 4：验证节点绑定同一 Workspace / 实况 HEAD ━━')
  const repo = initRepo()
  const workRoot = mkdtempSync(join(fixtureRoot, 'proof-'))
  const hostScript = join(dirname(fileURLToPath(import.meta.url)), '..', 'workspace-isolation-host.mjs')

  const alloc = runNode([hostScript, 'allocate', JSON.stringify({
    logical_run_id: 'run-proof', template_id: 'construction',
    repository_path: repo, repository: 'org/demo',
    work_root: workRoot, task_identity: 'issue-93-proof',
  })])
  if (!alloc.ok) { console.error('allocate 失败:', alloc.stderr); return false }
  const ws = JSON.parse(alloc.stdout).workspace

  // 构建 provenance
  const prov = runNode([hostScript, 'buildAttemptProvenance', JSON.stringify({
    workspace: ws, node: 'review', attempt: 1,
  })])
  if (!prov.ok) { console.error('buildAttemptProvenance 失败:', prov.stderr); return false }
  const provenance = JSON.parse(prov.stdout).provenance

  // 验证 provenance 含 workspace_id / source_revision / verified_head
  if (provenance.workspace_id !== ws.workspace_id) {
    console.error('provenance workspace_id 不匹配'); return false
  }
  if (provenance.source_revision !== ws.source_revision) {
    console.error('provenance source_revision 不匹配'); return false
  }
  const head = git(['rev-parse', 'HEAD'], ws.source_path)
  if (provenance.verified_head !== head) {
    console.error('provenance verified_head 不匹配实况:', provenance.verified_head, '!=', head); return false
  }
  console.log('  ✓ provenance 绑定 workspace_id / source_revision / verified_head')

  // 验证：另一 workspace 的 Proof 不能背书
  const alloc2 = runNode([hostScript, 'allocate', JSON.stringify({
    logical_run_id: 'run-proof-2', template_id: 'construction',
    repository_path: repo, repository: 'org/demo',
    work_root: workRoot, task_identity: 'issue-93-proof-2',
  })])
  if (!alloc2.ok) { console.error('allocate2 失败:', alloc2.stderr); return false }
  const ws2 = JSON.parse(alloc2.stdout).workspace

  // 伪造一个来自 ws2 的 proof 试图为 ws 背书
  const fakeProof = {
    workspace_id: ws2.workspace_id, // 错误 workspace
    logical_run_id: ws.logical_run_id,
    source_revision: ws.source_revision,
    base_commit: ws.base_commit,
    work_branch: ws.work_branch,
    config_snapshot_revision: ws.config_snapshot_revision,
    node: 'review', attempt: 1,
  }
  const bind = runNode([hostScript, 'assertProofBinding', JSON.stringify({
    workspace: ws, proof: fakeProof,
  })])
  if (!bind.ok) { console.error('assertProofBinding 调用失败:', bind.stderr); return false }
  const valid = JSON.parse(bind.stdout).valid
  if (valid) {
    console.error('另一 workspace 的 Proof 不应通过绑定校验！')
    return false
  }
  console.log('  ✓ 另一 workspace 的 Proof 被拒')

  // 清理
  runNode([hostScript, 'cleanup', JSON.stringify({ logical_run_id: 'run-proof', work_root: workRoot, opts: {} })])
  runNode([hostScript, 'cleanup', JSON.stringify({ logical_run_id: 'run-proof-2', work_root: workRoot, opts: {} })])

  console.log('  ✅ 测试 4 通过')
  return true
}

// ── 主程序 ──────────────────────────────────────────────────────────────
console.log('═══════════════════════════════════════════════════════════════')
console.log('#93 DSH Runtime Integration 真机验收')
console.log('时间:', new Date().toISOString())
console.log('═══════════════════════════════════════════════════════════════')

let pass = 0
let fail = 0

for (const fn of [testDualRunIsolation, testIntegrationLock, testSnapshotUpdate, testProofBinding]) {
  try {
    if (fn()) pass++
    else fail++
  } catch (e) {
    console.error('  ❌ 异常:', e.message)
    fail++
  }
}

cleanup()

console.log('\n═══════════════════════════════════════════════════════════════')
console.log('结果: ' + pass + ' 通过 / ' + fail + ' 失败')
console.log('═══════════════════════════════════════════════════════════════')

process.exit(fail > 0 ? 1 : 0)
