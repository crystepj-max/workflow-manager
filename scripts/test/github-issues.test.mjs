import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
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
  LEGACY_GITHUB_ISSUE_WRITE_DISABLED,
  claimMarker,
  releaseMarker,
  claimKeysInWindow,
} from '../github-issues.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const cli = path.join(root, 'scripts/github-issues.mjs')
const SLUG = 'o/r'
// 稳定的停用原因码：旧任务管理写入口 fail-closed 的对外契约，调用方据此识别与阻断。
const DISABLED = 'legacy_github_issue_write_disabled'

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
 * `calls` 记录每一次 gh 调用——写入口停用后，任何写动作都应是 0 次调用。
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

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/** 在临时 bin 放一个记账的假 gh：每次调用把参数追加到 counts 文件；用于证明"根本没碰 gh"。 */
function fakeGhBin() {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-bin-'))
  const counts = path.join(bin, 'calls.log')
  fs.writeFileSync(counts, '')
  const stub = path.join(bin, 'gh')
  fs.writeFileSync(stub, `#!/bin/sh\necho "$@" >> "${counts}"\nexit 0\n`)
  fs.chmodSync(stub, 0o755)
  return { bin, counts, callCount: () => fs.readFileSync(counts, 'utf8').split('\n').filter(Boolean).length }
}

function runCli(args, cwd, ghBin) {
  const env = { ...process.env }
  if (ghBin) env.PATH = `${ghBin.bin}${path.delimiter}${env.PATH}`
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', env })
}

// ───────────── 只读 / 纯函数能力：必须原样保留，不得被误关 ─────────────

test('repoSlug：无 GitHub 远端时抛错（禁止回落 CNB）', () => {
  const repo = tmpRepo({ remote: 'https://cnb.cool/chris.ai/workflow-manager.git' })
  assert.throws(() => repoSlug(repo), /未找到 GitHub 主源远端/)
})

test('workerIdentity：gh 登录账号 @ 机器码；无登录时退回机器码（纯函数保留）', () => {
  assert.equal(workerIdentity({ actor: 'tester', machine: 'm1' }).worker, 'tester@m1')
  assert.equal(workerIdentity({ actor: null, machine: 'm1' }).worker, 'm1')
  assert.equal(workerIdentity({ actor: 'tester', machine: 'm1', agent: 'zcode' }).worker, 'tester@m1（zcode）')
})

test('currentActor：gh 不可用时返回 null 而不是抛错（读动作保留）', () => {
  setGhRunner(() => { throw new Error('gh: not logged in') })
  try {
    assert.equal(currentActor(), null)
  } finally {
    setGhRunner(null)
  }
})

