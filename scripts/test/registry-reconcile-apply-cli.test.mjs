import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { loadRegistry } from '../local-task-registry.mjs'
import { apply } from '../registry-reconcile.mjs'

/**
 * W8 P0-C3（WFM-162）：registry-reconcile 直接 CLI apply 写入口 fail-closed 回归。
 * 本文件只走真实 CLI 子进程：apply 必须在任何本地文件写入或 gh 调用之前被拒绝
 * （非零退出 + 稳定原因码 legacy_registry_write_disabled）；plan 保持只读可用；
 * 导出 apply（程序化写路径，scheduled-trigger 显式导入）行为不变，不在本切片退役。
 */

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'registry-reconcile.mjs')

const REASON_CODE = 'legacy_registry_write_disabled'

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-retired-'))
  execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main'])
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com'])
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'test'])
  // 合并事实：提交尾 (LOC-024 V1) → 旧 apply 会把 LOC-024 回写为已合并（正是要封闭的写路径）
  fs.writeFileSync(path.join(dir, 'f.txt'), 'x')
  execFileSync('git', ['-C', dir, 'add', '-A'])
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'feat: 已合并任务 (LOC-024 V1)'])
  fs.mkdirSync(path.join(dir, 'docs', 'tasks'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'docs', 'tasks', 'registry.json'),
    JSON.stringify({ version: 1, revision: 1, tasks: [{ task_id: 'LOC-024', status: '交付中' }] }, null, 2) + '\n',
  )
  fs.writeFileSync(path.join(dir, 'docs', 'tasks', 'BOARD.md'), '# 本地任务看板\n\n> 预置存档内容，期望逐字节不变。\n')
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

test('apply CLI 已退役：在任何文件写入或 gh 调用前非零退出并给稳定原因码', () => {
  const repo = tmpRepo()
  const registry = path.join(repo, 'docs', 'tasks', 'registry.json')
  const board = path.join(repo, 'docs', 'tasks', 'BOARD.md')
  const before = { registry: sha256(registry), board: sha256(board) }
  const ghLog = path.join(repo, 'gh-calls.log')
  const r = runCli(['apply', '--repo', repo], repo, withFakeGh(ghLog))
  assert.equal(r.status, 2, `apply 应以退出码 2 拒绝（实际 ${r.status}）：stderr=${r.stderr}`)
  assert.equal(r.stdout, '', 'apply 不得向 stdout 输出任何内容')
  assert.match(r.stderr, new RegExp(REASON_CODE), 'apply 须给出稳定退役原因码')
  assert.equal(sha256(registry), before.registry, 'apply 不得改写 registry.json')
  assert.equal(sha256(board), before.board, 'apply 不得改写 BOARD.md')
  assert.ok(!fs.existsSync(ghLog), 'apply 不得调用 gh')
})

test('plan 仍只读可用：报告合并落后差异，不改任何文件、不调用 gh', () => {
  const repo = tmpRepo()
  const registry = path.join(repo, 'docs', 'tasks', 'registry.json')
  const board = path.join(repo, 'docs', 'tasks', 'BOARD.md')
  const before = { registry: sha256(registry), board: sha256(board) }
  const ghLog = path.join(repo, 'gh-calls.log')
  const r = runCli(['plan', '--repo', repo], repo, withFakeGh(ghLog))
  assert.equal(r.status, 0, `plan 应正常退出（实际 ${r.status}）：stderr=${r.stderr}`)
  const out = JSON.parse(r.stdout)
  assert.equal(out.total, 1)
  assert.deepEqual(out.toMerge.map((t) => t.task_id), ['LOC-024'], 'plan 仍报告登记落后于 git 事实的差异')
  assert.equal(sha256(registry), before.registry, 'plan 不得改写 registry.json')
  assert.equal(sha256(board), before.board, 'plan 不得改写 BOARD.md')
  assert.ok(!fs.existsSync(ghLog), 'plan 不得调用 gh')
})

test('导出 apply 行为不变：程序化写路径仍存在（scheduled-trigger 依赖，非本切片退役）', () => {
  const repo = tmpRepo()
  const changed = apply(repo, 'main')
  assert.equal(changed.length, 1)
  assert.match(changed[0], /LOC-024 → 已合并/)
  const reg = loadRegistry(repo)
  assert.equal(reg.tasks[0].status, '已合并')
  assert.ok(reg.tasks[0].merge?.commit, '导出 apply 仍回写 merge 事实，行为与退役前一致')
})
