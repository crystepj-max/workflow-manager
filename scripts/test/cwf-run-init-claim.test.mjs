import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'

import { claimForRun, envResourcesFor } from '../cwf-run-init.mjs'
import { claimIssue, setGhRunner } from '../github-issues.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const initCli = path.join(root, 'scripts/cwf-run-init.mjs')
const SLUG = 'o/r'
const DISABLED = 'legacy_github_issue_write_disabled'

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-init-claim-'))
  execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main'])
  execFileSync('git', ['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'init'])
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', `https://github.com/${SLUG}.git`])
  fs.mkdirSync(path.join(dir, 'docs/tasks'), { recursive: true })
  return dir
}

function writeRegistry(repo, tasks) {
  fs.writeFileSync(
    path.join(repo, 'docs/tasks/registry.json'),
    JSON.stringify({ version: 1, tasks }, null, 2) + '\n',
  )
}

/** 任何被调用即崩溃的 gh 替身：用来证明停用后根本没碰 gh。 */
function forbiddenGh() {
  return () => { throw new Error('不该调用 gh') }
}

function withGh(fn, fn2) {
  setGhRunner(fn)
  try { return fn2() } finally { setGhRunner(null) }
}

function fakeGhBin() {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-bin-'))
  const counts = path.join(bin, 'calls.log')
  fs.writeFileSync(counts, '')
  const stub = path.join(bin, 'gh')
  fs.writeFileSync(stub, `#!/bin/sh\necho "$@" >> "${counts}"\nexit 0\n`)
  fs.chmodSync(stub, 0o755)
  return { bin, counts, callCount: () => fs.readFileSync(counts, 'utf8').split('\n').filter(Boolean).length }
}

// ───────────── claimForRun：旧 claim 已停用，返回 retired 并明示人工单写者把关 ─────────────

test('claimForRun：--no-claim 时明确跳过（本地自测路径保留）', () => {
  const repo = tmpRepo()
  writeRegistry(repo, [])
  const r = withGh(forbiddenGh(), () => claimForRun({ repo, taskId: 'FIX-224', runId: 'fix-224-r1', enabled: false }))
  assert.equal(r.status, 'skipped')
})

test('claimForRun：有 github 锚点也只返回 retired，不写旧 claim、不碰 gh', () => {
  const repo = tmpRepo()
  writeRegistry(repo, [{ task_id: 'FIX-224', remote: 'github#224', slug: 'x' }])
  const r = withGh(forbiddenGh(), () => claimForRun({ repo, taskId: 'FIX-224', runId: 'fix-224-r1', branch: 'dev-fix-224-r1', actor: 'tester' }))
  assert.equal(r.status, 'retired')
  assert.equal(r.reason, DISABLED)
  assert.match(r.warning, /Multica/, '须提示由 Multica 人工单写者把关')
  assert.match(r.warning, /原子|互斥|跨机器/, '须如实说明此处没有原子互斥或跨机器安全保证')
})

test('claimForRun：无锚点任务同样 retired（不再据此告警放行）', () => {
  const repo = tmpRepo()
  writeRegistry(repo, [{ task_id: 'LOC-020', remote: 'none', slug: 'b' }])
  const r = withGh(forbiddenGh(), () => claimForRun({ repo, taskId: 'LOC-020', runId: 'loc-020-r1', actor: 'tester' }))
  assert.equal(r.status, 'retired')
  assert.equal(r.reason, DISABLED)
})

test('claimIssue 直接调用也 fail-closed，与 claimForRun 一致拒绝、不共用任何写入', () => {
  const repo = tmpRepo()
  writeRegistry(repo, [{ task_id: 'FIX-224', remote: 'github#224', slug: 'x' }])
  const direct = withGh(forbiddenGh(), () => claimIssue({ repo, taskId: 'FIX-224', runId: 'fix-224-r1', actor: 'tester' }))
  assert.equal(direct.ok, false)
  assert.equal(direct.code, DISABLED)
})

// ───────────── 集成：真实 cwf-run-init 仍能建 branch/worktree/run.json，且不写旧 claim ─────────────

test('集成：cwf-run-init 建好 branch/worktree/run.json（含 plugin_namespace 与 dev_dsh_port），且 0 次 gh', (t) => {
  const repo = tmpRepo()
  writeRegistry(repo, [{ task_id: 'FIX-224', remote: 'github#224', slug: 'x' }])
  const ghBin = fakeGhBin()
  const env = { ...process.env, PATH: `${ghBin.bin}${path.delimiter}${process.env.PATH}` }

  const r = spawnSync(process.execPath, [initCli, 'FIX-224', 'fix-224-r1', '--local-base', '--base', 'main'], { cwd: repo, encoding: 'utf8', env })
  assert.equal(r.status, 0, `cwf-run-init 应成功：stdout=${r.stdout}\nstderr=${r.stderr}`)

  const out = JSON.parse(r.stdout)
  assert.equal(out.plugin_namespace, 'fix-224-r1')
  assert.equal(out.dev_dsh_port, envResourcesFor('fix-224-r1').dev_dsh_port)
  assert.equal(out.claim.status, 'retired', 'run 结果须如实标注旧 claim 已停用')
  assert.equal(fs.existsSync(out.worktree), true, '工作树应已创建')
  const branch = execFileSync('git', ['-C', repo, 'branch', '--list', 'dev-fix-224-r1'], { encoding: 'utf-8' }).trim()
  assert.match(branch, /dev-fix-224-r1/, '任务分支应已创建')

  const runJson = JSON.parse(fs.readFileSync(path.join(out.runDir, 'run.json'), 'utf8'))
  assert.equal(runJson.env_resources.plugin_namespace, 'fix-224-r1')
  assert.equal(runJson.env_resources.dev_dsh_port, envResourcesFor('fix-224-r1').dev_dsh_port)
  assert.equal(runJson.claim.status, 'retired')

  assert.equal(ghBin.callCount(), 0, '旧 GitHub claim 不得被写入（0 次 gh）')

  t.after(() => {
    for (const wt of execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], { encoding: 'utf-8' }).split('\n')) {
      if (wt.startsWith('worktree ') && wt.includes('-worktrees')) execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', wt.slice(9)], { stdio: 'ignore' })
    }
    fs.rmSync(repo, { recursive: true, force: true })
    fs.rmSync(path.join(path.dirname(repo), 'run-init-claim-worktrees'), { recursive: true, force: true })
  })
})
