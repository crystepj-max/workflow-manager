import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { allocate, update, loadRegistry } from '../local-task-registry.mjs'
import { buildCommitMessage, checkMerge, runMerge, parseRemoteAnchors, remoteRepoSlug, closeTaskHint } from '../local-task-merge.mjs'
import { worktreePathFor } from '../workspace-paths.mjs'

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'local-track-test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'local-track-test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
}

function g(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', env: GIT_ENV }).trim()
}

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loc-merge-'))
  g(['init', '-b', 'main'], dir)
  fs.writeFileSync(path.join(dir, 'README.md'), '# demo\n')
  g(['add', '-A'], dir)
  g(['commit', '-m', 'init'], dir)
  return dir
}

function seedTask(repo, { name = 'Fix Login', status = '等待验收', baseline = 'V1' } = {}) {
  const rec = allocate(repo, { name, source: '会话录入', baseline })
  const slug = rec.slug
  fs.mkdirSync(path.join(repo, '.scratch', `${rec.task_id}-${slug}`), { recursive: true })
  fs.writeFileSync(
    path.join(repo, '.scratch', `${rec.task_id}-${slug}`, `task-spec-${baseline}.md`),
    `# 任务规格 ${baseline}\n\n**版本**：${baseline}\n\n未决产品事项：0\n`,
  )
  fs.writeFileSync(
    path.join(repo, 'docs', 'tasks', `${rec.task_id}-${slug}.md`),
    `# 任务卡\n\n| 字段 | 值 |\n|---|---|\n| 任务标识 | ${rec.task_id} |\n| 需求基线版本 | ${baseline} |\n| 当前状态 | ${status} |\n| 任务规格位置 | .scratch/${rec.task_id}-${slug}/task-spec-${baseline}.md |\n\n### 涉及范围\n\n- 做：修好登录\n- 不做：注册\n`,
  )
  update(repo, rec.task_id, { status, spec_path: `.scratch/${rec.task_id}-${slug}/task-spec-${baseline}.md` })
  g(['add', '-A'], repo)
  g(['commit', '-m', `chore: seed ${rec.task_id}`], repo)
  return { ...loadRegistry(repo).tasks[0], slug }
}

function makeBranch(repo, branch, fileName, content) {
  g(['branch', branch, 'main'], repo)
  // 相邻容器布局（约定 §1.4）：工作树不得位于仓库目录内部
  const wt = worktreePathFor(repo, branch)
  fs.mkdirSync(path.dirname(wt), { recursive: true })
  g(['worktree', 'add', wt, branch], repo)
  fs.writeFileSync(path.join(wt, fileName), content)
  g(['add', '-A'], wt)
  g(['commit', '-m', 'feat: work'], wt)
  return wt
}

test('buildCommitMessage：必带任务标识/基线/来源/验收结果/归档路径', () => {
  const msg = buildCommitMessage({
    taskId: 'LOC-001',
    name: '修好登录',
    baseline: 'V1',
    scope: 'auth',
    source: '会话录入',
    sourceRef: '2026-09-08 会话',
    rangeText: '修好登录',
    decision: 'accept',
    runId: 'loc-001-r1',
    cardArchive: 'docs/tasks/archive/LOC-001/LOC-001-login.md',
    specArchive: 'docs/tasks/archive/LOC-001/task-spec-V1.md',
  })
  assert.match(msg.split('\n')[0], /^feat\(auth\): 修好登录 \(LOC-001 V1\)$/)
  for (const line of [
    '任务标识: LOC-001',
    '需求基线: V1',
    '需求来源: 会话录入 — 2026-09-08 会话',
    '验收结果: 通过',
    '关联交付运行: loc-001-r1',
    'GitHub 同步: 待补 issue',
  ]) {
    assert.ok(msg.includes(line), `缺少行：${line}`)
  }
  assert.ok(msg.includes('docs/tasks/archive/LOC-001/task-spec-V1.md'))
})

