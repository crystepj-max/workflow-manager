import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const cli = path.join(root, 'scripts/local-task-registry.mjs')

/**
 * Bugbot #240 审查第 1 条回归：`mark-ready` 曾在 CLI 层因 `taskId` 未定义
 * 直接抛 ReferenceError（库函数单测覆盖不到 CLI 参数解析）。
 * 本文件只走**真实 CLI 子进程**，确保子命令能跑到业务分支。
 */
function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-mark-ready-'))
  execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main'])
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://github.com/o/r.git'])
  fs.mkdirSync(path.join(dir, 'docs/tasks'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'docs/tasks/registry.json'),
    JSON.stringify({
      version: 1,
      revision: 1,
      tasks: [{ task_id: 'LOC-020', name: '无锚点任务', remote: 'none', slug: 'x', status: '本地已定义' }],
    }, null, 2) + '\n',
  )
  return dir
}

function runCli(args, cwd) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', env: { ...process.env } })
}

test('mark-ready CLI：缺 --task 时给用法并退出 2（不是崩溃）', () => {
  const r = runCli(['mark-ready'], tmpRepo())
  assert.equal(r.status, 2, `stderr=${r.stderr}`)
  assert.match(r.stderr, /mark-ready --task/)
  assert.doesNotMatch(r.stderr, /ReferenceError/)
})

test('mark-ready CLI：能跑到业务分支并返回 no-anchor（曾在此处抛 ReferenceError）', () => {
  const r = runCli(['mark-ready', '--task', 'LOC-020'], tmpRepo())
  assert.doesNotMatch(r.stderr, /ReferenceError/, 'CLI 参数解析不得崩溃')
  assert.equal(r.status, 1)
  const out = JSON.parse(r.stdout)
  assert.equal(out.code, 'no-anchor')
  assert.equal(out.ok, false)
  assert.match(out.reason, /先换取正式号/)
})

test('mark-ready CLI：登记册无此任务 → no-task', () => {
  const r = runCli(['mark-ready', '--task', 'FIX-999'], tmpRepo())
  assert.doesNotMatch(r.stderr, /ReferenceError/)
  assert.equal(JSON.parse(r.stdout).code, 'no-task')
})

test('set CLI：--task 仍按原语义工作（函数作用域提升后无回归）', () => {
  const repo = tmpRepo()
  const r = runCli(['set', '--task', 'LOC-020', '--status', '定义中', '--branch', 'dev-loc-020-r1'], repo)
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  assert.equal(JSON.parse(r.stdout).task_id, 'LOC-020')
  const after = JSON.parse(fs.readFileSync(path.join(repo, 'docs/tasks/registry.json'), 'utf8'))
  assert.equal(after.tasks[0].status, '定义中')
  assert.equal(after.tasks[0].branch, 'dev-loc-020-r1')
})

test('set CLI：缺 --task 时给用法并退出 2', () => {
  const r = runCli(['set', '--status', '定义中'], tmpRepo())
  assert.equal(r.status, 2)
  assert.match(r.stderr, /set --task/)
})
