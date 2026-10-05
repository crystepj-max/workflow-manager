import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import test from 'node:test'
import assert from 'node:assert/strict'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const cli = path.join(root, 'scripts/local-task-registry.mjs')

const RETIRED_WRITE_COMMANDS = ['allocate', 'set', 'mark-ready', 'board']

/**
 * W8 P0-C（WFM-157）：旧写命令 fail-closed 回归。
 * 本文件前身覆盖 Bugbot #240 的 mark-ready CLI 参数解析回归；该写命令随 W8 退役后，
 * 仍以**真实 CLI 子进程**作验收口径：四个写命令在任何本地文件写入或 GitHub 调用之前
 * 被拒绝（非零退出 + 稳定原因码 legacy_registry_write_disabled），list/show 只读可用。
 */
function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-retired-'))
  execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main'])
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://github.com/o/r.git'])
  fs.mkdirSync(path.join(dir, 'docs/tasks'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'docs/tasks/registry.json'),
    JSON.stringify(
      {
        version: 1,
        revision: 1,
        tasks: [
          { task_id: 'LOC-020', name: '只读样例', remote: 'github#20', slug: 'x', status: '本地已定义', github_sync: 'synced' },
          { task_id: 'LOC-021', name: '只读待同步', remote: 'github#21', slug: 'y', status: '定义中', github_sync: 'pending' },
        ],
      },
      null,
      2,
    ) + '\n',
  )
  fs.writeFileSync(path.join(dir, 'docs/tasks/BOARD.md'), '# 本地任务看板\n\n> 预置存档内容，期望逐字节不变。\n')
  return dir
}

/** fake gh：任何调用都把参数追加到日志文件；不触网。守卫生效时该日志不应出现。 */
function withFakeGh(logFile) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-gh-'))
  const script = path.join(dir, 'gh')
  fs.writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${logFile}'\nexit 0\n`, { mode: 0o755 })
  return { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` }
}

function sha256(p) {
  return createHash('sha256').update(fs.readFileSync(p)).digest('hex')
}

function runCli(args, cwd, env = { ...process.env }) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', env })
}

test('写命令退役：allocate/set/mark-ready/board 一律非零退出且零写入、零 gh 调用', () => {
  const argsFor = {
    allocate: ['allocate', '--name', '不应创建的任务'],
    set: ['set', '--task', 'LOC-020', '--status', '定义中'],
    'mark-ready': ['mark-ready', '--task', 'LOC-020'],
    board: ['board'],
  }
  for (const cmd of RETIRED_WRITE_COMMANDS) {
    const repo = tmpRepo()
    const registry = path.join(repo, 'docs/tasks/registry.json')
    const board = path.join(repo, 'docs/tasks/BOARD.md')
    const before = { registry: sha256(registry), board: sha256(board) }
    const ghLog = path.join(repo, 'gh-calls.log')
    const r = runCli([...argsFor[cmd], '--repo', repo], repo, withFakeGh(ghLog))
    assert.equal(r.status, 2, `${cmd} 应以非零退出（实际 ${r.status}）：stderr=${r.stderr}`)
    assert.equal(r.stdout, '', `${cmd} 不得向 stdout 输出任何内容`)
    assert.match(r.stderr, /legacy_registry_write_disabled/, `${cmd} 须给出稳定退役原因码`)
    assert.equal(sha256(registry), before.registry, `${cmd} 不得改写 registry.json`)
    assert.equal(sha256(board), before.board, `${cmd} 不得改写 BOARD.md`)
    assert.ok(!fs.existsSync(ghLog), `${cmd} 不得调用 gh（含 mark-ready 的打标签路径）`)
  }
})

test('list 仍只读可用：返回原有登记数据且不动任何文件', () => {
  const repo = tmpRepo()
  const registry = path.join(repo, 'docs/tasks/registry.json')
  const board = path.join(repo, 'docs/tasks/BOARD.md')
  const before = { registry: sha256(registry), board: sha256(board) }
  const ghLog = path.join(repo, 'gh-calls.log')
  const r = runCli(['list', '--repo', repo], repo, withFakeGh(ghLog))
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  const out = JSON.parse(r.stdout)
  assert.equal(out.count, 2)
  assert.deepEqual(
    out.tasks.map((t) => t.task_id),
    ['LOC-020', 'LOC-021'],
  )
  assert.equal(sha256(registry), before.registry, 'list 不得改写 registry.json')
  assert.equal(sha256(board), before.board, 'list 不得改写 BOARD.md')
  assert.ok(!fs.existsSync(ghLog), 'list 不得调用 gh')
})

test('list --github-sync 过滤语义保持不变', () => {
  const repo = tmpRepo()
  const r = runCli(['list', '--github-sync', 'pending', '--repo', repo], repo)
  assert.equal(r.status, 0)
  const out = JSON.parse(r.stdout)
  assert.equal(out.count, 1)
  assert.equal(out.tasks[0].task_id, 'LOC-021')
})

test('show 仍只读可用；任务不存在时保持原退出语义', () => {
  const repo = tmpRepo()
  const ok = runCli(['show', '--task', 'LOC-020', '--repo', repo], repo)
  assert.equal(ok.status, 0, `stderr=${ok.stderr}`)
  assert.equal(JSON.parse(ok.stdout).task_id, 'LOC-020')

  const missing = runCli(['show', '--task', 'FIX-999', '--repo', repo], repo)
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /任务不存在/)
})
