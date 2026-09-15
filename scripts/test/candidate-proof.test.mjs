// LOC-026 候选证明（WR-003 / task-spec-V1）验收：
//   AC-02 Git 同一 HEAD 下受审文件未提交修改被发现；声明排除的临时证据不影响候选
//   AC-03 非 Git 文件集合增/删/改/更名改变候选标识；排序变化不改变摘要
//   AC-04 审核期间被审成果变化 → 两次捕获不一致；完全相同候选正常通过
//   以及：越界符号链接拒绝、roots 限定、head 变化、包装脚本命令、编译脚本候选闸门
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  WORKSPACE_MODE, createRegistry, allocateWorkspace, getRunWorkspace,
  captureCandidate, compareCandidate,
} from '../workspace-isolation.mjs'
import { compileBlueprint } from '../generate.mjs'
import { runGeneratedScript, makeAgentScript } from './helpers/runtime-harness.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const fixtureRoot = join(here, '..', '..', '.scratch', 'candidate-proof-tests')
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
  cleanups.push(() => {
    for (const id of [...reg.workspaces.keys()]) {
      const ws = reg.workspaces.get(id)
      if (!ws) continue
      ws.lifecycle = 'COMPLETED'
      try { execFileSync('git', ['worktree', 'remove', '--force', ws.source_path], { cwd: repo, stdio: 'ignore' }) } catch { /* ignore */ }
    }
  })
  return allocateWorkspace(reg, {
    logical_run_id: runId, mode: WORKSPACE_MODE.ISOLATED_WRITE,
    repository_path: repo, repository: 'org/demo', work_root: workRoot(), task_identity: runId,
  })
}

function sandboxWorkspace(runId) {
  const reg = createRegistry()
  return allocateWorkspace(reg, {
    logical_run_id: runId, mode: WORKSPACE_MODE.SANDBOX, work_root: workRoot(), task_identity: runId,
  })
}

const shaOf = (ws, options) => captureCandidate(ws, options).version.content_sha256

// ── AC-02：Git 工作树内容绑定 ────────────────────────────────────────────────

test('AC-02 Git 同一 HEAD 下未提交修改受审文件 → 候选摘要变化；head 不变', () => {
  const repo = initRepo()
  const ws = gitWorkspace(repo, 'run-ac02')
  const before = captureCandidate(ws)
  writeFileSync(join(ws.source_path, 'src.txt'), 'tampered uncommitted\n')
  const after = captureCandidate(ws)
  assert.equal(after.version.head, before.version.head, 'HEAD 未动：仅凭 HEAD 不得放行差异')
  assert.notEqual(after.version.content_sha256, before.version.content_sha256, '未提交修改必须改变候选摘要')
})

test('AC-02 Git 已提交新 HEAD → head 与摘要同时变化（旧 HEAD 证明失效）', () => {
  const repo = initRepo()
  const ws = gitWorkspace(repo, 'run-ac02-head')
  const before = captureCandidate(ws)
  writeFileSync(join(ws.source_path, 'next.txt'), 'committed\n')
  git(['add', '-A'], ws.source_path)
  git(['commit', '-q', '-m', 'advance'], ws.source_path)
  const after = captureCandidate(ws)
  assert.notEqual(after.version.head, before.version.head)
  assert.notEqual(after.version.content_sha256, before.version.content_sha256)
})

test('AC-02 Git 声明排除的临时证据文件变化不影响候选；未声明的未跟踪交付文件影响', () => {
  const repo = initRepo()
  const ws = gitWorkspace(repo, 'run-ac02-excl')
  mkdirSync(join(ws.source_path, '.agent-runs', 'run-ac02-excl'), { recursive: true })
  writeFileSync(join(ws.source_path, '.agent-runs', 'run-ac02-excl', 'review-report.md'), 'v1\n')
  const options = { exclude: ['.agent-runs/run-ac02-excl'] }
  const before = captureCandidate(ws, options)
  writeFileSync(join(ws.source_path, '.agent-runs', 'run-ac02-excl', 'review-report.md'), 'v2 edited\n')
  const after = captureCandidate(ws, options)
  assert.equal(after.version.content_sha256, before.version.content_sha256, '显式声明排除的证据文件不使候选失效')
  // 未声明排除的未跟踪业务文件属于声明交付内容，必须进入候选
  writeFileSync(join(ws.source_path, 'new-feature.txt'), 'delivered\n')
  const withNew = captureCandidate(ws, options)
  assert.notEqual(withNew.version.content_sha256, after.version.content_sha256, '未跟踪交付内容不得被默认忽略')
  assert.ok(withNew.scope_manifest.some((e) => e.path === 'new-feature.txt'))
})

