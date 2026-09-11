#!/usr/bin/env node
// #93 DSH Runtime Integration 真机验收脚本
// 验证：同仓双 Run 并行隔离、integration lock 串行、workspace 现场绑定
// 运行：node scripts/test/runtime-integration-e2e.mjs

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, openSync, closeSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// fixture 根：默认 .scratch/rt-integ-<ts>；可经 RT_FIXTURE_ROOT 覆盖到
// 系统临时目录（host 环境删除计数沙箱会拦截 .scratch 内 git lockfile unlink，
// CI/沙箱受限环境用 env RT_FIXTURE_ROOT=$(mktemp -d) 运行）。
import { tmpdir } from 'node:os'
const _baseRoot = process.env.RT_FIXTURE_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.scratch')
const fixtureRoot = mkdtempSync(join(_baseRoot, 'rt-integ-' + Date.now()))

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

  // 验证：A 写 source，B 不可见（A4：RPC 只接收 Run 身份，由注册表解析权威 workspace）
  const writeA = runNode([hostScript, 'writeSourceFile', JSON.stringify({
    logical_run_id: 'run-a', rel: 'secret-a.txt', content: 'from-a', work_root: workRoot,
  })])
  if (!writeA.ok) { console.error('Run A write 失败:', writeA.stderr); return false }
  const visibleInB = existsSync(join(wsB.source_path, 'secret-a.txt'))
  if (visibleInB) { console.error('Run A 的未提交文件对 B 可见！'); return false }
  console.log('  ✓ A 的未提交文件对 B 不可见（RPC 经注册表解析）')

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

// ── 测试 2b（A1）：注册表跨进程串行——并发 acquireLock 只有一个成功 ──────
// 两个独立进程同时抢同一把 integration lock，必须恰有一个成功、
// 一个被拒（跨进程文件锁保证 load-modify-save 不后写覆盖先写）。
function testConcurrentLock() {
  console.log('\n━━ 测试 2b：注册表跨进程锁（并发 acquireLock 串行）━━')
  const workRoot = mkdtempSync(join(fixtureRoot, 'conc-'))
  const hostScript = join(dirname(fileURLToPath(import.meta.url)), '..', 'workspace-isolation-host.mjs')

  // 并行 spawn 两个独立进程，不同 run/owner 抢同一 resource_key
  function spawnAcquire(runId, owner) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [hostScript, 'acquireLock', JSON.stringify({
        logical_run_id: runId, resource_key: 'repo:org/demo:target:main:integration',
        owner: owner, ttl_ms: 30000, work_root: workRoot,
      })], { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d) => { stdout += d })
      child.stderr.on('data', (d) => { stderr += d })
      child.on('close', (code) => {
        try { resolve({ ok: true, parsed: JSON.parse(stdout) }) }
        catch (e) { resolve({ ok: false, error: String(stderr || stdout || e) }) }
      })
    })
  }

  return (async () => {
    const [r1, r2] = await Promise.all([spawnAcquire('run-a', 'run-a'), spawnAcquire('run-b', 'run-b')])
    const won = [r1, r2].filter(r => r.ok && r.parsed.ok && r.parsed.lock)
    const lost = [r1, r2].filter(r => !r.ok || !r.parsed || !r.parsed.ok)
    if (won.length !== 1 || lost.length !== 1) {
      console.error('并发 acquireLock 应恰有一个成功一个被拒，实际:', JSON.stringify([r1, r2].map(r => r.ok && r.parsed ? r.parsed : r)))
      return false
    }
    console.log('  ✓ 并发抢锁：' + won[0].parsed.lock.lock_id + ' 成功，另一个被拒（正确）')

    // 释放后再次并发，仍应只有一个成功（锁状态跨进程一致）
    await new Promise((resolve) => {
      execFileSync(process.execPath, [hostScript, 'releaseLock', JSON.stringify({
        lock_id: won[0].parsed.lock.lock_id, owner: won[0].parsed.lock.owner,
        logical_run_id: won[0].parsed.lock.logical_run_id, reason: 'test', work_root: workRoot,
      })], { encoding: 'utf-8', maxBuffer: 1024 * 1024 })
      resolve()
    })
    const [r3, r4] = await Promise.all([spawnAcquire('run-c', 'run-c'), spawnAcquire('run-d', 'run-d')])
    const won2 = [r3, r4].filter(r => r.ok && r.parsed.ok && r.parsed.lock)
    if (won2.length !== 1) {
      console.error('释放后并发抢锁应恰有一个成功，实际:', won2.length)
      return false
    }
    console.log('  ✓ 释放后并发抢锁仍只有一个成功（注册表无后写覆盖）')

    console.log('  ✅ 测试 2b 通过')
    return true
  })()
}

