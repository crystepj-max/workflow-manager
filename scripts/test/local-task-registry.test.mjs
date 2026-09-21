import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  nextSeq,
  formatId,
  slugify,
  newRecord,
  applyUpdate,
  renderBoard,
  loadRegistry,
  saveRegistry,
  allocate,
  update,
  writeBoard,
  remoteAllocate,
  resolveGitHubRemote,
  githubSlugOf,
  setGhRunner,
} from '../local-task-registry.mjs'

function tmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loc-registry-'))
}

test('nextSeq / formatId：序号递增且三位补零', () => {
  assert.equal(nextSeq([]), 1)
  assert.equal(nextSeq([{ task_id: 'LOC-001' }]), 2)
  assert.equal(nextSeq([{ task_id: 'LOC-001' }, { task_id: 'LOC-009' }]), 10)
  assert.equal(formatId(7), 'LOC-007')
  assert.equal(formatId(123), 'LOC-123')
  // 非法标识不参与取最大值
  assert.equal(nextSeq([{ task_id: '#123' }, { task_id: 'LOC-002' }]), 3)
})

test('slugify：中文与空格转连字符', () => {
  assert.equal(slugify('修好登录按钮'), 'task')
  assert.equal(slugify('Fix Login Button'), 'fix-login-button')
  assert.equal(slugify(''), 'task')
})

test('newRecord：默认本地轨道字段', () => {
  const r = newRecord({ seq: 1, name: 'Fix Login', source: '本地文档', sourceRef: 'docs/req/login.md' })
  assert.equal(r.task_id, 'LOC-001')
  assert.equal(r.status, '定义中')
  assert.equal(r.github_sync, 'pending')
  assert.equal(r.source, '本地文档')
  assert.throws(() => newRecord({ seq: 1, name: '' }), /任务名称必填/)
})

test('applyUpdate：只允许白名单字段，自动更新时间', () => {
  const r = newRecord({ seq: 1, name: 'x', now: '2026-01-01T00:00:00Z' })
  const next = applyUpdate(r, { status: '本地已定义', branch: 'dev-loc-001-r1', 不存在字段: 'zzz' })
  assert.equal(next.status, '本地已定义')
  assert.equal(next.branch, 'dev-loc-001-r1')
  assert.equal(next.不存在字段, undefined)
  assert.notEqual(next.updated_at, '2026-01-01T00:00:00Z')
  // null 不覆盖已有值
  assert.equal(applyUpdate(next, { status: null }).status, '本地已定义')
})

test('applyUpdate：merge_commit 写入 merge 结构', () => {
  const r = newRecord({ seq: 1, name: 'x' })
  const next = applyUpdate(r, { merge_commit: 'abc123' })
  assert.equal(next.merge.commit, 'abc123')
  assert.ok(next.merge.merged_at)
})

