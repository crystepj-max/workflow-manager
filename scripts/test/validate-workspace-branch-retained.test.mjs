// CHORE-286 回归：D-10「收口口径一致」以**远端共享真值**为准
//
// 背景：原实现核验 `refs/heads/<branch>`（本地引用）。CI runner 只检出单个 ref，故任何标
// 「保留分支」的任务在 CI 上必然被判违规——该检查在 CI 上不可能通过，与登记册数据是否干净无关。
// 新口径核验 `refs/remotes/origin/<branch>`（共享真值），由 `.github/workflows/validate.yml`
// 的显式 fetch 步骤保证可得。
//
// 语义要点（本用例的判据）：
//   · 标「保留」= 远端仍存在该分支；标「不保留」= 远端已无该分支。
//   · **本地残留分支不再被算作「保留」** ——若仍按本地引用判定，则「保留」一词会被本地
//     残留冒充，且登记册与归档存根（写明「已随合并删除」）长期互相矛盾。

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
  GIT_AUTHOR_NAME: 'ws-branch-test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'ws-branch-test',
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
  assert.notEqual(r.status, 2, `校验器异常退出：${r.stderr}`)
  return JSON.parse(r.stdout)
}

const rec = (out, id) => out.results.find((x) => x.id === id)

/**
 * 造一个含四种分支情形的临时仓库（归档一律留空——D-8 的相关性不在本用例范围）：
 *   FIX-201  远端存在          + 标保留   → 应通过
 *   FIX-202  **仅本地存在**    + 标不保留 → 应通过（新口径的关键：本地残留不再冒充保留）
 *   FIX-203  两处都不存在      + 标保留   → 应失败
 *   FIX-204  远端存在          + 标不保留 → 应失败
 * 远端共享真值以手工建立 `refs/remotes/origin/<branch>` 模拟，避免用例依赖网络。
 */
function fixture() {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ws-branch-'))
  const repo = path.join(base, 'repo')
  fs.mkdirSync(repo)
  gOk(['init', '-b', 'main'], repo)
  fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n')

  const merge = { commit: 'c'.repeat(40), merged_at: '2026-09-16T00:00:00Z' }
  const tasks = [
    { task_id: 'FIX-201', status: '已合并', branch: 'dev-remote-only-r1', branch_retained: true, merge },
    { task_id: 'FIX-202', status: '已合并', branch: 'dev-local-only-r1', branch_retained: false, merge },
    { task_id: 'FIX-203', status: '已合并', branch: 'dev-ghost-r1', branch_retained: true, merge },
    { task_id: 'FIX-204', status: '已合并', branch: 'dev-remote-only-r1', branch_retained: false, merge },
  ]
  fs.mkdirSync(path.join(repo, 'docs', 'tasks'), { recursive: true })
  fs.writeFileSync(
    path.join(repo, 'docs', 'tasks', 'registry.json'),
    JSON.stringify({ version: 1, tasks }, null, 2) + '\n',
  )

  gOk(['add', '-A'], repo)
  gOk(['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-m', 'init'], repo)
  // 仅本地存在的分支（远端没有）
  gOk(['branch', 'dev-local-only-r1'], repo)
  // 远端共享真值（模拟 fetch 后的远端跟踪引用）
  gOk(['update-ref', 'refs/remotes/origin/dev-remote-only-r1', 'HEAD'], repo)
  return { repo }
}

test('D-10：以远端共享真值为准（本地残留分支不冒充「保留」）', () => {
  const { repo } = fixture()
  const d10 = rec(runValidator(repo), 'D-10')
  assert.ok(d10, '应产出 D-10 记录')
  const text = JSON.stringify(d10)

  assert.ok(!text.includes('FIX-201'), '远端存在 + 标保留 → 应通过')
  assert.ok(!text.includes('FIX-202'), '仅本地存在 + 标不保留 → 应通过（原实现会误报）')
  assert.ok(text.includes('FIX-203'), '两处都不存在 + 标保留 → 应失败')
  assert.ok(text.includes('FIX-204'), '远端仍存在 + 标不保留 → 应失败')
})

test('D-10：失败文案指明核验侧为「远端」', () => {
  const { repo } = fixture()
  const text = JSON.stringify(rec(runValidator(repo), 'D-10'))
  assert.match(text, /远端/, '文案应显式点明核验的是远端，避免与本地引用混淆')
})