test('AC-02 roots 把摘要限定在声明成果集合内', () => {
  const repo = initRepo()
  const ws = gitWorkspace(repo, 'run-ac02-roots')
  mkdirSync(join(ws.source_path, 'docs'), { recursive: true })
  writeFileSync(join(ws.source_path, 'docs', 'a.md'), 'doc\n')
  git(['add', '-A'], ws.source_path)
  git(['commit', '-q', '-m', 'docs'], ws.source_path)
  const scoped = { roots: ['docs'] }
  const before = shaOf(ws, scoped)
  writeFileSync(join(ws.source_path, 'src.txt'), 'changed outside scope\n')
  assert.equal(shaOf(ws, scoped), before, 'roots 之外的变化不改变声明集合的候选')
  writeFileSync(join(ws.source_path, 'docs', 'a.md'), 'changed inside scope\n')
  assert.notEqual(shaOf(ws, scoped), before, 'roots 之内的变化必须改变候选')
})

// ── AC-03：非 Git 文件集合 ──────────────────────────────────────────────────

test('AC-03 非 Git 文档集合：修改/新增/删除/更名都改变候选标识', () => {
  const ws = sandboxWorkspace('run-ac03')
  writeFileSync(join(ws.source_path, 'doc-a.md'), 'A\n')
  writeFileSync(join(ws.source_path, 'doc-b.md'), 'B\n')
  const base = shaOf(ws)
  assert.equal(shaOf(ws), base, '完全相同的候选重复捕获一致（AC-04 正例）')
  // 修改
  writeFileSync(join(ws.source_path, 'doc-a.md'), 'A changed\n')
  const modified = shaOf(ws)
  assert.notEqual(modified, base)
  // 新增
  writeFileSync(join(ws.source_path, 'doc-c.md'), 'C\n')
  const added = shaOf(ws)
  assert.notEqual(added, modified)
  // 更名（删旧建新，内容不变）
  writeFileSync(join(ws.source_path, 'doc-c-renamed.md'), readFileSync(join(ws.source_path, 'doc-c.md'), 'utf-8'))
  rmSync(join(ws.source_path, 'doc-c.md'), { force: true })
  const renamed = shaOf(ws)
  assert.notEqual(renamed, added)
  // 删除
  rmSync(join(ws.source_path, 'doc-b.md'), { force: true })
  const removed = shaOf(ws)
  assert.notEqual(removed, renamed)
  // 路径进入 scope_manifest 且已排序
  const ref = captureCandidate(ws)
  const paths = ref.scope_manifest.map((e) => e.path)
  assert.deepEqual(paths, [...paths].sort(), 'scope_manifest 按路径排序（排序稳定，摘要不受枚举顺序影响）')
})

test('AC-03 compareCandidate：排序变化不改变判定；完全相同候选 match', () => {
  const ws = sandboxWorkspace('run-ac03-cmp')
  writeFileSync(join(ws.source_path, 'a.md'), 'A\n')
  writeFileSync(join(ws.source_path, 'b.md'), 'B\n')
  const ref = captureCandidate(ws)
  assert.equal(compareCandidate(ref, ref).match, true, '同一候选判定 match')
  const reordered = { ...ref, scope_manifest: [...ref.scope_manifest].reverse() }
  assert.equal(compareCandidate(ref, reordered).match, true, 'manifest 排序变化不改变摘要判定')
  const other = { ...ref, version: { ...ref.version, content_sha256: 'different' } }
  const cmp = compareCandidate(ref, other)
  assert.equal(cmp.match, false)
  assert.ok(cmp.mismatches.some((m) => m.field === 'version.content_sha256'))
})

test('compareCandidate：kind/resource_id/head 差异逐字段报告（AC-01 指认依据）', () => {
  const ref = { kind: 'git', resource_id: 'org/demo', scope_manifest: [], version: { head: 'aaa', content_sha256: 's1' } }
  const cmpKind = compareCandidate({ ...ref, kind: 'files' }, ref)
  assert.equal(cmpKind.match, false)
  assert.ok(cmpKind.mismatches.some((m) => m.field === 'kind'))
  const cmpHead = compareCandidate({ ...ref, version: { head: 'bbb', content_sha256: 's1' } }, ref)
  assert.ok(cmpHead.mismatches.some((m) => m.field === 'version.head'))
  assert.equal(cmpHead.match, false)
  assert.throws(() => compareCandidate(null, ref), /candidate_ref/)
  assert.throws(() => compareCandidate({ kind: 'x' }, ref), /kind/)
})

test('越界符号链接：捕获拒绝，不跟随不外泄', () => {
  const repo = initRepo()
  const outside = mkdtempSync(join(fixtureRoot, 'outside-'))
  cleanups.push(() => { try { rmSync(outside, { recursive: true, force: true }) } catch { /* ignore */ } })
  writeFileSync(join(outside, 'leaked.txt'), 'secret')
  let linkOk = true
  try {
    symlinkSync(outside, join(repo, 'escape-dir'))
    git(['add', 'escape-dir'], repo)
    git(['commit', '-q', '-m', 'add-symlink'], repo)
  } catch (e) {
    linkOk = false // 本机无 symlink 权限（Windows 非管理员）：环境限制，不在本测断言
  }
  if (!linkOk) return
  const ws = gitWorkspace(repo, 'run-link')
  assert.throws(() => captureCandidate(ws), /越界符号链接|逃出/)
})

