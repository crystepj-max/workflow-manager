// LOC-007：批次状态机直测（fill 短路/补位、释放三态、非法释放、autoPhaseDone）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBatchState, fillCapacity, applyRelease, autoPhaseDone } from '../ai-task-execution-plan.mjs'

const snap = (ids) => ids.map((id) => ({ id, name: '任务' + id, priority: 'P2', definedAt: '2026-01-0' + ids.indexOf(id) + 'T00:00:00Z' }))
const nowIso = (() => {
  let n = 0
  return () => '2026-01-01T00:00:0' + (n++) + 'Z'
})()

function freshState(ids = ['A', 'B', 'C'], maxConcurrency = 2) {
  return createBatchState({ name: 't', maxConcurrency, startedAt: '2026-01-01T00:00:00Z', snapshot: snap(ids) })
}

test('fillCapacity：按并发上限补位并记录启动日志', () => {
  const s = freshState(['A', 'B', 'C'], 2)
  fillCapacity(s, nowIso)
  assert.deepEqual([...s.running.keys()], ['A', 'B'])
  assert.deepEqual(s.queue, ['C'])
  assert.equal(s.running.get('A').runStatus, 'RUNNING')
  assert.equal(s.launchLog.filter((e) => e.action === 'launch').length, 2)
})

test('fillCapacity：queue 为空时短路', () => {
  const s = freshState(['A'], 2)
  fillCapacity(s, nowIso)
  const before = JSON.stringify(s.launchLog)
  fillCapacity(s, nowIso)
  assert.equal(JSON.stringify(s.launchLog), before)
})

test('applyRelease：三态路由 WAITING_HUMAN / BLOCKED / COMPLETED', () => {
  const s = freshState(['A', 'B', 'C'], 3)
  fillCapacity(s, nowIso)
  assert.equal(applyRelease(s, { op: 'release', taskId: 'A', to: 'WAITING_HUMAN', uatHint: 'x' }).handled, true)
  assert.equal(applyRelease(s, { op: 'release', taskId: 'B', to: 'BLOCKED', blockedNode: 'dev', reason: '受阻' }).handled, true)
  assert.equal(applyRelease(s, { op: 'release', taskId: 'C', to: 'COMPLETED' }).handled, true)
  assert.equal(s.waiting[0].id, 'A')
  assert.equal(s.blocked[0].blockedNode, 'dev')
  assert.equal(s.completed[0].id, 'C')
  assert.equal(s.launchLog.filter((e) => e.action === 'release').length, 3)
})

test('applyRelease：指向不在 RUNNING 的任务返回 not-running 且不改状态', () => {
  const s = freshState(['A'], 1)
  fillCapacity(s, nowIso)
  const before = JSON.stringify({ w: s.waiting, b: s.blocked, c: s.completed, l: s.launchLog })
  const r = applyRelease(s, { op: 'release', taskId: 'GHOST', to: 'COMPLETED' })
  assert.deepEqual(r, { handled: false, reason: 'not-running' })
  assert.equal(JSON.stringify({ w: s.waiting, b: s.blocked, c: s.completed, l: s.launchLog }), before)
})

test('applyRelease：未知释放状态返回 unknown-status，不入列不记日志', () => {
  const s = freshState(['A'], 1)
  fillCapacity(s, nowIso)
  const r = applyRelease(s, { op: 'release', taskId: 'A', to: 'WHATEVER' })
  assert.deepEqual(r, { handled: false, reason: 'unknown-status' })
  assert.equal(s.waiting.length + s.blocked.length + s.completed.length, 0)
  assert.equal(s.running.has('A'), false, '任务已离开 RUNNING（与现行为一致：先删后路由）')
})

test('autoPhaseDone：RUNNING 与 queue 清空后才为真', () => {
  const s = freshState(['A', 'B'], 1)
  fillCapacity(s, nowIso)
  assert.equal(autoPhaseDone(s), false)
  applyRelease(s, { op: 'release', taskId: 'A', to: 'COMPLETED' })
  fillCapacity(s, nowIso)
  applyRelease(s, { op: 'release', taskId: 'B', to: 'COMPLETED' })
  assert.equal(autoPhaseDone(s), true)
})

test('fillCapacity：释放后补位拉起排队任务', () => {
  const s = freshState(['A', 'B', 'C'], 2)
  fillCapacity(s, nowIso)
  applyRelease(s, { op: 'release', taskId: 'A', to: 'COMPLETED' })
  fillCapacity(s, nowIso)
  assert.deepEqual([...s.running.keys()], ['B', 'C'])
  assert.equal(s.queue.length, 0)
})
