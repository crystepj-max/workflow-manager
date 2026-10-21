import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildCommitMessage, checkMerge, runMerge, parseRemoteAnchors, remoteRepoSlug, closeTaskHint } from '../local-task-merge.mjs'

const SCRIPT = path.resolve(import.meta.dirname, '../local-task-merge.mjs')
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'local-track-test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'local-track-test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
}

function fixtureRepo(t) {
  const repo = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'legacy-merge-retired-'))
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env: GIT_ENV })
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'local-track-test'], { env: GIT_ENV })
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com'], { env: GIT_ENV })
  fs.mkdirSync(path.join(repo, 'docs/tasks'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'docs/tasks/registry.json'), '{"version":1,"revision":0,"tasks":[]}\n')
  fs.writeFileSync(path.join(repo, 'docs/tasks/BOARD.md'), '# Historical board\n')
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n')
  execFileSync('git', ['-C', repo, 'add', '-A'], { env: GIT_ENV })
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'fixture'], { env: GIT_ENV })
  return repo
}

test('buildCommitMessage 保留历史归档格式', () => {
  const message = buildCommitMessage({
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
  assert.match(message.split('\n')[0], /^feat\(auth\): 修好登录 \(LOC-001 V1\)$/)
  assert.ok(message.includes('验收结果: 通过'))
  assert.ok(message.includes('docs/tasks/archive/LOC-001/task-spec-V1.md'))
})

test('旧本地任务合并 API 不读取登记册、不改 Git 历史', (t) => {
  const repo = fixtureRepo(t)
  const beforeHead = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const beforeLedger = fs.readFileSync(path.join(repo, 'docs/tasks/registry.json'), 'utf8')

  for (const call of [
    () => checkMerge({ repo, taskId: 'LOC-001', branch: 'dev-loc-001-r1', decision: 'accept' }),
    () => runMerge({ repo, taskId: 'LOC-001', branch: 'dev-loc-001-r1', decision: 'accept' }),
  ]) {
    assert.throws(call, (error) => error.code === 'legacy_local_task_merge_disabled')
  }

  const afterHead = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  assert.equal(afterHead, beforeHead)
  assert.equal(fs.readFileSync(path.join(repo, 'docs/tasks/registry.json'), 'utf8'), beforeLedger)
})

test('旧本地任务合并 CLI 明确退役', (t) => {
  const repo = fixtureRepo(t)
  const result = spawnSync(process.execPath, [
    SCRIPT,
    '--task', 'LOC-001',
    '--branch', 'dev-loc-001-r1',
    '--decision', 'accept',
    '--repo', repo,
  ], { encoding: 'utf8', cwd: repo })
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`)
  const out = JSON.parse(result.stderr)
  assert.equal(out.code, 'legacy_local_task_merge_disabled')
  assert.match(out.effects, /未合并 Git 分支/)
})

test('历史 remote 锚点解析与关闭提示保持可读', () => {
  assert.deepEqual(parseRemoteAnchors('cnb#111 + github#215'), [
    { system: 'cnb', issue: 111 },
    { system: 'github', issue: 215 },
  ])
  assert.deepEqual(parseRemoteAnchors('pending'), [])
  assert.equal(closeTaskHint('github', 'o/r', 42), 'gh issue close 42 --repo o/r')
  assert.equal(closeTaskHint('github', null, 42), '人工关闭 github issue #42')
})

test('remoteRepoSlug 可按 GitHub/CNB 平台解析远端名', (t) => {
  const repo = fixtureRepo(t)
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/o/r.git'])
  assert.equal(remoteRepoSlug(repo, 'github'), 'o/r')
  assert.equal(remoteRepoSlug(repo, 'cnb'), null)
})
