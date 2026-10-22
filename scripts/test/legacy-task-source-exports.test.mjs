import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  loadRegistry, saveRegistry, allocate, update, writeBoard, remoteAllocate, setGhRunner,
} from '../local-task-registry.mjs'
import { collectLocalCandidates } from '../ai-task-candidate-collect.mjs'
import { runPreflight, checkCrossGroupDeps } from '../ai-task-preflight-check.mjs'
import { assessAndSort } from '../ai-task-execution-plan.mjs'
import { reconcilePlan } from '../registry-reconcile.mjs'
import { remoteAnchorOfTask } from '../github-issues.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const history = { legacyHistoryAudit: true }
const readDisabled = (error) => error.code === 'legacy_registry_read_disabled'
const writeDisabled = (error) => error.code === 'legacy_registry_write_disabled'

function fixture(t, malformed = false) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-source-exports-'))
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  fs.mkdirSync(path.join(repo, 'docs/tasks'), { recursive: true })
  const registry = path.join(repo, 'docs/tasks/registry.json')
  const board = path.join(repo, 'docs/tasks/BOARD.md')
  fs.writeFileSync(registry, malformed ? '{malformed legacy data\n' : JSON.stringify({
    version: 1, revision: 4,
    tasks: [{ task_id: 'LOC-020', name: '迁移前任务', status: '本地已定义', remote: 'github#20', deps: [] }],
  }) + '\n')
  fs.writeFileSync(board, '# historical board\n')
  const before = [fs.readFileSync(registry, 'utf8'), fs.readFileSync(board, 'utf8')]
  return { repo, unchanged() {
    assert.deepEqual([fs.readFileSync(registry, 'utf8'), fs.readFileSync(board, 'utf8')], before)
  } }
}

test('旧导出不能把有效登记册作为当前 Task 源', async (t) => {
  const f = fixture(t)
  assert.throws(() => loadRegistry(f.repo), readDisabled)
  assert.throws(() => collectLocalCandidates({ repo: f.repo }), readDisabled)
  assert.throws(() => checkCrossGroupDeps(['LOC-020'], f.repo, 'HEAD', () => {}), readDisabled)
  assert.throws(() => reconcilePlan(f.repo), readDisabled)
  assert.throws(() => remoteAnchorOfTask(f.repo, 'LOC-020'), readDisabled)
  await assert.rejects(() => runPreflight('task.md', 'spec.md', { repo: f.repo }), readDisabled)
  await assert.rejects(() => assessAndSort([], path.join(f.repo, 'batch.json'), f.repo), readDisabled)
  f.unchanged()
})

test('默认拒绝在任务卡、登记册或 Git 读取之前发生，包括空依赖', async (t) => {
  const f = fixture(t, true)
  assert.throws(() => loadRegistry(f.repo), readDisabled)
  assert.throws(() => collectLocalCandidates({ repo: f.repo }), readDisabled)
  assert.throws(() => checkCrossGroupDeps([], f.repo, 'HEAD', () => {}), readDisabled)
  assert.throws(() => reconcilePlan(f.repo), readDisabled)
  assert.throws(() => remoteAnchorOfTask(f.repo, 'LOC-020'), readDisabled)
  await assert.rejects(() => runPreflight(null, null, { repo: f.repo }), readDisabled)
  await assert.rejects(() => assessAndSort([], null, f.repo), readDisabled)
  f.unchanged()
})

test('程序化写入口在任何写盘或 gh 调用前拒绝，历史标记不能解锁写入', (t) => {
  const f = fixture(t, true)
  const calls = []
  setGhRunner((args) => { calls.push(args); return 'https://github.com/o/r/issues/99\n' })
  t.after(() => setGhRunner(null))
  for (const opts of [{}, history]) {
    assert.throws(() => saveRegistry(f.repo, { tasks: [] }, opts), writeDisabled)
    assert.throws(() => allocate(f.repo, { name: '不应创建', offline: true, ...opts }), writeDisabled)
    assert.throws(() => update(f.repo, 'LOC-020', { status: '已合并' }, opts), writeDisabled)
    assert.throws(() => writeBoard(f.repo, opts), writeDisabled)
    assert.throws(() => remoteAllocate({ repo: f.repo, name: '不应发号', ...opts }), writeDisabled)
  }
  assert.deepEqual(calls, [])
  f.unchanged()
})

