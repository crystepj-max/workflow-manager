// WFM-342：旧登记册证据清理已停用，本地 Run 明细继续保留。

import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const VALIDATOR = path.join(HERE, '..', 'validate-workspace.mjs')
const CLEANER = path.join(HERE, '..', 'task-runs-cleanup.mjs')
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'wfm342-test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'wfm342-test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
}

function fixture() {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'wfm342-evidence-'))
  const repo = path.join(base, 'repo')
  fs.mkdirSync(repo)
  const init = spawnSync('git', ['init', '-b', 'main'], { cwd: repo, env: GIT_ENV, encoding: 'utf8' })
  assert.equal(init.status, 0, init.stderr)
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n')
  fs.mkdirSync(path.join(repo, 'docs', 'tasks'), { recursive: true })
  const registryPath = path.join(repo, 'docs', 'tasks', 'registry.json')
  const registry = '{malformed legacy snapshot\n'
  fs.writeFileSync(registryPath, registry)
  for (const args of [['add', '-A'], ['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-m', 'fixture']]) {
    const r = spawnSync('git', args, { cwd: repo, env: GIT_ENV, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
  }
  const runDir = path.join(repo, '.agent-runs', 'fix-981-r1')
  fs.mkdirSync(runDir, { recursive: true })
  const sentinel = path.join(runDir, 'unique-evidence.json')
  fs.writeFileSync(sentinel, '{"keep":true}\n')
  return { base, repo, runDir, sentinel, registryPath, registry }
}

function validate(repo) {
  const r = spawnSync(process.execPath, [VALIDATOR, '--repo', repo, '--json'], { cwd: repo, env: GIT_ENV, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout)
}

test('D-7 / D-9 / D-10：校验器不把冻结登记册当任务状态或清理时钟', () => {
  const { repo } = fixture()
  const out = validate(repo)
  for (const id of ['D-7', 'D-9', 'D-10']) {
    const rec = out.results.find((r) => r.id === id)
    assert.equal(rec?.skipped, true, `${id} 应明确跳过旧 Task 字段推断`)
  }
})

test('task-runs-cleanup --apply：在读旧账或删证据前拒绝', () => {
  const { repo, runDir, sentinel, registryPath, registry } = fixture()
  const beforeRegistry = fs.readFileSync(registryPath, 'utf8')
  const r = spawnSync(process.execPath, [CLEANER, '--repo', repo, '--apply'], { cwd: repo, env: GIT_ENV, encoding: 'utf8' })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /legacy_task_registry_cleanup_disabled/)
  assert.equal(fs.readFileSync(registryPath, 'utf8'), beforeRegistry)
  assert.equal(beforeRegistry, registry)
  assert.equal(fs.existsSync(runDir), true)
  assert.deepEqual(JSON.parse(fs.readFileSync(sentinel, 'utf8')), { keep: true })
})
