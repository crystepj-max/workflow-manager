// LOC-041 节点隔离验收：AC-01~04 与 UAT-01~04 的可执行替身证据
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ISOLATION_GUARANTEE, NODE_ROLE_CAPABILITIES,
  probeIsolationCapability, buildProbeProfile, resolveNodeCapabilities, prepareNodeContext,
  writeInZone, publishProbe, runPrivilegeProbes,
  verifyCandidateUnchanged, canIssueIndependentProof,
} from '../node-isolation.mjs'
import { WORKSPACE_MODE, createRegistry, allocateWorkspace } from '../workspace-isolation.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const host = join(here, '..', 'node-isolation-host.mjs')
const fixtureRoot = join(here, '..', '..', '.scratch', 'node-isolation-tests')
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
  writeFileSync(join(root, 'src.txt'), 'base\n')
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

function gitWorkspace(repo, runId) {
  const reg = createRegistry()
  return allocateWorkspace(reg, {
    logical_run_id: runId,
    mode: WORKSPACE_MODE.ISOLATED_WRITE,
    repository_path: repo,
    repository: 'org/demo',
    work_root: workRoot(),
    task_identity: runId,
  })
}

function hostCall(cmd, input) {
  const out = execFileSync('node', [host, cmd, JSON.stringify(input)], { encoding: 'utf-8' })
  const parsed = JSON.parse(out.trim())
  assert.equal(parsed.ok, true, cmd + ' 应成功: ' + JSON.stringify(parsed))
  return parsed
}

// ── 能力矩阵 ────────────────────────────────────────────────────────────────

test('resolveNodeCapabilities：review 只读候选、可写证据', () => {
  const caps = resolveNodeCapabilities('review')
  assert.equal(caps.candidate.write, false)
  assert.equal(caps.evidence.write, true)
  assert.equal(caps.independent_proof, true)
})

test('resolveNodeCapabilities：不得放宽基线能力', () => {
  assert.throws(() => resolveNodeCapabilities('review', { candidate: { write: true } }))
})

test('canIssueIndependentProof：unavailable 阻断正式独立 Proof', () => {
  const d = canIssueIndependentProof(ISOLATION_GUARANTEE.UNAVAILABLE, NODE_ROLE_CAPABILITIES.review)
  assert.equal(d.ok, false)
})

test('canIssueIndependentProof：enforced + review 允许', () => {
  const d = canIssueIndependentProof(ISOLATION_GUARANTEE.ENFORCED, NODE_ROLE_CAPABILITIES.review)
  assert.equal(d.ok, true)
})

// ── AC-01 / UAT-01：越权写入拒绝 ───────────────────────────────────────────

test('AC-01 review 写候选被文件层拒绝，候选字节不变', () => {
  const repo = initRepo()
  const ws = gitWorkspace(repo, 'run-review')
  writeFileSync(join(ws.source_path, 'canary.txt'), 'original\n')
  const before = readFileSync(join(ws.source_path, 'canary.txt'))
  const ctx = prepareNodeContext(ws, { node_id: 'review', profile: 'review', isolation_guarantee: ISOLATION_GUARANTEE.ENFORCED })
  assert.throws(() => writeInZone(ctx, 'candidate', 'canary.txt', 'tampered\n', ws.workspace_path))
  const after = readFileSync(join(ws.source_path, 'canary.txt'))
  assert.deepEqual(before, after)
})

test('AC-01 test 写业务源被拒绝', () => {
  const repo = initRepo()
  const ws = gitWorkspace(repo, 'run-test')
  const ctx = prepareNodeContext(ws, { node_id: 'test', profile: 'test', isolation_guarantee: ISOLATION_GUARANTEE.ENFORCED })
  assert.throws(() => writeInZone(ctx, 'source', 'src.txt', 'hack\n', ws.workspace_path))
})

test('AC-01 researcher 写源树被拒绝', () => {
  const repo = initRepo()
  const ws = gitWorkspace(repo, 'run-res')
  const ctx = prepareNodeContext(ws, { node_id: 'expert-a', profile: 'researcher', isolation_guarantee: ISOLATION_GUARANTEE.ENFORCED })
  assert.throws(() => writeInZone(ctx, 'source', 'src.txt', 'hack\n', ws.workspace_path))
})

// ── AC-02 / UAT-02：合法操作成功 ───────────────────────────────────────────

test('AC-02 review 可写证据区；test 可写覆盖层与缓存根', () => {
  const repo = initRepo()
  const ws = gitWorkspace(repo, 'run-legal')
  const rctx = prepareNodeContext(ws, { node_id: 'review', profile: 'review', isolation_guarantee: ISOLATION_GUARANTEE.ENFORCED })
  const report = writeInZone(rctx, 'evidence', 'review-report.md', '# ok\n', ws.workspace_path)
  assert.ok(existsSync(report))
  const tctx = prepareNodeContext(ws, { node_id: 'test', profile: 'test', isolation_guarantee: ISOLATION_GUARANTEE.ENFORCED })
  const overlay = writeInZone(tctx, 'test_overlay', 'case.mjs', 'export const x = 1\n', ws.workspace_path)
  assert.ok(existsSync(overlay))
  const digestBefore = tctx.candidate_digest
  const verify = verifyCandidateUnchanged(tctx, digestBefore)
  assert.equal(verify.ok, true)
})

// ── AC-03 / UAT-03：发布授权边界 ───────────────────────────────────────────

test('AC-03 无授权发布拒绝且无副作用', () => {
  const denied = publishProbe({ authorized: false, target: 'probe://local/publish', action: 'publish' })
  assert.equal(denied.ok, false)
  assert.equal(denied.side_effect, false)
  const allowed = publishProbe({ authorized: true, target: 'probe://local/publish', action: 'publish' })
  assert.equal(allowed.ok, true)
  assert.match(allowed.remote_ref, /^probe-local-/)
  const badTarget = publishProbe({ authorized: true, target: 'https://evil.example/publish', action: 'publish' })
  assert.equal(badTarget.ok, false)
})

