import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  markReady,
  claimIssue,
  releaseIssue,
  fetchTaskSource,
  repoSlug,
  currentActor,
  workerIdentity,
  setGhRunner,
  READY_LABEL,
  WIP_LABEL,
  claimMarker,
  releaseMarker,
  claimKeysInWindow,
} from '../github-issues.mjs'

const SLUG = 'o/r'

function tmpRepo({ remote = `https://github.com/${SLUG}.git` } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-issues-'))
  execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main'])
  if (remote) execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', remote])
  fs.mkdirSync(path.join(dir, 'docs/tasks'), { recursive: true })
  return dir
}

function writeRegistry(repo, tasks) {
  fs.writeFileSync(
    path.join(repo, 'docs/tasks/registry.json'),
    JSON.stringify({ version: 1, tasks }, null, 2) + '\n',
  )
}

function rec(taskId, remote) {
  return { task_id: taskId, name: `任务${taskId}`, remote, status: '本地已定义', slug: taskId.toLowerCase() }
}

/**
 * 内存 gh 替身：只实现本模块用到的那几条命令。
 * `hooks` 允许在指定动作发生时插入「别的会话的并发动作」，用于复现认领竞争。
 */
function fakeGh({ hooks = {} } = {}) {
  const issues = new Map()
  const calls = []
  const labels = new Set()
  const issue = (n) => {
    if (!issues.has(n)) {
      issues.set(n, { number: n, title: `issue ${n}`, state: 'OPEN', labels: [], assignees: [], url: `https://github.com/${SLUG}/issues/${n}`, comments: [] })
    }
    return issues.get(n)
  }
  const runner = (args) => {
    calls.push(args)
    const a = [...args]
    const cmd = a.shift()
    if (cmd === 'api') return JSON.stringify({ login: 'tester' })
    if (cmd === 'label') {
      if (a[0] === 'list') return JSON.stringify([...labels].map((name) => ({ name })))
      if (a[0] === 'create') { labels.add(a[1]); return '' }
    }
    if (cmd === 'issue') {
      const op = a.shift()
      const num = Number(a.shift())
      const it = issue(num)
      if (op === 'list') {
        const li = a.indexOf('--label')
        const want = li >= 0 ? a[li + 1] : null
        return JSON.stringify([...issues.values()].filter((x) => !want || x.labels.includes(want)))
      }
      const flag = (f) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : null }
      if (op === 'view') return JSON.stringify(it)
      if (op === 'edit') {
        const add = flag('--add-label')
        if (add) add.split(',').forEach((l) => { if (!it.labels.includes(l)) it.labels.push(l) })
        const rem = flag('--remove-label')
        if (rem) it.labels = it.labels.filter((l) => !rem.split(',').includes(l))
        const asg = flag('--add-assignee')
        if (asg) asg.split(',').forEach((x) => { if (!it.assignees.includes(x)) it.assignees.push(x) })
        const unasg = flag('--remove-assignee')
        if (unasg) it.assignees = it.assignees.filter((x) => !unasg.split(',').includes(x))
        return ''
      }
      if (op === 'comment') {
        const body = flag('--body')
        if (hooks.beforeClaimComment && /wip-claim/.test(body)) {
          // 模拟并发：对手的认领评论先落地
          it.comments.push({ body: hooks.beforeClaimComment, author: { login: 'other' }, createdAt: '2026-01-01T00:00:00Z' })
        }
        it.comments.push({ body, author: { login: 'tester' }, createdAt: '2026-01-02T00:00:00Z' })
        return ''
      }
    }
    throw new Error(`未实现的 gh 调用：${args.join(' ')}`)
  }
  return { runner, issues, calls, labels, issue }
}

function withGh(fake, fn) {
  setGhRunner(fake.runner)
  try { return fn() } finally { setGhRunner(null) }
}

test('repoSlug：无 GitHub 远端时抛错（禁止回落 CNB）', () => {
  const repo = tmpRepo({ remote: 'https://cnb.cool/chris.ai/workflow-manager.git' })
  assert.throws(() => repoSlug(repo), /未找到 GitHub 主源远端/)
})

test('workerIdentity：gh 登录账号 @ 机器码；无登录时退回机器码', () => {
  assert.equal(workerIdentity({ actor: 'tester', machine: 'm1' }).worker, 'tester@m1')
  assert.equal(workerIdentity({ actor: null, machine: 'm1' }).worker, 'm1')
  assert.equal(workerIdentity({ actor: 'tester', machine: 'm1', agent: 'zcode' }).worker, 'tester@m1（zcode）')
})

