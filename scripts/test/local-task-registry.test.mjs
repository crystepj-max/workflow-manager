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

const disabled = (error) => error.code === 'legacy_registry_write_disabled'
const history = { legacyHistoryAudit: true }

function writeHistoricalFixture(repo, tasks = []) {
  fs.mkdirSync(path.join(repo, 'docs/tasks'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'docs/tasks/registry.json'), JSON.stringify({ version: 1, revision: 2, tasks }) + '\n')
  fs.writeFileSync(path.join(repo, 'docs/tasks/BOARD.md'), '# 历史存档，不应重写\n')
}

test('登记册写 API 已退役，当前 Task 读取也必须拒绝', () => {
  const repo = tmpRepo()
  writeHistoricalFixture(repo, [newRecord({ taskId: 'LOC-001', name: '历史任务' })])
  const before = fs.readFileSync(path.join(repo, 'docs/tasks/registry.json'), 'utf8')
  assert.throws(() => allocate(repo, { name: '任务甲' }), disabled)
  assert.throws(() => update(repo, 'LOC-001', { status: '本地已定义' }), disabled)
  assert.throws(() => update(repo, 'LOC-999', { status: '已合并' }), disabled)
  assert.throws(() => loadRegistry(repo), (error) => error.code === 'legacy_registry_read_disabled')
  assert.equal(fs.readFileSync(path.join(repo, 'docs/tasks/registry.json'), 'utf8'), before)
})

test('历史查询路径固定为 docs/tasks/registry.json，仅读取原有快照', () => {
  const repo = tmpRepo()
  writeHistoricalFixture(repo, [newRecord({ taskId: 'LOC-001', name: '任务甲' })])
  assert.equal(loadRegistry(repo, history).tasks[0].task_id, 'LOC-001')
  assert.deepEqual(loadRegistry(tmpRepo(), history).tasks, [])
})

test('writeBoard 已退役，已有历史看板逐字节不变', () => {
  const repo = tmpRepo()
  writeHistoricalFixture(repo)
  const p = path.join(repo, 'docs/tasks/BOARD.md')
  const before = fs.readFileSync(p, 'utf8')
  assert.throws(() => writeBoard(repo, history), disabled)
  assert.equal(fs.readFileSync(p, 'utf8'), before)
})

test('saveRegistry 已退役，不创建 docs/tasks 或其他文件', () => {
  const repo = tmpRepo()
  assert.throws(() => saveRegistry(repo, { version: 1, tasks: [] }, history), disabled)
  assert.deepEqual(fs.readdirSync(repo), [])
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

test('GitHub 发号导出已退役：有主源远端也零 gh 调用、零本地写入', () => {
  const repo = gitRepoWith({ origin: 'https://github.com/o/r.git' })
  const calls = []
  setGhRunner((args) => { calls.push(args); return 'https://github.com/o/r/issues/216\n' })
  try {
    assert.throws(() => remoteAllocate({ repo, name: '发号探针' }), disabled)
    assert.throws(() => allocate(repo, { name: '发号探针', type: 'CHORE' }), disabled)
    assert.deepEqual(calls, [])
    assert.equal(fs.existsSync(path.join(repo, 'docs/tasks')), false)
  } finally {
    setGhRunner(null)
  }
})

test('gh 不可达也禁止 TMP 降级或创建第二套任务状态', () => {
  const repo = gitRepoWith({ origin: 'https://github.com/o/r.git', cnb: 'https://cnb.cool/o/r.git' })
  let calls = 0
  setGhRunner(() => { calls++; throw new Error('gh: not logged in') })
  try {
    assert.throws(() => allocate(repo, { name: '降级探针', type: 'FIX' }), disabled)
    assert.equal(calls, 0)
    assert.equal(fs.existsSync(path.join(repo, 'docs/tasks')), false)
  } finally {
    setGhRunner(null)
  }
})

test('退役发号不会触碰历史任务的 task_id、remote 或新增条目', () => {
  const repo = gitRepoWith({ origin: 'https://github.com/o/r.git' })
  const historical = [
    newRecord({ name: '历史甲', taskId: 'CHORE-110', type: 'CHORE', remote: 'cnb#110 + github#110', slug: 'a' }),
    newRecord({ name: '历史乙', taskId: 'FEAT-208', type: 'FEAT', remote: 'GitHub #208', slug: 'b' }),
  ]
  writeHistoricalFixture(repo, historical)
  const file = path.join(repo, 'docs/tasks/registry.json')
  const before = fs.readFileSync(file, 'utf8')
  assert.throws(() => allocate(repo, { name: '新任务', type: 'CHORE', legacyHistoryAudit: true }), disabled)
  assert.equal(fs.readFileSync(file, 'utf8'), before)
  assert.deepEqual(loadRegistry(repo, history).tasks, historical)
})

test('remoteAllocate：没有 GitHub 远端也明确退役，禁止本地号或 CNB 发号', () => {
  const repo = gitRepoWith({ cnb: 'https://cnb.cool/o/r.git' })
  assert.throws(() => remoteAllocate({ type: 'CHORE', name: 'x', repo }), disabled)
})