// ── 测试 2c：初始化空锁不得被判 stale 立即接管（Codex Round 3）────────
function testLockInitNotStale() {
  console.log('\n━━ 测试 2c：空锁文件初始化窗口不得被抢占 ━━')
  const workRoot = mkdtempSync(join(fixtureRoot, 'lock-init-'))
  const hostScript = join(dirname(fileURLToPath(import.meta.url)), '..', 'workspace-isolation-host.mjs')
  const repo = initRepo()
  const lp = workRoot + '/.vwf-registry.lock'
  const fd = openSync(lp, 'wx')
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [hostScript, 'allocate', JSON.stringify({
      logical_run_id: 'run-init', template_id: 'construction',
      repository_path: repo, work_root: workRoot, task_identity: 'issue-lock-init',
    })], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    const done = new Promise((r) => child.on('close', (code) => r(code)))
    setTimeout(async () => {
      const stillRunning = child.exitCode === null
      try { closeSync(fd) } catch { /* ignore */ }
      try { unlinkSync(lp) } catch { /* ignore */ }
      if (!stillRunning) {
        console.error('空锁窗口内 allocate 已结束（被当成 stale 抢占）exit=', child.exitCode, stdout, stderr)
        resolve(false)
        return
      }
      await done
      try {
        const parsed = JSON.parse(stdout)
        if (!parsed.ok || !parsed.workspace) {
          console.error('释放空锁后 allocate 失败:', stdout, stderr)
          resolve(false)
          return
        }
        console.log('  ✓ 空锁窗口内未抢占；释放后 allocate 成功')
        console.log('  ✅ 测试 2c 通过')
        resolve(true)
      } catch (e) {
        console.error('释放后输出不可解析:', stdout, stderr, e.message)
        resolve(false)
      }
    }, 500)
  })
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

  // 构建 provenance（A4：Run 身份）
  const prov = runNode([hostScript, 'buildAttemptProvenance', JSON.stringify({
    logical_run_id: 'run-proof', node: 'review', attempt: 1, work_root: workRoot,
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
    logical_run_id: 'run-proof', proof: fakeProof, work_root: workRoot,
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

// ── 测试 5：产品 DSH 重启后恢复扫描与保留态清理拒绝（LOC-009）────────────
function testRestartRecoveryScan() {
  console.log('\n━━ 测试 5：重启后恢复扫描与保留态清理拒绝（LOC-009）━━')
  const repo = initRepo()
  const workRoot = mkdtempSync(join(fixtureRoot, 'recover-'))
  const hostScript = join(dirname(fileURLToPath(import.meta.url)), '..', 'workspace-isolation-host.mjs')

  const alloc = runNode([hostScript, 'allocate', JSON.stringify({
    logical_run_id: 'run-rec', template_id: 'construction',
    repository_path: repo, repository: 'org/demo',
    work_root: workRoot, task_identity: 'loc-009-recovery',
  })])
  if (!alloc.ok) { console.error('allocate 失败:', alloc.stderr); return false }

  // Run 进入 WAITING_HUMAN（人工决策挂起），写未提交文件，取 integration 锁不释放
  const lc = runNode([hostScript, 'setLifecycle', JSON.stringify({ logical_run_id: 'run-rec', lifecycle: 'WAITING_HUMAN', work_root: workRoot })])
  if (!lc.ok) { console.error('setLifecycle 失败:', lc.stderr); return false }
  const ws = JSON.parse(alloc.stdout).workspace
  writeFileSync(join(ws.source_path, 'wip.txt'), 'run in progress\n')
  const lock = runNode([hostScript, 'acquireLock', JSON.stringify({
    logical_run_id: 'run-rec', resource_key: 'repo:org/demo:target:main:integration', owner: 'run-rec', work_root: workRoot,
  })])
  if (!lock.ok) { console.error('acquireLock 失败:', lock.stderr); return false }
  console.log('  ✓ Run 进入 WAITING_HUMAN 且持有未释放锁')

  // 另外两个保留态（PAUSED / BLOCKED）同样必须被恢复扫描识别且不被清理
  for (const [runId, lifecycle] of [['run-paused', 'PAUSED'], ['run-blocked', 'BLOCKED']]) {
    const a2 = runNode([hostScript, 'allocate', JSON.stringify({
      logical_run_id: runId, template_id: 'construction',
      repository_path: repo, repository: 'org/demo',
      work_root: workRoot, task_identity: 'loc-009-' + runId,
    })])
    if (!a2.ok) { console.error(runId + ' allocate 失败:', a2.stderr); return false }
    const l2 = runNode([hostScript, 'setLifecycle', JSON.stringify({ logical_run_id: runId, lifecycle, work_root: workRoot })])
    if (!l2.ok) { console.error(runId + ' setLifecycle 失败:', l2.stderr); return false }
  }

  // 「重启」：恢复扫描在全新进程中执行（每次 runNode 都是独立进程，等价重启后首调）
  const scan = runNode([hostScript, 'recoverStale', JSON.stringify({ work_root: workRoot })])
  if (!scan.ok) { console.error('recoverStale 失败:', scan.stderr); return false }
  const report = JSON.parse(scan.stdout).scan
  const retained = (report.retained_workspaces || []).find((w) => w.logical_run_id === 'run-rec')
  if (!retained || retained.lifecycle !== 'WAITING_HUMAN') {
    console.error('恢复扫描未识别 WAITING_HUMAN workspace:', JSON.stringify(report.retained_workspaces)); return false
  }
  for (const [runId, lifecycle] of [['run-paused', 'PAUSED'], ['run-blocked', 'BLOCKED']]) {
    const hit = (report.retained_workspaces || []).find((w) => w.logical_run_id === runId && w.lifecycle === lifecycle)
    if (!hit) { console.error('恢复扫描未识别 ' + lifecycle + ' workspace'); return false }
  }
  const active = (report.active_locks || []).find((l) => l.logical_run_id === 'run-rec' && l.resource_key === 'repo:org/demo:target:main:integration')
  if (!active) {
    console.error('恢复扫描未识别未释放锁:', JSON.stringify(report.active_locks)); return false
  }
  console.log('  ✓ 重启后 recoverStale 识别三保留态 workspace（WAITING_HUMAN/PAUSED/BLOCKED）与未释放锁')

  // 保留态清理必须被拒（包装脚本业务失败 = 进程 ok + 输出 ok:false）
  const clean = runNode([hostScript, 'cleanup', JSON.stringify({ logical_run_id: 'run-rec', work_root: workRoot, opts: {} })])
  if (!clean.ok) { console.error('cleanup 调用失败:', clean.stderr); return false }
  if (JSON.parse(clean.stdout).ok) { console.error('WAITING_HUMAN workspace 不应被清理'); return false }
  if (!existsSync(join(ws.source_path, 'wip.txt'))) {
    console.error('WAITING_HUMAN 工作区文件被破坏'); return false
  }
  console.log('  ✓ WAITING_HUMAN 工作区清理被拒，现场文件完好')

  // context：身份 + 事件切片；每 Run 事件按 #79 目录组织落盘 records/
  const ctx = runNode([hostScript, 'context', JSON.stringify({ logical_run_id: 'run-rec', work_root: workRoot })])
  if (!ctx.ok) { console.error('context 失败:', ctx.stderr); return false }
  const ctxData = JSON.parse(ctx.stdout)
  if (!ctxData.workspace || ctxData.workspace.lifecycle !== 'WAITING_HUMAN') {
    console.error('context 未返回 workspace 身份'); return false
  }
  const evTypes = (ctxData.events || []).map((e) => e.type)
  if (!evTypes.includes('workspace_allocated') || !evTypes.includes('lock_acquired')) {
    console.error('context 事件切片缺失:', evTypes.join(',')); return false
  }
  const eventsFile = join(ws.records_path, 'events.json')
  if (!existsSync(eventsFile)) {
    console.error('每 Run 事件切片未落盘:', eventsFile); return false
  }
  const persisted = JSON.parse(readFileSync(eventsFile, 'utf8'))
  const persistedTypes = (persisted.events || []).map((e) => e.type)
  if (!persistedTypes.includes('lock_acquired')) {
    console.error('events.json 缺 lock_acquired 事件:', persistedTypes.join(',')); return false
  }
  console.log('  ✓ context 提供身份+事件切片，records/<run>/events.json 已按 #79 目录组织落盘')

  console.log('  ✅ 测试 5 通过')
  return true
}

// ── 测试 6：模板策略注册表与 optimize resource_kind 解析（LOC-009）───────
function testTemplatePolicyRegistry() {
  console.log('\n━━ 测试 6：模板策略注册表与 resource_kind 解析（LOC-009）━━')
  const repo = initRepo()
  const workRoot = mkdtempSync(join(fixtureRoot, 'policy-'))
  const hostScript = join(dirname(fileURLToPath(import.meta.url)), '..', 'workspace-isolation-host.mjs')

  // 注册表权威：四类正式模板身份与声明
  const reg = runNode([hostScript, 'templateRegistry', JSON.stringify({})])
  if (!reg.ok) { console.error('templateRegistry 失败:', reg.stderr); return false }
  const registry = JSON.parse(reg.stdout).registry
  const expectedKeys = ['construction', 'optimize', 'diagnose', 'explore']
  for (const k of expectedKeys) {
    if (!registry || !registry[k]) { console.error('注册表缺少模板身份: ' + k); return false }
  }
  if (registry.construction.mode !== 'ISOLATED_WRITE' || registry.explore.mode !== 'ISOLATED_READ' || registry.diagnose.freeze_from !== 'diagnose') {
    console.error('注册表声明与契约不一致:', JSON.stringify(registry)); return false
  }
  if (registry.optimize.resource_kinds.git !== 'ISOLATED_WRITE' || registry.optimize.resource_kinds.document !== 'SANDBOX') {
    console.error('optimize resource_kinds 声明与契约不一致'); return false
  }
  console.log('  ✓ templateRegistry 返回四类身份与策略声明（id 猜测退役的权威来源）')

  // optimize + files → ISOLATED_WRITE（git worktree）
  const allocFiles = runNode([hostScript, 'allocate', JSON.stringify({
    logical_run_id: 'run-opt-files', template_id: 'optimize', resource_kind: 'files',
    repository_path: repo, repository: 'org/demo',
    work_root: workRoot, task_identity: 'loc-009-opt-files',
  })])
  if (!allocFiles.ok) { console.error('optimize/files allocate 失败:', allocFiles.stderr); return false }
  const wsFiles = JSON.parse(allocFiles.stdout).workspace
  if (wsFiles.workspace_mode !== 'ISOLATED_WRITE' || wsFiles.provider_id !== 'GitWorktreeWorkspace') {
    console.error('optimize/files 应解析为 ISOLATED_WRITE git 工作区:', wsFiles.workspace_mode, wsFiles.provider_id); return false
  }
  console.log('  ✓ optimize + resource_kind=files → ISOLATED_WRITE（独立 branch + worktree）')

  // optimize + document → SANDBOX（目录沙箱，无 git）
  const allocDoc = runNode([hostScript, 'allocate', JSON.stringify({
    logical_run_id: 'run-opt-doc', template_id: 'optimize', resource_kind: 'document',
    work_root: workRoot, task_identity: 'loc-009-opt-doc',
  })])
  if (!allocDoc.ok) { console.error('optimize/document allocate 失败:', allocDoc.stderr); return false }
  const wsDoc = JSON.parse(allocDoc.stdout).workspace
  if (wsDoc.workspace_mode !== 'SANDBOX' || wsDoc.provider_id !== 'DirectorySandboxWorkspace') {
    console.error('optimize/document 应解析为 SANDBOX:', wsDoc.workspace_mode, wsDoc.provider_id); return false
  }
  console.log('  ✓ optimize + resource_kind=document → SANDBOX（目录沙箱）')

  // optimize 缺 resource_kind → fail closed（不再缺省猜测）
  const allocMissing = runNode([hostScript, 'allocate', JSON.stringify({
    logical_run_id: 'run-opt-missing', template_id: 'optimize',
    work_root: workRoot, task_identity: 'loc-009-opt-missing',
  })])
  if (!allocMissing.ok) { console.error('allocate 调用失败:', allocMissing.stderr); return false }
  const missingOut = JSON.parse(allocMissing.stdout)
  if (missingOut.ok) { console.error('optimize 缺 resource_kind 不应分配成功'); return false }
  if (!String(missingOut.error || '').includes('resource_kind')) {
    console.error('缺 resource_kind 错误信息不明确:', missingOut.error); return false
  }
  console.log('  ✓ optimize 缺 resource_kind 时 fail closed 并给出明确错误')

  // 清理两个成功分配（WAITING_HUMAN 语义不适用，直接终态后清理）
  runNode([hostScript, 'setLifecycle', JSON.stringify({ logical_run_id: 'run-opt-files', lifecycle: 'COMPLETED', work_root: workRoot })])
  runNode([hostScript, 'setLifecycle', JSON.stringify({ logical_run_id: 'run-opt-doc', lifecycle: 'COMPLETED', work_root: workRoot })])
  const c1 = runNode([hostScript, 'cleanup', JSON.stringify({ logical_run_id: 'run-opt-files', work_root: workRoot, opts: {} })])
  const c2 = runNode([hostScript, 'cleanup', JSON.stringify({ logical_run_id: 'run-opt-doc', work_root: workRoot, opts: {} })])
  if (!c1.ok || !c2.ok) { console.error('清理失败:', c1.stderr || c2.stderr); return false }

  console.log('  ✅ 测试 6 通过')
  return true
}

// ── 主程序 ──────────────────────────────────────────────────────────────
console.log('═══════════════════════════════════════════════════════════════')
console.log('#93 DSH Runtime Integration 真机验收')
console.log('时间:', new Date().toISOString())
console.log('═══════════════════════════════════════════════════════════════')

let pass = 0
let fail = 0

for (const fn of [testDualRunIsolation, testIntegrationLock, testConcurrentLock, testLockInitNotStale, testSnapshotUpdate, testProofBinding, testRestartRecoveryScan, testTemplatePolicyRegistry]) {
  try {
    const r = fn()
    // async 测试（并发场景）返回 Promise：await 后按真实结果计分
    if (r && typeof r.then === 'function') {
      const ok = await r
      if (ok) pass++
      else fail++
    } else if (r) pass++
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
