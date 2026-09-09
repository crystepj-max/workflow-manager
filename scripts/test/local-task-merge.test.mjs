import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { allocate, update, loadRegistry } from '../local-task-registry.mjs'
import { buildCommitMessage, checkMerge, runMerge } from '../local-task-merge.mjs'

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
  const wt = path.join(repo, '.scratch', 'worktrees', branch)
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

  // 分支与工作区保留（供后续补 PR）
  assert.ok(g(['branch', '--list', 'dev-loc-001-r1'], repo))
  assert.ok(fs.existsSync(path.join(repo, '.scratch', 'worktrees', 'dev-loc-001-r1')))
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