test('fetchTaskSource：claimed 是 ready 的子集，且带出施工人（读动作保留）', () => {
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

test('审查回归③：claimedBy 取认领标记（当前窗口最早者），不取可能过期的 assignee（读路径保留）', () => {
  const repo = tmpRepo()
  writeRegistry(repo, [])
  const fake = fakeGh()
  const it = fake.issue(224)
  it.labels.push(READY_LABEL, WIP_LABEL)
  it.assignees.push('stale-user')
  it.comments.push({ body: `旧认领 ${claimMarker('hostA/fix-224-r1')}`, author: { login: 'stale-user' }, createdAt: '2026-01-01T00:00:00Z' })
  it.comments.push({ body: `结束 ${releaseMarker}`, author: { login: 'stale-user' }, createdAt: '2026-01-02T00:00:00Z' })
  it.comments.push({ body: `新认领 ${claimMarker('hostB/fix-224-r2')}`, author: { login: 'new-user' }, createdAt: '2026-01-03T00:00:00Z' })
  const snap = withGh(fake, () => fetchTaskSource({ repo }))
  assert.equal(snap.claimedBy.get(224), 'hostB/fix-224-r2', '应指认现任认领人')
})

test('认领人解析：只认最后一次释放之后的认领标记（纯函数保留）', () => {
  const comments = [
    { body: `旧认领 ${claimMarker('hostA/fix-224-r1')}`, createdAt: '2026-01-01T00:00:00Z' },
    { body: `结束 ${releaseMarker}`, createdAt: '2026-01-02T00:00:00Z' },
    { body: `新认领 ${claimMarker('hostB/fix-224-r2')}`, createdAt: '2026-01-03T00:00:00Z' },
  ]
  assert.deepEqual(claimKeysInWindow(comments), ['hostB/fix-224-r2'])
  assert.deepEqual(claimKeysInWindow(comments.slice(0, 2)), [])
})

// ───────────── 只读前置判定：no-task / no-anchor 仍以 registry 读返回，不调用 gh ─────────────

test('markReady：无 github 锚点 → 仍返回 no-anchor 与换号指引（registry 读，不碰 gh）', () => {
  const repo = tmpRepo()
  writeRegistry(repo, [rec('CHORE-110', 'cnb#110')])
  const fake = fakeGh()
  const r = withGh(fake, () => markReady({ repo, taskId: 'CHORE-110' }))
  assert.equal(r.ok, false)
  assert.equal(r.code, 'no-anchor')
  assert.match(r.reason, /先换取正式号/)
  assert.equal(fake.calls.length, 0, 'no-anchor 判定不得调用 gh')
})

test('markReady：登记册无此任务 → no-task（registry 读，不碰 gh）', () => {
  const repo = tmpRepo()
  writeRegistry(repo, [])
  const fake = fakeGh()
  const r = withGh(fake, () => markReady({ repo, taskId: 'FIX-999' }))
  assert.equal(r.code, 'no-task')
  assert.equal(fake.calls.length, 0)
})

test('claimIssue：无锚点任务 → no-anchor 显著告警（registry 读，不碰 gh）', () => {
  const repo = tmpRepo()
  writeRegistry(repo, [rec('LOC-020', 'none')])
  const fake = fakeGh()
  const r = withGh(fake, () => claimIssue({ repo, taskId: 'LOC-020', runId: 'loc-020-r1' }))
  assert.equal(r.code, 'no-anchor')
  assert.match(r.reason, /无 github#N 锚点/)
  assert.equal(fake.calls.length, 0)
})

// ───────────── 写入口 fail-closed：有效锚点也不写、不探测、不 gh ─────────────

test('markReady：有 github 锚点也 fail-closed → legacy_github_issue_write_disabled，0 次 gh、不打标', () => {
  const repo = tmpRepo()
  writeRegistry(repo, [rec('FIX-224', 'github#224')])
  const fake = fakeGh()
  const r = withGh(fake, () => markReady({ repo, taskId: 'FIX-224' }))
  assert.equal(r.ok, false)
  assert.equal(r.code, DISABLED)
  assert.equal(r.code, LEGACY_GITHUB_ISSUE_WRITE_DISABLED, '导出常量须与稳定码字面一致')
  assert.match(r.reason, /停用/)
  assert.equal(fake.calls.length, 0, '写入口停用后不得调用 gh（不探测、不打标）')
  assert.deepEqual(fake.issue(224).labels, [], '远端标签不得被改动')
})

test('markReady：dry-run 同样 fail-closed（入口已停用，不存在可预演的写入）', () => {
  const repo = tmpRepo()
  writeRegistry(repo, [rec('FIX-224', 'github#224')])
  const fake = fakeGh()
  const r = withGh(fake, () => markReady({ repo, taskId: 'FIX-224', dryRun: true }))
  assert.equal(r.ok, false)
  assert.equal(r.code, DISABLED)
  assert.equal(fake.calls.length, 0)
})

test('markReady：双锚点任务（cnb#111 + github#215）也 fail-closed', () => {
  const repo = tmpRepo()
  writeRegistry(repo, [rec('CHORE-111', 'cnb#111 + github#215')])
  const fake = fakeGh()
  const r = withGh(fake, () => markReady({ repo, taskId: 'CHORE-111' }))
  assert.equal(r.code, DISABLED)
  assert.equal(fake.calls.length, 0)
  assert.deepEqual(fake.issue(215).labels, [])
})

test('claimIssue：fail-closed → 0 次 gh，不打「施工中」、不指派、不留评论', () => {
  const repo = tmpRepo()
  writeRegistry(repo, [rec('FIX-224', 'github#224')])
  const fake = fakeGh()
  const r = withGh(fake, () => claimIssue({ repo, taskId: 'FIX-224', runId: 'fix-224-r1', branch: 'dev-fix-224-r1', actor: 'tester' }))
  assert.equal(r.ok, false)
  assert.equal(r.code, DISABLED)
  assert.match(r.reason, /Multica/, '原因须指向 Multica 单写者把关')
  assert.equal(fake.calls.length, 0)
  const it = fake.issue(224)
  assert.deepEqual(it.labels, [], '不得打施工中')
  assert.deepEqual(it.assignees, [], '不得指派')
  assert.equal(it.comments.length, 0, '不得留认领评论')
})

test('claimIssue：重复调用始终拒绝，不落任何现场', () => {
  const repo = tmpRepo()
  writeRegistry(repo, [rec('FIX-224', 'github#224')])
  const fake = fakeGh()
  const args = { repo, taskId: 'FIX-224', runId: 'fix-224-r1', actor: 'tester' }
  const a = withGh(fake, () => claimIssue(args))
  const b = withGh(fake, () => claimIssue(args))
  assert.equal(a.code, DISABLED)
  assert.equal(b.code, DISABLED)
  assert.equal(fake.calls.length, 0)
  assert.equal(fake.issue(224).comments.length, 0)
})

test('claimIssue：issue 已关闭 → 仍走 fail-closed（不再为读状态而调用 gh）', () => {
  const repo = tmpRepo()
  writeRegistry(repo, [rec('FIX-224', 'github#224')])
  const fake = fakeGh()
  fake.issue(224).state = 'CLOSED'
  const r = withGh(fake, () => claimIssue({ repo, taskId: 'FIX-224', runId: 'fix-224-r1', actor: 'tester' }))
  assert.equal(r.code, DISABLED)
  assert.equal(fake.calls.length, 0, '不得为判断关闭状态而先探测 gh')
})

test('claimIssue：既有「施工中」标签与他人认领标记也原样保留，不被覆盖', () => {
  const repo = tmpRepo()
  writeRegistry(repo, [rec('FIX-224', 'github#224')])
  const fake = fakeGh()
  fake.issue(224).labels.push(WIP_LABEL)
  fake.issue(224).comments.push({ body: `认领 <!-- wip-claim:otherhost/fix-224-r2 -->`, author: { login: 'other' }, createdAt: '2026-01-01T00:00:00Z' })
  const r = withGh(fake, () => claimIssue({ repo, taskId: 'FIX-224', runId: 'fix-224-r1', actor: 'tester' }))
  assert.equal(r.code, DISABLED)
  assert.equal(fake.calls.length, 0)
  assert.ok(fake.issue(224).labels.includes(WIP_LABEL), '停用入口不得改动远端既有标签/评论')
  assert.equal(fake.issue(224).comments.length, 1)
})

test('releaseIssue：fail-closed → 0 次 gh，不摘标签、不摘 assignee、不留结束评论', () => {
  const repo = tmpRepo()
  writeRegistry(repo, [rec('FIX-224', 'github#224')])
  const fake = fakeGh()
  fake.issue(224).labels.push(READY_LABEL, WIP_LABEL)
  fake.issue(224).assignees.push('tester')
  fake.issue(224).comments.push({ body: `认领 ${claimMarker('m1/fix-224-r1')}`, author: { login: 'tester' }, createdAt: '2026-01-01T00:00:00Z' })
  const r = withGh(fake, () => releaseIssue({ repo, taskId: 'FIX-224', runId: 'fix-224-r1', reason: '收口', actor: 'tester' }))
  assert.equal(r.ok, false)
  assert.equal(r.code, DISABLED)
  assert.equal(fake.calls.length, 0)
  const it = fake.issue(224)
  assert.ok(it.labels.includes(WIP_LABEL), '不得摘施工中')
  assert.deepEqual(it.assignees, ['tester'], '不得摘 assignee')
  assert.equal(it.comments.length, 1, '不得留结束评论')
})

test('releaseIssue：无锚点任务 → no-anchor（registry 读，不碰 gh）', () => {
  const repo = tmpRepo()
  writeRegistry(repo, [rec('LOC-020', 'none')])
  const fake = fakeGh()
  const r = withGh(fake, () => releaseIssue({ repo, taskId: 'LOC-020', runId: 'loc-020-r1' }))
  assert.equal(r.code, 'no-anchor')
  assert.equal(fake.calls.length, 0)
})

test('审查回归①：已关闭的 issue 也不得被打「可施工」标签（现由 fail-closed 保证）', () => {
  const repo = tmpRepo()
  writeRegistry(repo, [rec('FIX-224', 'github#224')])
  const fake = fakeGh()
  fake.issue(224).state = 'CLOSED'
  const r = withGh(fake, () => markReady({ repo, taskId: 'FIX-224' }))
  assert.equal(r.ok, false)
  assert.equal(r.code, DISABLED)
  assert.deepEqual(fake.issue(224).labels, [], '关闭的 issue 不应被打标')
  assert.equal(fake.calls.length, 0)
})

test('gh 不可达时：读动作抛错、写入口 fail-closed（拒绝而非崩溃）', () => {
  const repo = tmpRepo()
  writeRegistry(repo, [rec('FIX-224', 'github#224')])
  setGhRunner(() => { throw new Error('gh: To use GitHub in the CLI, run `gh auth login`') })
  try {
    assert.throws(() => fetchTaskSource({ repo }), /gh auth login/, '读动作仍按原口径抛错')
    const r = markReady({ repo, taskId: 'FIX-224' })
    assert.equal(r.code, DISABLED, '写入口在 gh 不可达时也应拒绝而非抛错')
  } finally {
    setGhRunner(null)
  }
})

// ───────────── CLI：非零退出、不调用 gh、registry/BOARD 前后哈希不变 ─────────────

for (const [cmd, extra] of [
  ['mark-ready', ['--task', 'FIX-224']],
  ['claim', ['--task', 'FIX-224', '--run-id', 'fix-224-r1']],
  ['release', ['--task', 'FIX-224', '--run-id', 'fix-224-r1', '--reason', '收口']],
]) {
  test(`CLI ${cmd}：fail-closed → 非零退出、稳定原因码、0 次 gh、registry/BOARD 哈希不变`, () => {
    const repo = tmpRepo()
    writeRegistry(repo, [rec('FIX-224', 'github#224')])
    const board = path.join(repo, 'docs/tasks/BOARD.md')
    fs.writeFileSync(board, '# BOARD\n- FIX-224\n')
    const before = { reg: sha256(path.join(repo, 'docs/tasks/registry.json')), board: sha256(board) }
    const ghBin = fakeGhBin()

    const r = runCli([cmd, ...extra, '--repo', repo], repo, ghBin)
    assert.notEqual(r.status, 0, 'CLI 须非零退出')
    const out = JSON.parse(r.stdout)
    assert.equal(out.ok, false)
    assert.equal(out.code, DISABLED)

    assert.equal(ghBin.callCount(), 0, `CLI ${cmd} 不得调用 gh`)
    const after = { reg: sha256(path.join(repo, 'docs/tasks/registry.json')), board: sha256(board) }
    assert.equal(after.reg, before.reg, 'registry.json 前后 SHA-256 不变')
    assert.equal(after.board, before.board, 'BOARD.md 前后 SHA-256 不变')
  })
}

test('CLI list-ready / show：只读命令仍可运行（不因写入口停用而被误关）', () => {
  const repo = tmpRepo()
  writeRegistry(repo, [rec('FIX-224', 'github#224')])
  const ghBin = fakeGhBin()
  // fake gh 对 issue list/view 返回空数组/无数据即可；这里只验证 CLI 未因停用写入口而拒绝只读子命令。
  fs.writeFileSync(path.join(ghBin.bin, 'gh'), '#!/bin/sh\nif [ "$1" = "issue" ] && [ "$2" = "list" ]; then echo "[]"; exit 0; fi\nif [ "$1" = "issue" ] && [ "$2" = "view" ]; then echo "[]"; exit 0; fi\nexit 0\n')
  fs.chmodSync(path.join(ghBin.bin, 'gh'), 0o755)
  const listed = runCli(['list-ready', '--repo', repo], repo, ghBin)
  assert.equal(listed.status, 0, `list-ready 应成功：${listed.stderr}`)
  const shown = runCli(['show', '--task', 'FIX-224', '--repo', repo], repo, ghBin)
  assert.equal(shown.status, 0, `show 应成功：${shown.stderr}`)
  assert.equal(JSON.parse(shown.stdout).issue, 224)
})