test('buildCommitMessage：有条件通过时附优化意见', () => {
  const msg = buildCommitMessage({
    taskId: 'LOC-002',
    name: 'x',
    baseline: 'V1',
    decision: 'conditional_pass',
    cardArchive: 'a',
    specArchive: 'b',
    feedback: '空态提示文案待优化',
  })
  assert.match(msg, /验收结果: 有条件通过/)
  assert.match(msg, /空态提示文案待优化/)
  assert.match(msg, /不改本轮基线/)
})

test('checkMerge：reject 禁止合并', () => {
  const repo = tmpRepo()
  const rec = seedTask(repo)
  makeBranch(repo, 'dev-loc-001-r1', 'a.txt', 'branch\n')
  const c = checkMerge({ repo, taskId: rec.task_id, branch: 'dev-loc-001-r1', decision: 'reject' })
  assert.equal(c.ok, false)
  assert.match(c.failures.join('\n'), /accept \/ conditional_pass/)
})

test('checkMerge：状态不是等待验收则受阻', () => {
  const repo = tmpRepo()
  const rec = seedTask(repo, { status: '本地已定义' })
  makeBranch(repo, 'dev-loc-001-r1', 'a.txt', 'branch\n')
  const c = checkMerge({ repo, taskId: rec.task_id, branch: 'dev-loc-001-r1', decision: 'accept' })
  assert.equal(c.ok, false)
  assert.match(c.failures.join('\n'), /等待验收/)
})

test('checkMerge：任务卡与规格版本不一致则受阻', () => {
  const repo = tmpRepo()
  const rec = seedTask(repo)
  const cardPath = path.join(repo, 'docs', 'tasks', `${rec.task_id}-${rec.slug}.md`)
  fs.writeFileSync(cardPath, fs.readFileSync(cardPath, 'utf-8').replace('| 需求基线版本 | V1 |', '| 需求基线版本 | V2 |'))
  g(['add', '-A'], repo)
  g(['commit', '-m', 'chore: drift'], repo)
  makeBranch(repo, 'dev-loc-001-r1', 'a.txt', 'branch\n')
  const c = checkMerge({ repo, taskId: rec.task_id, branch: 'dev-loc-001-r1', decision: 'accept' })
  assert.equal(c.ok, false)
  assert.match(c.failures.join('\n'), /版本不一致/)
})

test('端到端：一任务一提交合并回本地主干，标签与归档齐全', () => {
  const repo = tmpRepo()
  const rec = seedTask(repo)
  makeBranch(repo, 'dev-loc-001-r1', 'feature.txt', 'new feature\n')

  const out = runMerge({
    repo,
    taskId: rec.task_id,
    branch: 'dev-loc-001-r1',
    decision: 'accept',
    scope: 'auth',
    runId: 'loc-001-r1',
  })
  assert.equal(out.ok, true, JSON.stringify(out.failures))
  assert.equal(out.merged, true)

  // 一任务一提交：主干只多了 1 个提交
  assert.equal(Number(g(['rev-list', '--count', 'main'], repo)), 3)
  const subject = g(['log', '-1', '--pretty=%s'], repo)
  assert.match(subject, /\(LOC-001 V1\)/)
  const body = g(['log', '-1', '--pretty=%b'], repo)
  assert.match(body, /任务标识: LOC-001/)
  assert.match(body, /验收结果: 通过/)

  // 标签
  assert.match(g(['tag', '-l'], repo), /task\/loc-001\/v1/)

  // 归档随同一提交入库：任务卡与规格都在主干里
  const tracked = g(['ls-tree', '-r', '--name-only', 'main'], repo)
  assert.match(tracked, /docs\/tasks\/archive\/LOC-001\/LOC-001-fix-login\.md/)
  assert.match(tracked, /docs\/tasks\/archive\/LOC-001\/task-spec-V1\.md/)
  assert.match(tracked, /docs\/tasks\/registry\.json/)

  // 登记册状态与合并提交
  const after = loadRegistry(repo).tasks[0]
  assert.equal(after.status, '已合并')
  assert.equal(after.merge.commit, out.commit)
  assert.equal(after.github_sync, 'pending')

  // 阶段一口径：工作区自动删除、分支保留（供后续补 PR）
  assert.equal(out.workspace.removed, true, JSON.stringify(out.workspace))
  assert.ok(g(['branch', '--list', 'dev-loc-001-r1'], repo))
  assert.equal(fs.existsSync(worktreePathFor(repo, 'dev-loc-001-r1')), false)
  assert.equal(g(['worktree', 'list', '--porcelain'], repo).includes(worktreePathFor(repo, 'dev-loc-001-r1')), false)
  // 清理兜底已执行（该结果此前无任何用例断言，退化不会被发现）
  assert.equal(out.pruned, true)

  // 登记册写 branch_retained=true（否则 D-10 会静默跳过该任务）
  assert.equal(after.branch_retained, true)
})

