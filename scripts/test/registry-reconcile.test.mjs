import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { loadRegistry, saveRegistry } from '../local-task-registry.mjs'
import { collectLocalConstructionSignals, collectMergeFacts, issueNumberOf, reconcilePlan, unclaimedConstructionAlerts } from '../registry-reconcile.mjs'

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chore-73-'))
  execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main'])
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com'])
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'test'])
  return dir
}

function commit(repo, message) {
  const f = path.join(repo, `f-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.txt`)
  fs.writeFileSync(f, message)
  execFileSync('git', ['-C', repo, 'add', '-A'])
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', message])
  return execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
}

test('collectMergeFacts：从提交信息尾部与收口标签推导合并事实', () => {
  const repo = tmpRepo()
  const c1 = commit(repo, 'feat: 编辑器适配 (LOC-023 V2)')
  commit(repo, 'docs: 无任务号的普通提交')
  const c3 = commit(repo, 'fix: 修复收口 (FEAT-12 V1)')
  const facts = collectMergeFacts(repo, 'main')
  assert.equal(facts.get('LOC-023').commit, c1)
  assert.equal(facts.get('FEAT-12').commit, c3)
  assert.equal(facts.has('LOC-999'), false)
})

test('collectMergeFacts：收口标签也是合并事实', () => {
  const repo = tmpRepo()
  commit(repo, 'feat: 某任务')
  execFileSync('git', ['-C', repo, 'tag', 'task/loc-030/v1'])
  const facts = collectMergeFacts(repo, 'main')
  assert.ok(facts.get('LOC-030'), '标签 task/loc-030/v1 应推导出 LOC-030 已合并')
})

test('reconcilePlan：登记落后于 git 事实 → 进入 toMerge', () => {
  const repo = tmpRepo()
  commit(repo, 'feat: 已合并任务 (LOC-024 V1)')
  const reg = { version: 1, revision: 0, tasks: [
    { task_id: 'LOC-024', status: '交付中', remote: null },
    { task_id: 'LOC-099', status: '定义中', remote: null },
  ] }
  fs.mkdirSync(path.join(repo, 'docs', 'tasks'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'docs', 'tasks', 'registry.json'), JSON.stringify(reg, null, 2))
  const r = reconcilePlan(repo, 'main')
  assert.equal(r.toMerge.length, 1)
  assert.equal(r.toMerge[0].task_id, 'LOC-024')
})

test('saveRegistry 乐观锁：另一会话先写，本会话写回必须被拒', () => {
  const repo = tmpRepo()
  fs.mkdirSync(path.join(repo, 'docs', 'tasks'), { recursive: true })
  const regA = { version: 1, revision: 0, tasks: [{ task_id: 'LOC-001', status: '定义中' }] }
  fs.writeFileSync(path.join(repo, 'docs', 'tasks', 'registry.json'), JSON.stringify(regA, null, 2))
  // 会话 A 与会话 B 同时读入 revision=0
  const a = loadRegistry(repo)
  const b = loadRegistry(repo)
  a.tasks[0].status = '等待验收'
  saveRegistry(repo, a) // A 先写 → revision 变 1
  b.tasks[0].status = '已合并'
  assert.throws(() => saveRegistry(repo, b), /已被其他会话更新.*拒绝覆盖/, 'B 的旧视图必须被拒')
  // B 重读后可正常写入
  const b2 = loadRegistry(repo)
  b2.tasks[0].status = '已合并'
  saveRegistry(repo, b2)
  assert.equal(loadRegistry(repo).tasks[0].status, '已合并')
})

test('saveRegistry：正常读写路径 revision 递增不抛错', () => {
  const repo = tmpRepo()
  fs.mkdirSync(path.join(repo, 'docs', 'tasks'), { recursive: true })
  const reg = loadRegistry(repo)
  reg.tasks.push({ task_id: 'LOC-001', status: '定义中' })
  saveRegistry(repo, reg)
  assert.equal(loadRegistry(repo).revision, 1)
})

// ----- 漏标校验（2026-09-21 重复施工事故回归）-----

test('issueNumberOf：认 GitHub 锚点，双锚点取 GitHub 侧，cnb 等非 GitHub 锚点不误报', () => {
  assert.equal(issueNumberOf({ remote: 'GitHub #233' }), 233)
  assert.equal(issueNumberOf({ remote: 'github#230' }), 230)
  assert.equal(issueNumberOf({ remote: 'cnb#111 + github#215' }), 215, '双锚点必须取 GitHub 侧')
  assert.equal(issueNumberOf({ remote: null, github_sync: 'synced#208' }), 208)
  assert.equal(issueNumberOf({ remote: 'cnb#36', github_sync: 'pending' }), null)
  assert.equal(issueNumberOf({ remote: 'cnb#36', github_sync: 'synced#233' }), 233, 'remote 无 GitHub 时回退 sync')
  assert.equal(issueNumberOf({}), null)
})