test('保留的历史读取必须显式选择只读模式，修改返回值不落盘', (t) => {
  const f = fixture(t)
  const snapshot = loadRegistry(f.repo, history)
  assert.equal(snapshot.tasks[0].task_id, 'LOC-020')
  snapshot.tasks[0].status = '已合并'
  assert.equal(loadRegistry(f.repo, history).tasks[0].status, '本地已定义')
  assert.equal(remoteAnchorOfTask(f.repo, 'LOC-020', history).issue, 20)
  const audit = collectLocalCandidates({ repo: f.repo, ...history })
  assert.equal(audit.source_kind, 'legacy-history-audit')
  assert.deepEqual(audit.candidates.map((c) => c.id), ['LOC-020'])
  f.unchanged()
})

test('显式历史 fixture 可回放 preflight 与排序，不能变成当前调度入口', async (t) => {
  const f = fixture(t)
  const issue = path.join(f.repo, 'task-basics.md')
  const spec = path.join(f.repo, 'task-spec-V1.md')
  fs.writeFileSync(issue, `# 历史任务 fixture

| 字段 | 值 |
|---|---|
| 任务名称 | 历史候选 |
| 当前状态 | 本地已定义 |
| 任务标识 | LOC-020 |
| GitHub 同步 | not-applicable |
| 需求基线版本 | V1 |
| 前置依赖 | 无 |
| 施工环境组 | legacy-fixture |
| 施工环境角色 | 独立 |
| 优先级 | P1 |
| 无人值守许可 | 允许 |
| 定义时间 | 2026-09-01T00:00:00Z |
| 任务规格位置 | task-spec-V1.md |
`)
  fs.writeFileSync(spec, '# 任务规格 V1\n\n未决产品事项：0\n')
  fs.writeFileSync(path.join(f.repo, 'definition-check.md'), '| 未决产品事项 | 0 |\n- [x] 历史检查通过\n')
  const replay = await runPreflight(issue, spec, { repo: f.repo, ...history })
  assert.equal(replay.ok, true, JSON.stringify(replay))
  const sorted = await assessAndSort([
    { id: 'LOC-020', issueBasics: 'task-basics.md', taskSpec: 'task-spec-V1.md' },
  ], path.join(f.repo, 'batch.json'), f.repo, history)
  assert.deepEqual(sorted.eligible.map((task) => task.id), ['LOC-020'])
  assert.deepEqual(sorted.excluded, [])
  const reasons = []
  checkCrossGroupDeps(['LOC-404'], f.repo, 'HEAD', (_message, code) => reasons.push(code), history)
  assert.deepEqual(reasons, ['PREFLIGHT_DEP_UNKNOWN'])
  f.unchanged()
})

test('旧 npm 同步入口已移除；直接脚本仍明确退役并零远端调用', (t) => {
  const f = fixture(t, true)
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.equal(manifest.scripts['sync:remote-issues'], undefined)
  const fakeBin = path.join(f.repo, 'bin')
  fs.mkdirSync(fakeBin)
  const log = path.join(f.repo, 'cli-calls.log')
  for (const cli of ['gh', 'multica']) {
    fs.writeFileSync(path.join(fakeBin, cli), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$LEGACY_CLI_LOG"\nexit 1\n', { mode: 0o755 })
  }
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/remote-issue-sync.mjs'), 'plan', '--repo', f.repo], {
    cwd: f.repo, encoding: 'utf8', env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, LEGACY_CLI_LOG: log },
  })
  assert.equal(result.status, 2, result.stderr)
  assert.equal(JSON.parse(result.stderr).code, 'legacy_github_task_sync_disabled')
  assert.equal(fs.existsSync(log), false)
  f.unchanged()
})