test('renderBoard：按状态分组，未知状态归入其他', () => {
  const tasks = [
    newRecord({ seq: 1, name: 'A' }),
    { ...newRecord({ seq: 2, name: 'B' }), status: '本地已定义' },
    { ...newRecord({ seq: 3, name: 'C' }), status: '莫名其妙状态' },
  ]
  const md = renderBoard(tasks)
  assert.match(md, /## 定义中（1）/)
  assert.match(md, /## 本地已定义（1）/)
  assert.match(md, /## 其他（1）/)
  assert.match(md, /LOC-001/)
  assert.match(renderBoard([]), /暂无任务/)
})

test('登记册读写往返：分配两个任务并落盘', () => {
  const repo = tmpRepo()
  const a = allocate(repo, { name: '任务甲', source: '会话录入' })
  const b = allocate(repo, { name: '任务乙', source: '本地文档', sourceRef: 'docs/req/b.md' })
  assert.equal(a.task_id, 'LOC-001')
  assert.equal(b.task_id, 'LOC-002')

  const reg = loadRegistry(repo)
  assert.equal(reg.tasks.length, 2)

  const updated = update(repo, 'LOC-001', { status: '本地已定义', branch: 'dev-loc-001-r1' })
  assert.equal(updated.status, '本地已定义')
  assert.equal(loadRegistry(repo).tasks[0].branch, 'dev-loc-001-r1')

  assert.throws(() => update(repo, 'LOC-999', { status: '已合并' }), /任务不存在/)
})

test('登记册落盘路径固定为 docs/tasks/registry.json 且可入库', () => {
  const repo = tmpRepo()
  allocate(repo, { name: '任务甲' })
  const p = path.join(repo, 'docs', 'tasks', 'registry.json')
  assert.ok(fs.existsSync(p))
  // 能被 JSON 解析（不是带注释的文本）
  assert.equal(JSON.parse(fs.readFileSync(p, 'utf-8')).tasks[0].task_id, 'LOC-001')
})

test('writeBoard：生成看板文件', () => {
  const repo = tmpRepo()
  allocate(repo, { name: '任务甲' })
  allocate(repo, { name: '任务乙' })
  const p = writeBoard(repo)
  assert.equal(p, path.join(repo, 'docs', 'tasks', 'BOARD.md'))
  assert.match(fs.readFileSync(p, 'utf-8'), /LOC-002/)
})

test('saveRegistry：空目录自动创建 docs/tasks', () => {
  const repo = tmpRepo()
  const p = saveRegistry(repo, { version: 1, tasks: [] })
  assert.ok(fs.existsSync(p))
  assert.deepEqual(loadRegistry(repo).tasks, [])
})

// ── CHORE-111：发号源从 CNB 迁到 GitHub ─────────────────────────────────────

function gitRepoWith(remotes) {
  // 真实 `git remote -v` 形态：远端名不写死（主源可能叫 origin 也可能叫 github）
  const repo = tmpRepo()
  execFileSync('git', ['-C', repo, 'init', '-q'])
  for (const [name, url] of Object.entries(remotes)) {
    execFileSync('git', ['-C', repo, 'remote', 'add', name, url])
  }
  return repo
}

test('githubSlugOf：只认 GitHub 地址，与远端名无关', () => {
  assert.equal(githubSlugOf('https://github.com/o/r.git'), 'o/r')
  assert.equal(githubSlugOf('https://github.com/o/r'), 'o/r')
  assert.equal(githubSlugOf('git@github.com:o/r.git'), 'o/r')
  assert.equal(githubSlugOf('https://cnb.cool/o/r.git'), null, '灾备镜像不是主源')
  assert.equal(githubSlugOf('/Users/x/git-mirrors/r.git'), null, '本地镜像路径不是主源')
  assert.equal(githubSlugOf('https://notgithub.com/o/r.git'), null, '域名前后缀相似不得误判')
  assert.equal(githubSlugOf(''), null)
})

test('resolveGitHubRemote：主源按 URL 识别，优先 origin，CNB 不参与发号', () => {
  const repo = gitRepoWith({ cnb: 'https://cnb.cool/o/r.git', mirror: '/tmp/mirror/r.git', origin: 'https://github.com/o/r.git' })
  assert.deepEqual(resolveGitHubRemote(repo), { name: 'origin', slug: 'o/r' })
  const cnbOnly = gitRepoWith({ cnb: 'https://cnb.cool/o/r.git' })
  assert.equal(resolveGitHubRemote(cnbOnly), null, '只有灾备镜像时不发号，也不回落 CNB')
})

test('GitHub 发号成功：task_id=<TYPE>-<GitHub issue 号>、remote=github#<号>', () => {
  const repo = gitRepoWith({ origin: 'https://github.com/crystepj-max/workflow-manager.git' })
  const calls = []
  setGhRunner((args) => {
    calls.push(args)
    return 'https://github.com/crystepj-max/workflow-manager/issues/216\n'
  })
  try {
    const rec = allocate(repo, { name: '发号探针', type: 'CHORE', source: '会话录入' })
    assert.equal(rec.task_id, 'CHORE-216')
    assert.equal(rec.remote, 'github#216')
    assert.equal(calls.length, 1)
    const args = calls[0]
    assert.deepEqual(args.slice(0, 2), ['issue', 'create'])
    assert.ok(args.includes('--repo') && args.includes('crystepj-max/workflow-manager'))
    assert.ok(args.includes('--title') && args.includes('发号探针'), 'issue 标题与任务名一致')
    assert.ok(!args.some((a) => String(a).includes('cnb')), '不得再调用 CNB 通道')
  } finally {
    setGhRunner(null)
  }
})

test('gh 不可达时降级 TMP 并告警；全程不产出 cnb# 形式的号（验收 2）', () => {
  const repo = gitRepoWith({ origin: 'https://github.com/o/r.git', cnb: 'https://cnb.cool/o/r.git' })
  setGhRunner(() => { throw new Error('gh: To use GitHub in the CLI, run `gh auth login`') })
  const prevErr = console.error
  const warnings = []
  console.error = (msg) => { warnings.push(String(msg)) }
  try {
    const rec = allocate(repo, { name: '降级探针', type: 'FIX' })
    assert.match(rec.task_id, /^TMP-[a-z0-9]+-\d{6}[a-z]?$/i, '降级为临时号')
    assert.equal(rec.remote, 'pending')
    // 断言「恰好一条降级告警」：同一路径还可能出现正交的「未识别到 agent 身份」告警
    // （宿主无指纹时由 FIX-245 引入），故按降级告警本身计数，不再对告警总数设死值（CHORE-260 · M5）。
    const degradeWarnings = warnings.filter((w) => /已降级为临时号/.test(w))
    assert.equal(degradeWarnings.length, 1)
  } finally {
    console.error = prevErr
    setGhRunner(null)
  }
  const raw = fs.readFileSync(path.join(repo, 'docs', 'tasks', 'registry.json'), 'utf-8')
  assert.ok(!/cnb#\d/.test(raw), '登记册不得出现 cnb# 形式的号')
})

test('发号不触碰历史任务的 task_id 与 remote（验收 3）', () => {
  const repo = gitRepoWith({ origin: 'https://github.com/o/r.git' })
  const historical = [
    newRecord({ name: '历史甲', taskId: 'CHORE-110', type: 'CHORE', remote: 'cnb#110 + github#110', slug: 'a' }),
    newRecord({ name: '历史乙', taskId: 'FEAT-208', type: 'FEAT', remote: 'GitHub #208', slug: 'b' }),
  ]
  saveRegistry(repo, { version: 1, tasks: historical })
  const before = JSON.parse(JSON.stringify(loadRegistry(repo).tasks))
  setGhRunner(() => 'https://github.com/o/r/issues/301\n')
  try {
    allocate(repo, { name: '新任务', type: 'CHORE' })
  } finally {
    setGhRunner(null)
  }
  const after = loadRegistry(repo).tasks
  assert.deepEqual(after.slice(0, 2), before, '既有条目逐字段不变')
  assert.equal(after.length, 3)
  assert.equal(after[2].remote, 'github#301')
})

test('remoteAllocate：无 GitHub 远端时明确拒绝，不静默回落 CNB', () => {
  const repo = gitRepoWith({ cnb: 'https://cnb.cool/o/r.git' })
  assert.throws(() => remoteAllocate({ type: 'CHORE', name: 'x', repo }), /GitHub 主源远端/)
})
