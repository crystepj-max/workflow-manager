import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { loadRegistry, saveRegistry } from '../local-task-registry.mjs'
import { collectMergeFacts, reconcilePlan } from '../registry-reconcile.mjs'

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