// ── AC-04 / UAT-04：绕过与不支持 ───────────────────────────────────────────

test('AC-04 越权探针全部拒绝且候选不变', () => {
  const repo = initRepo()
  const ws = gitWorkspace(repo, 'run-bypass')
  writeFileSync(join(ws.source_path, '.ni-canary.txt'), 'base\n')
  const ctx = prepareNodeContext(ws, { node_id: 'review', profile: 'review', isolation_guarantee: ISOLATION_GUARANTEE.ENFORCED })
  const results = runPrivilegeProbes(ctx, { seed_canary: false })
  for (const r of results) {
    assert.equal(r.allowed, false, r.probe + ' 应被拒绝')
    assert.equal(r.candidate_unchanged, true, r.probe + ' 候选应不变')
  }
})

test('AC-04 unavailable 配置不能签发独立 Proof', () => {
  const d = canIssueIndependentProof(ISOLATION_GUARANTEE.UNAVAILABLE, NODE_ROLE_CAPABILITIES.review)
  assert.equal(d.ok, false)
  assert.match(d.reason, /unavailable/)
})

test('probeIsolationCapability：forced 模式可测试', () => {
  const enforced = probeIsolationCapability({ force_guarantee: ISOLATION_GUARANTEE.ENFORCED })
  assert.equal(enforced.guarantee, ISOLATION_GUARANTEE.ENFORCED)
  const unavailable = probeIsolationCapability({ force_guarantee: ISOLATION_GUARANTEE.UNAVAILABLE })
  assert.equal(unavailable.guarantee, ISOLATION_GUARANTEE.UNAVAILABLE)
})

// ── 包装脚本 ────────────────────────────────────────────────────────────────

test('node-isolation-host：prepareNode + publishProbe + canIssueProof', () => {
  const repo = initRepo()
  const reg = createRegistry()
  const wr = workRoot()
  const ws = allocateWorkspace(reg, {
    logical_run_id: 'run-host', mode: WORKSPACE_MODE.ISOLATED_WRITE,
    repository_path: repo, repository: 'org/demo', work_root: wr, task_identity: 'run-host',
  })
  mkdirSync(join(wr, '.vwf-registry'), { recursive: true })
  writeFileSync(join(wr, '.vwf-registry/state.json'), JSON.stringify({
    workspaces: { 'run-host': ws }, locks: {}, locksByKey: {}, timeline: [], archived: {},
    lockSeq: 0, nextPort: 39100, ports: [],
  }))
  const prep = hostCall('prepareNode', {
    work_root: wr, logical_run_id: 'run-host', node_id: 'review', profile: 'review',
    isolation_guarantee: ISOLATION_GUARANTEE.ENFORCED,
  })
  assert.equal(prep.context.profile, 'review')
  const pub = hostCall('publishProbe', { authorized: false })
  assert.equal(pub.result.ok, false)
  const proof = hostCall('canIssueProof', { isolation_guarantee: ISOLATION_GUARANTEE.ENFORCED, profile: 'review' })
  assert.equal(proof.decision.ok, true)
})

// ═══════════════════════════════════════════════════════════════════════════
// FIX-235 回归：探针 profile 与三判定（区内进程可跑 / 区内可写 / 区外写入被拒）
// 根因：旧参考配置 (deny default) 下当前 macOS 进程启动读 dyld 闭包即被拒，
// canary SIGABRT(134)，insideAllowed 恒 false → 恒 unavailable（故障机 2026-09-20 实证）。
// ═══════════════════════════════════════════════════════════════════════════

test('FIX-235 profile：写入范围收紧型（allow default + deny 区外 file-write*）', () => {
  const profile = buildProbeProfile('/private/tmp/ni-inside')
  assert.ok(profile.includes('(version 1)'), '含版本声明')
  assert.ok(profile.includes('(allow default)'), '默认放行（不锁 dyld 闭包，进程可启动）')
  assert.ok(
    profile.includes('(deny file-write* (require-not (subpath "/private/tmp/ni-inside")))'),
    '写入拒绝排除区内子路径：' + profile,
  )
  assert.ok(!profile.includes('(deny default)'), '不得再使用 (deny default)')
})

test('FIX-235 语义回归：非 darwin 平台判 unavailable 且不执行探针', () => {
  const r = probeIsolationCapability({ platform: 'linux', probe_root: join(fixtureRoot, 'ni-should-not-exist') })
  assert.equal(r.guarantee, ISOLATION_GUARANTEE.UNAVAILABLE)
  assert.equal(r.backend, null)
  assert.equal(existsSync(join(fixtureRoot, 'ni-should-not-exist')), false, '非 darwin 不落探测目录')
})

test('FIX-235 真机探针：darwin 上输出 enforced 且三证据齐全（AC-03，非 darwin 跳过）', { skip: process.platform !== 'darwin' }, () => {
  const probeRoot = join(fixtureRoot, 'ni-live-' + Date.now())
  const r = probeIsolationCapability({ probe_root: probeRoot })
  assert.equal(r.guarantee, ISOLATION_GUARANTEE.ENFORCED, JSON.stringify(r.evidence))
  assert.equal(r.evidence.insideAllowed, true, '区内进程可跑')
  assert.equal(r.evidence.insideWrite, true, '区内写入成功')
  assert.equal(r.evidence.outsideBlocked, true, '区外写入被拒（file-write 本身，非 exec）')
  assert.equal(existsSync(probeRoot), false, '探针现场默认清理')
})
