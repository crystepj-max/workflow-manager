import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  nextSeq,
  formatId,
  slugify,
  newRecord,
  applyUpdate,
  renderBoard,
  loadRegistry,
  saveRegistry,
  allocate,
  update,
  writeBoard,
} from '../local-task-registry.mjs'

function tmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loc-registry-'))
}

test('nextSeq / formatId：序号递增且三位补零', () => {
  assert.equal(nextSeq([]), 1)
  assert.equal(nextSeq([{ task_id: 'LOC-001' }]), 2)
  assert.equal(nextSeq([{ task_id: 'LOC-001' }, { task_id: 'LOC-009' }]), 10)
  assert.equal(formatId(7), 'LOC-007')
  assert.equal(formatId(123), 'LOC-123')
  // 非法标识不参与取最大值
  assert.equal(nextSeq([{ task_id: '#123' }, { task_id: 'LOC-002' }]), 3)
})

test('slugify：中文与空格转连字符', () => {
  assert.equal(slugify('修好登录按钮'), 'task')
  assert.equal(slugify('Fix Login Button'), 'fix-login-button')
  assert.equal(slugify(''), 'task')
})

test('newRecord：默认本地轨道字段', () => {
  const r = newRecord({ seq: 1, name: 'Fix Login', source: '本地文档', sourceRef: 'docs/req/login.md' })
  assert.equal(r.task_id, 'LOC-001')
  assert.equal(r.status, '定义中')
  assert.equal(r.github_sync, 'pending')
  assert.equal(r.source, '本地文档')
  assert.throws(() => newRecord({ seq: 1, name: '' }), /任务名称必填/)
})

test('applyUpdate：只允许白名单字段，自动更新时间', () => {
  const r = newRecord({ seq: 1, name: 'x', now: '2026-01-01T00:00:00Z' })
  const next = applyUpdate(r, { status: '本地已定义', branch: 'dev-loc-001-r1', 不存在字段: 'zzz' })
  assert.equal(next.status, '本地已定义')
  assert.equal(next.branch, 'dev-loc-001-r1')
  assert.equal(next.不存在字段, undefined)
  assert.notEqual(next.updated_at, '2026-01-01T00:00:00Z')
  // null 不覆盖已有值
  assert.equal(applyUpdate(next, { status: null }).status, '本地已定义')
})

test('applyUpdate：merge_commit 写入 merge 结构', () => {
  const r = newRecord({ seq: 1, name: 'x' })
  const next = applyUpdate(r, { merge_commit: 'abc123' })
  assert.equal(next.merge.commit, 'abc123')
  assert.ok(next.merge.merged_at)
})

test('renderBoard：按状态分组，未知状态归入其他', () => {
  const tasks = [
    newRecord({ seq: 1, name: 'A' }),
    { ...newRecord({ seq: 2, name: 'B' }), status: '本地已定义' },
    { ...newRecord({ seq: 3, name: 'C' }), status: '莫名其妙状态' },
  ]
  const md = renderBoard(tasks)
  assert.match(md, /## 定义中（1）/)
  assert.match(md, /## 本地已定义（1）/)
  assert.match(md, /## 其他（1）/)
  assert.match(md, /LOC-001/)
  assert.match(renderBoard([]), /暂无任务/)
})

test('登记册读写往返：分配两个任务并落盘', () => {
  const repo = tmpRepo()
  const a = allocate(repo, { name: '任务甲', source: '会话录入' })
  const b = allocate(repo, { name: '任务乙', source: '本地文档', sourceRef: 'docs/req/b.md' })
  assert.equal(a.task_id, 'LOC-001')
  assert.equal(b.task_id, 'LOC-002')

  const reg = loadRegistry(repo)
  assert.equal(reg.tasks.length, 2)

  const updated = update(repo, 'LOC-001', { status: '本地已定义', branch: 'dev-loc-001-r1' })
  assert.equal(updated.status, '本地已定义')
  assert.equal(loadRegistry(repo).tasks[0].branch, 'dev-loc-001-r1')

  assert.throws(() => update(repo, 'LOC-999', { status: '已合并' }), /任务不存在/)
})

test('登记册落盘路径固定为 docs/tasks/registry.json 且可入库', () => {
  const repo = tmpRepo()
  allocate(repo, { name: '任务甲' })
  const p = path.join(repo, 'docs', 'tasks', 'registry.json')
  assert.ok(fs.existsSync(p))
  // 能被 JSON 解析（不是带注释的文本）
  assert.equal(JSON.parse(fs.readFileSync(p, 'utf-8')).tasks[0].task_id, 'LOC-001')
})

test('writeBoard：生成看板文件', () => {
  const repo = tmpRepo()
  allocate(repo, { name: '任务甲' })
  allocate(repo, { name: '任务乙' })
  const p = writeBoard(repo)
  assert.equal(p, path.join(repo, 'docs', 'tasks', 'BOARD.md'))
  assert.match(fs.readFileSync(p, 'utf-8'), /LOC-002/)
})

test('saveRegistry：空目录自动创建 docs/tasks', () => {
  const repo = tmpRepo()
  const p = saveRegistry(repo, { version: 1, tasks: [] })
  assert.ok(fs.existsSync(p))
  assert.deepEqual(loadRegistry(repo).tasks, [])
})