test('端到端：工作区不可删除时不被强制删除，合并不被阻塞且登记遗留', () => {
  const repo = tmpRepo()
  const rec = seedTask(repo)
  const wt = makeBranch(repo, 'dev-loc-001-r1', 'a.txt', 'branch\n')
  // 状态门禁（STATUS_PATHSPEC）排除 .scratch，故此处不算「工作区脏」，
  // 但对 git 而言它是未跟踪文件——删除必须被拒绝，且不得使用 --force。
  fs.mkdirSync(path.join(wt, '.scratch'), { recursive: true })
  fs.writeFileSync(path.join(wt, '.scratch', 'leftover.txt'), '未归档残留\n')

  const out = runMerge({ repo, taskId: rec.task_id, branch: 'dev-loc-001-r1', decision: 'accept' })
  assert.equal(out.ok, true, JSON.stringify(out.failures))
  assert.equal(out.merged, true)
  assert.equal(out.workspace.removed, false)
  // git 原话给出「需要 --force 才能删」——正是 R-4 禁止使用的路径
  assert.match(out.workspace.error, /--force/)
  assert.ok(fs.existsSync(wt), '工作区不得被强制删除')
  assert.match(out.cleanup_hint, /未删除/)
  // 分支仍保留
  assert.ok(g(['branch', '--list', 'dev-loc-001-r1'], repo))
})

test('--keep-worktree：显式跳过工作区删除（非常规路径）', () => {
  const repo = tmpRepo()
  const rec = seedTask(repo)
  const wt = makeBranch(repo, 'dev-loc-001-r1', 'a.txt', 'branch\n')
  const out = runMerge({ repo, taskId: rec.task_id, branch: 'dev-loc-001-r1', decision: 'accept', keepWorktree: true })
  assert.equal(out.merged, true)
  assert.equal(out.workspace.removed, false)
  assert.ok(fs.existsSync(wt))
})

test('端到端：冲突时中止，主干不受影响', () => {
  const repo = tmpRepo()
  const rec = seedTask(repo)
  fs.writeFileSync(path.join(repo, 'conflict.txt'), 'base\n')
  g(['add', '-A'], repo)
  g(['commit', '-m', 'chore: base file'], repo)

  const wt = makeBranch(repo, 'dev-loc-001-r1', 'conflict.txt', 'from branch\n')
  // 主干随后改动同一处
  fs.writeFileSync(path.join(repo, 'conflict.txt'), 'from main\n')
  g(['add', '-A'], repo)
  g(['commit', '-m', 'chore: main change'], repo)

  const before = g(['rev-parse', 'main'], repo)
  const out = runMerge({ repo, taskId: rec.task_id, branch: 'dev-loc-001-r1', decision: 'accept' })
  assert.equal(out.ok, false)
  assert.match(out.failures.join('\n'), /冲突/)
  assert.equal(g(['rev-parse', 'main'], repo), before)
  assert.equal(loadRegistry(repo).tasks[0].status, '等待验收')
  assert.ok(fs.existsSync(wt))
})

