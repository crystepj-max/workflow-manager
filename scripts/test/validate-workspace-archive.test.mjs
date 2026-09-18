// FIX-72 回归：D-8 归档语义分层
//
// 覆盖验收 V-3（轻量归档账实一致）、V-5（本地收口语义不放松）、V-6（轻量归档缺凭据即失败）。
// 远程收口任务 = 登记册含 merge + 轻量归档（archive_form=lightweight-remote + merge.commit
// 与登记册逐字一致 + remote_ref）；本地收口任务仍要求全套三件套。

import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'validate-workspace.mjs')

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'ws-archive-test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'ws-archive-test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
}

function gOk(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(r.status, 0, `git ${args.join(' ')} 失败：${r.stderr}`)
  return r.stdout.trim()
}

function runValidator(repo) {
  const r = spawnSync(process.execPath, [SCRIPT, '--repo', repo, '--json'], {
    encoding: 'utf-8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  })
  // 退出码可能是 0（全绿）或 1（有失败项）——负例用例正是要制造后者；
  // 2 才是异常（不是 git 仓库等）。
  assert.notEqual(r.status, 2, `校验器异常退出：${r.stderr}`)
  return JSON.parse(r.stdout)
}

const rec = (out, id) => out.results.find((x) => x.id === id)

/** 建一个含「1 个远程收口 + 1 个本地收口」已合并任务的临时仓库。 */
function fixture() {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ws-archive-'))
  const repo = path.join(base, 'repo')
  fs.mkdirSync(repo)
  gOk(['init', '-b', 'main'], repo)
  fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n')

  const mergeCommit = 'a'.repeat(40)
  const tasks = [
    {
      task_id: 'FIX-65', type: 'FIX', remote: 'cnb#65', status: '已合并',
      branch: 'dev-fix-65-r1', branch_retained: false,
      merge: { commit: mergeCommit, merged_at: '2026-09-16T00:00:00Z' },
    },
    {
      task_id: 'LOC-901', status: '已合并', branch: 'dev-loc-901-r1', branch_retained: false,
      merge: { commit: 'b'.repeat(40), merged_at: '2026-09-16T00:00:00Z' },
    },
  ]
  fs.mkdirSync(path.join(repo, 'docs', 'tasks'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'docs', 'tasks', 'registry.json'), JSON.stringify({ version: 1, tasks }, null, 2) + '\n')

  // 远程收口：轻量归档（存根 + 含凭据摘要）
  const arch65 = path.join(repo, 'docs', 'tasks', 'archive', 'FIX-65')
  fs.mkdirSync(arch65, { recursive: true })
  fs.writeFileSync(path.join(arch65, 'FIX-65-remote-closeout.md'), '# FIX-65 存根\n\n规格正文以 cnb#65 为源。\n')
  fs.writeFileSync(
    path.join(arch65, 'evidence-summary.json'),
    JSON.stringify({
      task_id: 'FIX-65', status: '已合并', archive_form: 'lightweight-remote',
      remote_ref: 'cnb#65', merge: { commit: mergeCommit, merged_at: '2026-09-16T00:00:00Z' },
      branch: 'dev-fix-65-r1',
    }, null, 2) + '\n',
  )

  // 本地收口：全套三件套
  const arch901 = path.join(repo, 'docs', 'tasks', 'archive', 'LOC-901')
  fs.mkdirSync(arch901, { recursive: true })
  fs.writeFileSync(path.join(arch901, 'LOC-901-demo.md'), '# 任务卡\n')
  fs.writeFileSync(path.join(arch901, 'task-spec-V1.md'), '**版本**：V1\n')
  fs.writeFileSync(path.join(arch901, 'evidence-summary.json'), JSON.stringify({ task_id: 'LOC-901' }, null, 2) + '\n')

  gOk(['add', '-A'], repo)
  gOk(['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-m', 'init'], repo)
  return { repo, arch65, summaryPath: path.join(arch65, 'evidence-summary.json') }
}

test('V-3 正例：远程收口（轻量归档含凭据）与本地收口（全套三件套）均通过', () => {
  const { repo } = fixture()
  const out = runValidator(repo)
  assert.equal(rec(out, 'D-8').ok, true, JSON.stringify(rec(out, 'D-8').details))
})

test('V-6 负例：轻量归档 merge.commit 与登记册不一致即失败', () => {
  const { repo, summaryPath } = fixture()
  const s = JSON.parse(fs.readFileSync(summaryPath, 'utf8'))
  s.merge.commit = 'c'.repeat(40)
  fs.writeFileSync(summaryPath, JSON.stringify(s, null, 2) + '\n')
  gOk(['add', '-A'], repo)
  gOk(['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-m', 'tamper'], repo)
  const out = runValidator(repo)
  assert.equal(rec(out, 'D-8').ok, false)
  assert.ok(rec(out, 'D-8').details.join(' ').includes('merge.commit 与登记册不一致'))
})

test('V-6 负例：轻量归档缺 remote_ref 即失败', () => {
  const { repo, summaryPath } = fixture()
  const s = JSON.parse(fs.readFileSync(summaryPath, 'utf8'))
  delete s.remote_ref
  fs.writeFileSync(summaryPath, JSON.stringify(s, null, 2) + '\n')
  gOk(['add', '-A'], repo)
  gOk(['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-m', 'tamper'], repo)
  const out = runValidator(repo)
  assert.equal(rec(out, 'D-8').ok, false)
  assert.ok(rec(out, 'D-8').details.join(' ').includes('remote_ref'))
})

test('V-5 负例：本地收口任务缺全套三件套不因轻量形态而豁免', () => {
  const { repo } = fixture()
  // LOC-901 是本地收口（无 remote / 非 lightweight 摘要），抽掉其规格终版
  fs.unlinkSync(path.join(repo, 'docs', 'tasks', 'archive', 'LOC-901', 'task-spec-V1.md'))
  gOk(['add', '-A'], repo)
  gOk(['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-m', 'tamper'], repo)
  const out = runValidator(repo)
  assert.equal(rec(out, 'D-8').ok, false)
  assert.ok(rec(out, 'D-8').details.join(' ').includes('LOC-901 缺规格终版'))
})

test('决策五收窄：specs/ 存在不再触发 D-8 警告', () => {
  const { repo } = fixture()
  fs.mkdirSync(path.join(repo, 'docs', 'tasks', 'specs', 'FIX-72-feat-fix-chore'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'docs', 'tasks', 'specs', 'FIX-72-feat-fix-chore', 'task-spec-V1.md'), 'v1\n')
  gOk(['add', '-A'], repo)
  gOk(['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-m', 'defs'], repo)
  const out = runValidator(repo)
  assert.equal(rec(out, 'D-8').ok, true)
  const warns = out.results.filter((x) => x.id === 'D-8' && x.ok === null)
  assert.equal(warns.length, 0, JSON.stringify(warns))
})

test('决策五收窄：archive/ 内混入非任务目录仍告警', () => {
  const { repo } = fixture()
  fs.mkdirSync(path.join(repo, 'docs', 'tasks', 'archive', 'not-a-task'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'docs', 'tasks', 'archive', 'not-a-task', 'x.md'), 'x\n')
  gOk(['add', '-A'], repo)
  gOk(['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-m', 'drift'], repo)
  const out = runValidator(repo)
  const warns = out.results.filter((x) => x.id === 'D-8' && x.ok === null)
  assert.equal(warns.length, 1)
  assert.ok(warns[0].details.join(' ').includes('not-a-task'))
})
