import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import assert from 'node:assert/strict'

import { claimForRun } from '../cwf-run-init.mjs'
import { claimIssue, setGhRunner, WIP_LABEL } from '../github-issues.mjs'

const SLUG = 'o/r'

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-init-claim-'))
  execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main'])
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

function runner({ fail = null, claimed = null } = {}) {
  const repoLabels = new Set()   // 仓库级标签定义（gh label list/create）
  const issueLabels = new Set()  // 本条 issue 上的标签（gh issue view/edit）
  const comments = []
  const assignees = []
  return (args) => {
    if (fail) throw new Error(fail)
    const a = [...args]
    const cmd = a.shift()
    if (cmd === 'api') return JSON.stringify({ login: 'tester' })
    if (cmd === 'label') {
      if (a[0] === 'list') return JSON.stringify([...repoLabels].map((name) => ({ name })))
      repoLabels.add(a[1])
      return ''
    }
    if (cmd === 'issue') {
      const op = a.shift()
      const flag = (f) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : null }
      if (op === 'view') {
        return JSON.stringify({
          number: 224, title: 't', state: 'OPEN',
          labels: claimed ? [WIP_LABEL] : [...issueLabels],
          assignees,
          url: `https://github.com/${SLUG}/issues/224`,
          comments: claimed ? [{ body: '对方先到 <!-- wip-claim:otherhost/fix-224-r7 -->', author: { login: 'other' }, createdAt: '2026-01-01T00:00:00Z' }] : comments,
        })
      }
      if (op === 'edit') {
        const add = flag('--add-label')
        if (add) add.split(',').forEach((l) => issueLabels.add(l))
        const rem = flag('--remove-label')
        if (rem) rem.split(',').forEach((l) => issueLabels.delete(l))
        const asg = flag('--add-assignee')
        if (asg) asg.split(',').forEach((x) => assignees.push(x))
        return ''
      }
      if (op === 'comment') { comments.push({ body: flag('--body'), author: { login: 'tester' }, createdAt: '2026-01-02T00:00:00Z' }); return '' }
    }
    throw new Error(`未实现的 gh 调用：${args.join(' ')}`)
  }
}

function withGh(fn, fn2) {
  setGhRunner(fn)
  try { return fn2() } finally { setGhRunner(null) }
}

test('claimForRun：--no-claim 时明确跳过（本地自测路径）', () => {
  const repo = tmpRepo()
  writeRegistry(repo, [])
  const r = withGh(() => { throw new Error('不该调用 gh') }, () => claimForRun({ repo, taskId: 'FIX-224', runId: 'fix-224-r1', enabled: false }))
  assert.equal(r.status, 'skipped')
})

test('claimForRun：正常认领 → claimed，带施工人与 claimKey', () => {
  const repo = tmpRepo()
  writeRegistry(repo, [{ task_id: 'FIX-224', remote: 'github#224', slug: 'x' }])
  const r = withGh(runner(), () => claimForRun({ repo, taskId: 'FIX-224', runId: 'fix-224-r1', branch: 'dev-fix-224-r1', actor: 'tester' }))
  assert.equal(r.status, 'claimed')
  assert.equal(r.issue, 224)
  assert.match(r.worker, /tester@/)
  assert.equal(r.claimKey.endsWith('/fix-224-r1'), true)
})

test('claimForRun：同 run 重复 → reused（幂等复跑不重复评论）', () => {
  const repo = tmpRepo()
  writeRegistry(repo, [{ task_id: 'FIX-224', remote: 'github#224', slug: 'x' }])
  const r = withGh(runner(), () => {
    claimForRun({ repo, taskId: 'FIX-224', runId: 'fix-224-r1', actor: 'tester' })
    return claimForRun({ repo, taskId: 'FIX-224', runId: 'fix-224-r1', actor: 'tester' })
  })
  assert.equal(r.status, 'reused')
})

test('claimForRun：他人已认领 → 硬拒绝（开工互斥的核心）', () => {
  const repo = tmpRepo()
  writeRegistry(repo, [{ task_id: 'FIX-224', remote: 'github#224', slug: 'x' }])
  const r = withGh(runner({ claimed: true }), () => claimForRun({ repo, taskId: 'FIX-224', runId: 'fix-224-r1', actor: 'tester' }))
  assert.equal(r.status, 'blocked')
  assert.equal(r.issue, 224)
  assert.equal(r.holder, 'otherhost/fix-224-r7')
})

test('claimForRun：gh 不可用 → warn 降级，不阻断本地开工', () => {
  const repo = tmpRepo()
  writeRegistry(repo, [{ task_id: 'FIX-224', remote: 'github#224', slug: 'x' }])
  const r = withGh(runner({ fail: 'gh: To use GitHub in the CLI, run `gh auth login`' }), () => claimForRun({ repo, taskId: 'FIX-224', runId: 'fix-224-r1' }))
  assert.equal(r.status, 'warn')
  assert.match(r.reason, /gh auth login/)
})

test('claimForRun：双锚点任务按 github 一侧认领；无锚点任务只告警', () => {
  const repo = tmpRepo()
  writeRegistry(repo, [
    { task_id: 'CHORE-111', remote: 'cnb#111 + github#215', slug: 'a' },
    { task_id: 'LOC-020', remote: 'none', slug: 'b' },
  ])
  const r = withGh(runner(), () => claimForRun({ repo, taskId: 'CHORE-111', runId: 'chore-111-r1', actor: 'tester' }))
  assert.equal(r.issue, 215)
  const r2 = withGh(runner(), () => claimForRun({ repo, taskId: 'LOC-020', runId: 'loc-020-r1', actor: 'tester' }))
  assert.equal(r2.status, 'warn')
  assert.match(r2.reason, /无 github#N 锚点/)
})

test('claimIssue 与 claimForRun 共用同一套判定（无分叉实现）', () => {
  const repo = tmpRepo()
  writeRegistry(repo, [{ task_id: 'FIX-224', remote: 'github#224', slug: 'x' }])
  const direct = withGh(runner(), () => claimIssue({ repo, taskId: 'FIX-224', runId: 'fix-224-r1', actor: 'tester' }))
  assert.equal(direct.code, 'claimed')
})

// ===== Bugbot #240 审查回归（第 2 条）=====

test('审查回归②：issue 已关闭 → 硬拒绝开工（不是告警放行）', () => {
  const repo = tmpRepo()
  writeRegistry(repo, [{ task_id: 'FIX-224', remote: 'github#224', slug: 'x' }])
  const closedRunner = (args) => {
    const a = [...args]
    const cmd = a.shift()
    if (cmd === 'api') return JSON.stringify({ login: 'tester' })
    if (cmd === 'label') return a[0] === 'list' ? JSON.stringify([{ name: 'ready-for-agent' }, { name: WIP_LABEL }]) : ''
    if (cmd === 'issue') {
      const op = a.shift()
      if (op === 'view') return JSON.stringify({ number: 224, title: 't', state: 'CLOSED', labels: [], assignees: [], url: '', comments: [] })
      return ''
    }
    throw new Error('未实现的 gh 调用')
  }
  const r = withGh(closedRunner, () => claimForRun({ repo, taskId: 'FIX-224', runId: 'fix-224-r1', actor: 'tester' }))
  assert.equal(r.status, 'blocked', '已关闭的 issue 必须拒绝开工')
  assert.match(r.reason, /CLOSED/)
  assert.equal(r.holder, null)
})