test('collectLocalConstructionSignals：worktree 施工分支与 .agent-runs 都是痕迹，已合并任务过滤', () => {
  const repo = tmpRepo()
  commit(repo, 'init')
  const reg = { version: 1, revision: 0, tasks: [
    { task_id: 'FIX-233', status: '已定义' },
    { task_id: 'FIX-234', status: '已合并' },
    { task_id: 'FIX-235', status: '已定义' },
  ] }
  fs.mkdirSync(path.join(repo, 'docs', 'tasks'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'docs', 'tasks', 'registry.json'), JSON.stringify(reg, null, 2))
  // 施工 worktree：分支含任务号且有独立提交（未并入 main）
  const wt = path.join(repo, '..', `wt-${path.basename(repo)}-233`)
  execFileSync('git', ['-C', repo, 'worktree', 'add', '-b', 'dev-fix-233-r1', wt])
  fs.writeFileSync(path.join(wt, 'w.txt'), 'work')
  execFileSync('git', ['-C', wt, 'add', '-A'])
  execFileSync('git', ['-C', wt, 'commit', '-q', '-m', 'wip fix(vwf): 施工中'])
  // .agent-runs 运行目录
  fs.mkdirSync(path.join(repo, '.agent-runs', 'fix-235-r1'), { recursive: true })
  // docs 定义分支不算施工痕迹
  execFileSync('git', ['-C', repo, 'branch', 'docs/fix233-defined'])

  const signals = collectLocalConstructionSignals(repo, reg, 'main')
  assert.ok(signals.get('FIX-233').some((e) => e.includes('dev-fix-233-r1')), 'worktree 分支应计为 FIX-233 痕迹')
  assert.ok(signals.get('FIX-235').some((e) => e.includes('.agent-runs/fix-235-r1')), '运行目录应计为 FIX-235 痕迹')
  assert.equal(signals.has('FIX-234'), false, '已合并任务不计痕迹')
})

test('unclaimedConstructionAlerts：痕迹+无标签告警；已认领/远端不可用不告警', () => {
  const repo = tmpRepo()
  commit(repo, 'init')
  const reg = { version: 1, revision: 0, tasks: [
    { task_id: 'FIX-233', status: '已定义', remote: 'github#233' },
    { task_id: 'FIX-234', status: '已定义', remote: 'github#234' },
    { task_id: 'FIX-235', status: '已定义', remote: 'cnb#999' },
  ] }
  fs.mkdirSync(path.join(repo, 'docs', 'tasks'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'docs', 'tasks', 'registry.json'), JSON.stringify(reg, null, 2))
  fs.mkdirSync(path.join(repo, '.agent-runs', 'fix-233-r1'), { recursive: true })
  fs.mkdirSync(path.join(repo, '.agent-runs', 'fix-234-r1'), { recursive: true })
  fs.mkdirSync(path.join(repo, '.agent-runs', 'fix-235-r1'), { recursive: true })

  const none = unclaimedConstructionAlerts({ repo, registry: reg, listWip: () => new Set() })
  assert.equal(none.alerts.length, 2, '233/234 告警；235 无 GitHub 锚点不管')
  assert.ok(none.alerts[0].note.includes('施工中'))

  const claimed = unclaimedConstructionAlerts({ repo, registry: reg, listWip: () => new Set([233, 234]) })
  assert.equal(claimed.alerts.length, 0, '远端已认领不告警')

  const down = unclaimedConstructionAlerts({ repo, registry: reg, listWip: () => null })
  assert.equal(down.alerts.length, 0)
  assert.equal(down.skipped, true, '远端不可用降级跳过，不误报')
})

test('reconcilePlan：漏标告警并入 suspicious，可注入 listWip', () => {
  const repo = tmpRepo()
  commit(repo, 'feat: 已合并任务 (LOC-024 V1)')
  const reg = { version: 1, revision: 0, tasks: [
    { task_id: 'LOC-024', status: '交付中' },
    { task_id: 'FIX-233', status: '已定义', remote: 'github#233' },
  ] }
  fs.mkdirSync(path.join(repo, 'docs', 'tasks'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'docs', 'tasks', 'registry.json'), JSON.stringify(reg, null, 2))
  fs.mkdirSync(path.join(repo, '.agent-runs', 'fix-233-r1'), { recursive: true })

  const r = reconcilePlan(repo, 'main', { listWip: () => new Set() })
  assert.equal(r.toMerge.length, 1)
  const leaked = r.suspicious.find((s) => s.task_id === 'FIX-233')
  assert.ok(leaked, '漏标任务应进入 suspicious')
  assert.ok(leaked.note.includes('认领信号缺失'))
})