test('端到端：父工作区删除后残留的失效子登记被 prune 兜底注销', () => {
  const repo = tmpRepo()
  const rec = seedTask(repo)
  const wt = makeBranch(repo, 'dev-loc-001-r1', 'a.txt', 'branch\n')

  // 复现「删父工作区不会级联注销其内部嵌套子登记」缺口（约定 §1.7.4，历史三次复现）：
  // 在父工作区内再嵌一个子工作区，随后把它的目录移走——只留下一条指向空路径的失效登记。
  const nested = path.join(wt, 'nested-ghost')
  g(['worktree', 'add', nested, '-b', 'dev-nested-ghost'], wt)
  const moved = path.join(os.tmpdir(), `nested-ghost-${Date.now()}`)
  fs.renameSync(nested, moved)
  fs.rmSync(moved, { recursive: true, force: true })
  assert.ok(
    g(['worktree', 'list', '--porcelain'], repo).includes(nested),
    `前置条件不成立：失效登记应仍留在清单里（${nested}）`,
  )

  const out = runMerge({ repo, taskId: rec.task_id, branch: 'dev-loc-001-r1', decision: 'accept' })
  assert.equal(out.ok, true, JSON.stringify(out.failures))
  assert.equal(out.pruned, true)
  assert.equal(
    g(['worktree', 'list', '--porcelain'], repo).includes(nested),
    false,
    `失效子登记未被注销：${nested}`,
  )
})

test('dry-run：只出计划不动仓库', () => {
  const repo = tmpRepo()
  const rec = seedTask(repo)
  makeBranch(repo, 'dev-loc-001-r1', 'a.txt', 'branch\n')
  const before = g(['rev-parse', 'main'], repo)
  const out = runMerge({ repo, taskId: rec.task_id, branch: 'dev-loc-001-r1', decision: 'accept', dryRun: true })
  assert.equal(out.ok, true)
  assert.equal(out.merged, false)
  assert.equal(out.dryRun, true)
  assert.match(out.message, /任务标识: LOC-001/)
  assert.equal(g(['rev-parse', 'main'], repo), before)
})