test('NONE workspace 与缺 source 不可捕获（fail closed）', () => {
  const reg = createRegistry()
  const dir = mkdtempSync(join(fixtureRoot, 'root-none-'))
  cleanups.push(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } })
  const ws = allocateWorkspace(reg, { logical_run_id: 'run-none', mode: WORKSPACE_MODE.NONE, work_root: dir })
  assert.throws(() => captureCandidate(ws), /没有 source/)
  assert.throws(() => captureCandidate(null), /workspace/)
})

// ── 包装脚本命令接线（真实 wrapper，仅真实进程边界）────────────────────────

test('wrapper captureCandidate/compareCandidate 命令可用且捕获范围随宿主选项确定', () => {
  const repo = initRepo()
  const root = mkdtempSync(join(fixtureRoot, 'root-wrap-'))
  cleanups.push(() => { try { rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ } })
  const wrapper = join(here, '..', 'workspace-isolation-host.mjs')
  const nodeBin = process.execPath
  // 注册表权威在磁盘（work_root/.vwf-registry）：allocate 也必须经 wrapper 事务完成
  const run = (cmd, input) => JSON.parse(execFileSync(nodeBin, [wrapper, cmd, JSON.stringify({ work_root: root, ...input })], { encoding: 'utf-8' }))
  const alloc = run('allocate', { logical_run_id: 'run-wrap', mode: 'ISOLATED_WRITE', repository_path: repo, repository: 'org/demo', task_identity: 'run-wrap' })
  assert.equal(alloc.ok, true, JSON.stringify(alloc))
  writeFileSync(join(alloc.workspace.source_path, 'w.txt'), 'wrap\n')
  const cap = run('captureCandidate', { logical_run_id: 'run-wrap', options: { exclude: [] } })
  assert.equal(cap.ok, true)
  assert.equal(cap.candidate.kind, 'git')
  assert.ok(cap.candidate.scope_manifest.some((e) => e.path === 'w.txt'))
  assert.ok(cap.candidate.version.content_sha256.length === 64)
  const cap2 = run('captureCandidate', { logical_run_id: 'run-wrap', options: { exclude: [] } })
  assert.equal(cap2.candidate.version.content_sha256, cap.candidate.version.content_sha256, '相同候选重复捕获一致')
  const cmp = run('compareCandidate', { current: cap.candidate, expected: cap2.candidate })
  assert.equal(cmp.ok, true)
  assert.equal(cmp.compare.match, true)
  // 捕获范围选项（宿主注入）真实生效：排除后 manifest 与摘要随之变化
  const capExcl = run('captureCandidate', { logical_run_id: 'run-wrap', options: { exclude: ['w.txt'] } })
  assert.ok(!capExcl.candidate.scope_manifest.some((e) => e.path === 'w.txt'))
  assert.notEqual(capExcl.candidate.version.content_sha256, cap.candidate.version.content_sha256)
})

// ── 编译脚本候选闸门（LOC-026 claim 扩展）───────────────────────────────────

function verifyBp() {
  return {
    id: 'cand-spec', displayName: '候选闸门测试图', description: '', entry: 'review',
    control: { maxRounds: 3 },
    nodes: [
      {
        id: 'review', profile: 'review', label: '审核', verifyBranch: true,
        output: {
          outcomePath: '$.route',
          schema: {
            type: 'object',
            properties: { route: { type: 'string', enum: ['APPROVE'] }, verified_branch: { type: 'string' }, verified_head: { type: 'string' } },
            required: ['route', 'verified_branch', 'verified_head'],
          },
        },
      },
    ],
    edges: [{ from: 'review', to: '$end', outcome: 'APPROVE' }],
  }
}

const CLAIM_OK = { route: 'APPROVE', verified_branch: 'dev2/t1', verified_head: 'h1' }

test('编译脚本：workspace capability 存在时缺 candidate_sha256 → 技术失败并说明候选闸门', async () => {
  const { script } = compileBlueprint(verifyBp())
  assert.ok(script.includes('captureCandidate'), 'verifyBranch 节点运行上下文必须注入候选捕获指引')
  const agent = makeAgentScript({ 审核: CLAIM_OK })
  const { result } = await runGeneratedScript(script, { args: { taskId: 't1', workspace_capability: 'cap-x' }, agent })
  assert.equal(result.status, 'TECHNICAL_FAILURE')
  assert.ok(String(result.detail).includes('candidate_sha256'), '失败原因指名候选闸门')
})

test('编译脚本：携带 candidate_sha256 通过；无 workspace 的旧形态不受新规则约束', async () => {
  const { script } = compileBlueprint(verifyBp())
  const withCand = makeAgentScript({ 审核: { ...CLAIM_OK, candidate_sha256: 'host-captured' } })
  const ok = await runGeneratedScript(script, { args: { taskId: 't1', workspace_capability: 'cap-x' }, agent: withCand })
  assert.equal(ok.result.status, 'DONE', '对候选证明齐全的正常审核放行（AC-04 正例）')
  const legacyAgent = makeAgentScript({ 审核: CLAIM_OK })
  const legacy = await runGeneratedScript(script, { args: { taskId: 't1' }, agent: legacyAgent })
  assert.equal(legacy.result.status, 'DONE', '无 workspace capability 的旧形态保持原 claim 规则（兼容）')
})