test('currentActor：gh 不可用时返回 null 而不是抛错', () => {
  setGhRunner(() => { throw new Error('gh: not logged in') })
  try {
    assert.equal(currentActor(), null)
  } finally {
    setGhRunner(null)
  }
})

test('markReady：无 github 锚点 → 报错并给出换号指引', () => {
  const repo = tmpRepo()
  writeRegistry(repo, [rec('CHORE-110', 'cnb#110')])
  const fake = fakeGh()
  const r = withGh(fake, () => markReady({ repo, taskId: 'CHORE-110' }))
  assert.equal(r.ok, false)
  assert.equal(r.code, 'no-anchor')
  assert.match(r.reason, /先换取正式号/)
})

test('markReady：登记册无此任务 → no-task', () => {
  const repo = tmpRepo()
  writeRegistry(repo, [])
  const fake = fakeGh()
  const r = withGh(fake, () => markReady({ repo, taskId: 'FIX-999' }))
  assert.equal(r.code, 'no-task')
})

test('markReady：幂等——首次打标、二次 already-ready', () => {
  const repo = tmpRepo()
  writeRegistry(repo, [rec('FIX-224', 'github#224')])
  const fake = fakeGh()
  const first = withGh(fake, () => markReady({ repo, taskId: 'FIX-224' }))
  assert.equal(first.ok, true)
  assert.equal(first.code, 'marked')
  assert.deepEqual(fake.issue(224).labels, [READY_LABEL])
  const second = withGh(fake, () => markReady({ repo, taskId: 'FIX-224' }))
  assert.equal(second.code, 'already-ready')
})

test('markReady：双锚点取值认 github 一侧（cnb#111 + github#215）', () => {
  const repo = tmpRepo()
  writeRegistry(repo, [rec('CHORE-111', 'cnb#111 + github#215')])
  const fake = fakeGh()
  const r = withGh(fake, () => markReady({ repo, taskId: 'CHORE-111' }))
  assert.equal(r.ok, true)
  assert.equal(r.issue, 215)
})

test('claimIssue：打「施工中」+ assignee + 认领评论（施工人可查）', () => {
  const repo = tmpRepo()
  writeRegistry(repo, [rec('FIX-224', 'github#224')])
  const fake = fakeGh()
  const r = withGh(fake, () => claimIssue({ repo, taskId: 'FIX-224', runId: 'fix-224-r1', branch: 'dev-fix-224-r1', actor: 'tester' }))
  assert.equal(r.ok, true)
  assert.equal(r.code, 'claimed')
  const it = fake.issue(224)
  assert.ok(it.labels.includes(WIP_LABEL), '应打上施工中标签')
  assert.deepEqual(it.assignees, ['tester'], '应指派到施工人的 GitHub 账号')
  assert.equal(it.comments.length, 1)
  assert.match(it.comments[0].body, /施工人/)
  assert.match(it.comments[0].body, /tester@/)
  assert.match(it.comments[0].body, /dev-fix-224-r1/)
})

test('claimIssue：同 run 重复认领幂等（不重复评论）', () => {
  const repo = tmpRepo()
  writeRegistry(repo, [rec('FIX-224', 'github#224')])
  const fake = fakeGh()
  const args = { repo, taskId: 'FIX-224', runId: 'fix-224-r1', actor: 'tester' }
  withGh(fake, () => claimIssue(args))
  const again = withGh(fake, () => claimIssue(args))
  assert.equal(again.code, 'reused')
  assert.equal(fake.issue(224).comments.length, 1, '幂等复用不得再写评论')
})

test('claimIssue：他人已认领 → 拒绝并给出现任施工人（防重复施工）', () => {
  const repo = tmpRepo()
  writeRegistry(repo, [rec('FIX-224', 'github#224')])
  const fake = fakeGh()
  fake.issue(224).labels.push(WIP_LABEL)
  fake.issue(224).comments.push({ body: `认领 <!-- wip-claim:otherhost/fix-224-r2 -->`, author: { login: 'other' }, createdAt: '2026-01-01T00:00:00Z' })
  const r = withGh(fake, () => claimIssue({ repo, taskId: 'FIX-224', runId: 'fix-224-r1', actor: 'tester' }))
  assert.equal(r.ok, false)
  assert.equal(r.code, 'claimed-by-other')
  assert.equal(r.holder, 'otherhost/fix-224-r2')
  assert.match(r.reason, /已被/)
})

