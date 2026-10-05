import assert from 'node:assert/strict'
import test from 'node:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { guessType, pendingTasks } from '../remote-issue-sync.mjs'

// WFM-158：apply / reissue 旧双账本写入口必须在任何远端建号与 registry/BOARD 回写前被拒绝。
const REASON_CODE = 'legacy_remote_issue_sync_disabled'
const SCRIPT = path.join(import.meta.dirname, '..', 'remote-issue-sync.mjs')

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

// 隔离临时仓 + 账本 fixture：不触碰真实账号、真实 registry 或共享 BOARD
function fixtureRepo(t) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-issue-sync-retire-'))
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  fs.mkdirSync(path.join(repo, 'docs', 'tasks'), { recursive: true })
  const registry = {
    version: 1,
    revision: 0,
    tasks: [
      {
        task_id: 'TMP-abcd1234-260916a',
        name: '临时号换正式号验证',
        status: '本地已定义',
        type: 'CHORE',
        remote: 'pending',
      },
      {
        task_id: 'LOC-901',
        name: '待建 issue 任务',
        status: '本地已定义',
        type: 'FEAT',
        remote: null,
      },
    ],
  }
  fs.writeFileSync(
    path.join(repo, 'docs', 'tasks', 'registry.json'),
    JSON.stringify(registry, null, 2) + '\n',
  )
  fs.writeFileSync(path.join(repo, 'docs', 'tasks', 'BOARD.md'), '# 任务看板（fixture）\n')
  execFileSync('git', ['init', '-q', repo])
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/fake-owner/fake-repo.git'])
  return repo
}

// fake gh：只记录调用次数并返回假 issue URL，不触网
function fakeGh(t) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-gh-bin-'))
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }))
  const logPath = path.join(bin, 'gh-calls.log')
  const gh = path.join(bin, 'gh')
  fs.writeFileSync(
    gh,
    `#!/bin/sh\nprintf 'gh %s\\n' "$*" >> '${logPath}'\necho 'https://github.com/fake-owner/fake-repo/issues/901'\n`,
  )
  fs.chmodSync(gh, 0o755)
  const calls = () => (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).length : 0)
  return { calls, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } }
}

function runCli(args, env) {
  try {
    const stdout = execFileSync('node', [SCRIPT, ...args], {
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { status: 0, stdout, stderr: '' }
  } catch (err) {
    return { status: err.status, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') }
  }
}

function ledgerHashes(repo) {
  return [
    sha256(path.join(repo, 'docs', 'tasks', 'registry.json')),
    sha256(path.join(repo, 'docs', 'tasks', 'BOARD.md')),
  ]
}

for (const command of [['apply'], ['reissue', '--task', 'TMP-abcd1234-260916a']]) {
  test(`${command[0]} 已退役：非零退出 + 稳定 reasonCode + 零远端写 + 账本字节不变`, (t) => {
    const repo = fixtureRepo(t)
    const fake = fakeGh(t)
    const before = ledgerHashes(repo)

    const r = runCli([...command, '--repo', repo], fake.env)

    assert.notEqual(r.status, 0, `${command[0]} 应非零退出，实际 stdout=${r.stdout} stderr=${r.stderr}`)
    assert.match(`${r.stdout}\n${r.stderr}`, new RegExp(REASON_CODE))
    assert.equal(fake.calls(), 0, `${command[0]} 不得调用 gh 建 issue`)
    assert.deepEqual(ledgerHashes(repo), before, `${command[0]} 不得回写 registry / BOARD`)
  })
}

test('plan 保持只读可运行', (t) => {
  const repo = fixtureRepo(t)
  const fake = fakeGh(t)
  const before = ledgerHashes(repo)

  const r = runCli(['plan', '--repo', repo], fake.env)

  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.remote, 'fake-owner/fake-repo')
  assert.equal(out.count, 2)
  assert.equal(fake.calls(), 0)
  assert.deepEqual(ledgerHashes(repo), before)
})

test('纯函数导出保持兼容：guessType / pendingTasks', () => {
  assert.equal(guessType({ name: '清理缓存残留' }), 'CHORE')
  assert.equal(guessType({ name: '新增交付看板' }), 'FEAT')

  const registry = {
    tasks: [
      { task_id: 'LOC-001', status: '本地已定义', remote: null },
      { task_id: 'LOC-002', status: '已合并', remote: null },
      { task_id: 'LOC-003', status: '本地已定义', remote: 'github#8' },
      { task_id: 'TMP-a-260916a', status: '定义中', remote: 'pending' },
    ],
  }
  assert.deepEqual(pendingTasks(registry).map((x) => x.task_id), ['LOC-001', 'TMP-a-260916a'])
  assert.deepEqual(pendingTasks(registry, ['LOC-001']).map((x) => x.task_id), ['LOC-001'])
})