// ── CHORE-106 / DT-01（裁定 A）：本地脚本路线不自动关闭远端 issue，
//    但必须把缺口显式列出，否则「代码已合入、issue 一直开着」会静默累积 ──────
test('本地收口不自动关闭远端 issue，但显式列出待人工关闭（CHORE-106）', () => {
  const repo = tmpRepo()
  const rec = seedTask(repo)
  update(repo, rec.task_id, { remote: 'cnb#999' })
  g(['add', '-A'], repo)
  g(['commit', '-m', 'chore: set remote'], repo)
  makeBranch(repo, 'dev-loc-001-r1', 'close.txt', 'branch\n')
  const out = runMerge({ repo, taskId: rec.task_id, branch: 'dev-loc-001-r1', decision: 'accept' })
  assert.equal(out.merged, true)
  assert.equal(out.pending_manual_close.length, 1, '本地路线须列出待人工关闭')
  assert.equal(out.pending_manual_close[0].system, 'cnb')
  assert.equal(out.pending_manual_close[0].remote_issue, 999)
  assert.match(out.pending_manual_close[0].reason, /DT-01/)
  assert.match(out.cleanup_hint, /待人工关闭/)
  assert.match(out.cleanup_hint, /cnb#999/)
  fs.rmSync(repo, { recursive: true, force: true })
})

// ── CHORE-111：remote 锚点解析平台无关，关闭命令按平台给 ─────────────────────
test('parseRemoteAnchors：单值 / 双锚点 / 空格式都解析，无锚点取值返回空', () => {
  assert.deepEqual(parseRemoteAnchors('cnb#106'), [{ system: 'cnb', issue: 106 }])
  assert.deepEqual(parseRemoteAnchors('github#215'), [{ system: 'github', issue: 215 }])
  assert.deepEqual(parseRemoteAnchors('cnb#111 + github#215'), [
    { system: 'cnb', issue: 111 },
    { system: 'github', issue: 215 },
  ], '双锚点逐个列出，另一侧不会静默常开')
  assert.deepEqual(parseRemoteAnchors('GitHub #208'), [{ system: 'github', issue: 208 }])
  assert.deepEqual(parseRemoteAnchors('cnb#9 + cnb#9'), [{ system: 'cnb', issue: 9 }], '重复锚点去重')
  for (const empty of ['pending', 'none', '', null, undefined]) {
    assert.deepEqual(parseRemoteAnchors(empty), [], `${empty} 不是锚点`)
  }
})

test('closeTaskHint：按平台给该平台真实可执行命令，取不到仓库时退回人工描述', () => {
  assert.equal(closeTaskHint('github', 'o/r', 42), 'gh issue close 42 --repo o/r')
  assert.equal(
    closeTaskHint('cnb', 'chris.ai/r', 42),
    'cnb issues update-issue --repo chris.ai/r --number 42 --state closed --state-reason completed',
  )
  assert.equal(closeTaskHint('github', null, 42), '人工关闭 github issue #42')
})

test('remoteRepoSlug：主源远端叫 origin 也能取到 owner/repo（平台名≠远端名）', () => {
  const repo = tmpRepo()
  g(['remote', 'add', 'origin', 'https://github.com/o/r.git'], repo)
  assert.equal(remoteRepoSlug(repo, 'github'), 'o/r', '按 `git remote get-url github` 直查会取不到')
  assert.equal(remoteRepoSlug(repo, 'cnb'), null, '没有该远端就不编造')
  g(['remote', 'set-url', 'origin', 'https://cnb.cool/other/r.git'], repo)
  g(['remote', 'add', 'github', 'https://github.com/o/r.git'], repo)
  assert.equal(remoteRepoSlug(repo, 'github'), 'o/r', 'origin 指向别的平台时改用名为 github 的远端')
  fs.rmSync(repo, { recursive: true, force: true })
})

test('双锚点任务收口时两侧 issue 都列待关闭，命令各按平台给（验收 7）', () => {
  const repo = tmpRepo()
  const rec = seedTask(repo)
  g(['remote', 'add', 'origin', 'https://github.com/crystepj-max/workflow-manager.git'], repo)
  g(['remote', 'add', 'cnb', 'https://cnb.cool/chris.ai/workflow-manager.git'], repo)
  update(repo, rec.task_id, { remote: 'cnb#111 + github#215' })
  g(['add', '-A'], repo)
  g(['commit', '-m', 'chore: set dual anchors'], repo)
  makeBranch(repo, 'dev-loc-001-r1', 'dual.txt', 'branch\n')
  const out = runMerge({ repo, taskId: rec.task_id, branch: 'dev-loc-001-r1', decision: 'accept' })
  assert.deepEqual(
    out.pending_manual_close.map((p) => `${p.system}#${p.remote_issue}`),
    ['cnb#111', 'github#215'],
  )
  assert.equal(out.pending_manual_close[1].hint, 'gh issue close 215 --repo crystepj-max/workflow-manager')
  assert.match(out.pending_manual_close[0].hint, /^cnb issues update-issue --repo chris\.ai\/workflow-manager/)
  assert.match(out.cleanup_hint, /cnb#111/)
  assert.match(out.cleanup_hint, /github#215/)
  fs.rmSync(repo, { recursive: true, force: true })
})

test('任务无远端锚点时不产生待人工关闭条目（CHORE-106）', () => {
  const repo = tmpRepo()
  const rec = seedTask(repo)
  makeBranch(repo, 'dev-loc-001-r1', 'none.txt', 'branch\n')
  const out = runMerge({ repo, taskId: rec.task_id, branch: 'dev-loc-001-r1', decision: 'accept' })
  assert.equal(out.merged, true)
  assert.equal(out.pending_manual_close.length, 0)
  assert.ok(!/待人工关闭/.test(out.cleanup_hint))
  fs.rmSync(repo, { recursive: true, force: true })
})