test('claimIssue：并发认领竞争 → 后到者让位，不覆盖先到者标签', () => {
  const repo = tmpRepo()
  writeRegistry(repo, [rec('FIX-224', 'github#224')])
  const fake = fakeGh({ hooks: { beforeClaimComment: '我先到 <!-- wip-claim:otherhost/fix-224-r9 -->' } })
  const r = withGh(fake, () => claimIssue({ repo, taskId: 'FIX-224', runId: 'fix-224-r1', actor: 'tester' }))
  assert.equal(r.ok, false)
  assert.equal(r.code, 'claim-raced')
  assert.equal(r.holder, 'otherhost/fix-224-r9')
})

test('claimIssue：issue 已关闭 → 拒绝认领', () => {
  const repo = tmpRepo()
  writeRegistry(repo, [rec('FIX-224', 'github#224')])
  const fake = fakeGh()
  fake.issue(224).state = 'CLOSED'
  const r = withGh(fake, () => claimIssue({ repo, taskId: 'FIX-224', runId: 'fix-224-r1', actor: 'tester' }))
  assert.equal(r.code, 'issue-not-open')
})

test('claimIssue：无锚点任务显著告警而不是静默通过', () => {
  const repo = tmpRepo()
  writeRegistry(repo, [rec('LOC-020', 'none')])
  const fake = fakeGh()
  const r = withGh(fake, () => claimIssue({ repo, taskId: 'LOC-020', runId: 'loc-020-r1' }))
  assert.equal(r.code, 'no-anchor')
  assert.match(r.reason, /无 github#N 锚点/)
})

test('releaseIssue：摘「施工中」+ 留结束评论；重复释放幂等', () => {
  const repo = tmpRepo()
  writeRegistry(repo, [rec('FIX-224', 'github#224')])
  const fake = fakeGh()
  withGh(fake, () => claimIssue({ repo, taskId: 'FIX-224', runId: 'fix-224-r1', actor: 'tester' }))
  const r1 = withGh(fake, () => releaseIssue({ repo, taskId: 'FIX-224', runId: 'fix-224-r1', reason: '收口', actor: 'tester' }))
  assert.equal(r1.code, 'released')
  assert.ok(!fake.issue(224).labels.includes(WIP_LABEL), '应摘掉施工中标签')
  assert.equal(fake.issue(224).comments.length, 2)
  const r2 = withGh(fake, () => releaseIssue({ repo, taskId: 'FIX-224', runId: 'fix-224-r1', actor: 'tester' }))
  assert.equal(r2.code, 'already-released')
})

test('releaseIssue：释放后 ready 标签保留（任务回到可施工）', () => {
  const repo = tmpRepo()
  writeRegistry(repo, [rec('FIX-224', 'github#224')])
  const fake = fakeGh()
  withGh(fake, () => markReady({ repo, taskId: 'FIX-224' }))
  withGh(fake, () => claimIssue({ repo, taskId: 'FIX-224', runId: 'fix-224-r1', actor: 'tester' }))
  withGh(fake, () => releaseIssue({ repo, taskId: 'FIX-224', runId: 'fix-224-r1', actor: 'tester' }))
  assert.deepEqual(fake.issue(224).labels, [READY_LABEL])
})

// 真机实测回归：释放-重新认领后，「现任施工人」不能取到释放前的陈旧认领标记
test('认领人解析：只认最后一次释放之后的认领标记', () => {
  const comments = [
    { body: `旧认领 ${claimMarker('hostA/fix-224-r1')}`, createdAt: '2026-01-01T00:00:00Z' },
    { body: `结束 ${releaseMarker}`, createdAt: '2026-01-02T00:00:00Z' },
    { body: `新认领 ${claimMarker('hostB/fix-224-r2')}`, createdAt: '2026-01-03T00:00:00Z' },
  ]
  assert.deepEqual(claimKeysInWindow(comments), ['hostB/fix-224-r2'])
  assert.deepEqual(claimKeysInWindow(comments.slice(0, 2)), [])
})

test('释放后另一施工人认领：应成功，且不认陈旧标记为现任', () => {
  const repo = tmpRepo()
  writeRegistry(repo, [rec('FIX-224', 'github#224')])
  const fake = fakeGh()
  withGh(fake, () => claimIssue({ repo, taskId: 'FIX-224', runId: 'fix-224-r1', actor: 'tester' }))
  withGh(fake, () => releaseIssue({ repo, taskId: 'FIX-224', runId: 'fix-224-r1', actor: 'tester' }))
  const r = withGh(fake, () => claimIssue({ repo, taskId: 'FIX-224', runId: 'fix-224-r2', actor: 'tester' }))
  assert.equal(r.ok, true, '释放后应可重新认领')
  assert.equal(r.code, 'claimed')
  // 再有一方来认领，现任施工人必须是新认领人而不是旧标记
  const blocked = withGh(fake, () => claimIssue({ repo, taskId: 'FIX-224', runId: 'fix-224-r3', actor: 'tester' }))
  assert.equal(blocked.code, 'claimed-by-other')
  assert.match(blocked.holder, /fix-224-r2$/)
})

test('fetchTaskSource：claimed 是 ready 的子集，且带出施工人', () => {
  const repo = tmpRepo()
  writeRegistry(repo, [])
  const fake = fakeGh()
  fake.issue(224).labels.push(READY_LABEL)
  fake.issue(225).labels.push(READY_LABEL, WIP_LABEL)
  fake.issue(225).assignees.push('tester')
  fake.issue(226).labels.push('bug') // 未就绪：不应出现在任务源里
  const snap = withGh(fake, () => fetchTaskSource({ repo }))
  assert.deepEqual(snap.ready.map((i) => i.number).sort(), [224, 225])
  assert.deepEqual(snap.claimed.map((i) => i.number), [225])
  assert.equal(snap.claimedBy.get(225), 'tester（assignee）', '无认领标记时退回 assignee，并标注来源')
})

test('远端不可达（gh 未登录）时：读动作抛错，由调用方决定阻断或降级', () => {
  const repo = tmpRepo()
  writeRegistry(repo, [rec('FIX-224', 'github#224')])
  setGhRunner(() => { throw new Error('gh: To use GitHub in the CLI, run `gh auth login`') })
  try {
    assert.throws(() => fetchTaskSource({ repo }), /gh auth login/)
    assert.throws(() => markReady({ repo, taskId: 'FIX-224' }), /gh auth login/)
  } finally {
    setGhRunner(null)
  }
})

// ===== Bugbot #240 审查回归（3 条） =====

test('审查回归①：已关闭的 issue 不得打「可施工」标签', () => {
  const repo = tmpRepo()
  writeRegistry(repo, [rec('FIX-224', 'github#224')])
  const fake = fakeGh()
  fake.issue(224).state = 'CLOSED'
  const r = withGh(fake, () => markReady({ repo, taskId: 'FIX-224' }))
  assert.equal(r.ok, false)
  assert.equal(r.code, 'issue-not-open')
  assert.deepEqual(fake.issue(224).labels, [], '关闭的 issue 不应被打标')
})

test('审查回归③：释放时一并摘 assignee，避免报告指认上任施工人', () => {
  const repo = tmpRepo()
  writeRegistry(repo, [rec('FIX-224', 'github#224')])
  const fake = fakeGh()
  withGh(fake, () => claimIssue({ repo, taskId: 'FIX-224', runId: 'fix-224-r1', actor: 'tester' }))
  assert.deepEqual(fake.issue(224).assignees, ['tester'])
  withGh(fake, () => releaseIssue({ repo, taskId: 'FIX-224', runId: 'fix-224-r1', actor: 'tester' }))
  assert.deepEqual(fake.issue(224).assignees, [], '释放后应摘掉 assignee')
})

test('审查回归③：claimedBy 取认领标记（当前窗口最早者），不取可能过期的 assignee', () => {
  const repo = tmpRepo()
  writeRegistry(repo, [])
  const fake = fakeGh()
  const it = fake.issue(224)
  it.labels.push(READY_LABEL, WIP_LABEL)
  it.assignees.push('stale-user') // 上任施工人残留
  it.comments.push({ body: `旧认领 ${claimMarker('hostA/fix-224-r1')}`, author: { login: 'stale-user' }, createdAt: '2026-01-01T00:00:00Z' })
  it.comments.push({ body: `结束 ${releaseMarker}`, author: { login: 'stale-user' }, createdAt: '2026-01-02T00:00:00Z' })
  it.comments.push({ body: `新认领 ${claimMarker('hostB/fix-224-r2')}`, author: { login: 'new-user' }, createdAt: '2026-01-03T00:00:00Z' })
  const snap = withGh(fake, () => fetchTaskSource({ repo }))
  assert.equal(snap.claimedBy.get(224), 'hostB/fix-224-r2', '应指认现任认领人')
})
