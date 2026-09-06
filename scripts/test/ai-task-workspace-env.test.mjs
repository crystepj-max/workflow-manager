import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  planDeliveryWorkspace,
  resolveDeliveryWorkspace,
  markTaskCompleted,
  maybeCleanupEnv,
  allMembersCompleted,
} from '../ai-task-workspace-env.mjs'

function tmpStore() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ai-task-env-'))
}

test('独立任务：计划创建新环境', () => {
  const plan = planDeliveryWorkspace({
    taskId: '120',
    envId: '120',
    role: '独立',
    deps: [],
    existingEnv: null,
  })
  assert.equal(plan.action, 'create')
})

test('成员任务：环境未建则受阻', () => {
  const plan = planDeliveryWorkspace({
    taskId: '121',
    envId: '120',
    role: '成员',
    deps: ['120'],
    existingEnv: null,
  })
  assert.equal(plan.action, 'block')
  assert.match(plan.reason, /尚未建立/)
})

test('父子串行：父未完成时子受阻；父完成后可沿用', () => {
  const store = tmpStore()
  const created = resolveDeliveryWorkspace({
    storeDir: store,
    taskId: '120',
    envId: '120',
    role: '独立',
    deps: [],
    skipGit: true,
    work_root: path.join(store, 'work'),
  })
  assert.equal(created.ok, true)
  assert.equal(created.action, 'create')

  const blocked = resolveDeliveryWorkspace({
    storeDir: store,
    taskId: '121',
    envId: '120',
    role: '成员',
    deps: ['120'],
    skipGit: true,
  })
  assert.equal(blocked.ok, false)
  assert.match(blocked.reason, /串行等待/)

  markTaskCompleted(store, '120', '120')
  const reused = resolveDeliveryWorkspace({
    storeDir: store,
    taskId: '121',
    envId: '120',
    role: '成员',
    deps: ['120'],
    skipGit: true,
  })
  assert.equal(reused.ok, true)
  assert.equal(reused.action, 'reuse')
  assert.equal(reused.work_branch, created.work_branch)
  assert.equal(reused.source_path, created.source_path)
})

test('全员验收通过后才清理', () => {
  const store = tmpStore()
  resolveDeliveryWorkspace({
    storeDir: store,
    taskId: '120',
    envId: 'group-a',
    role: '独立',
    skipGit: true,
    work_root: path.join(store, 'work'),
  })
  markTaskCompleted(store, 'group-a', '120')
  resolveDeliveryWorkspace({
    storeDir: store,
    taskId: '121',
    envId: 'group-a',
    role: '成员',
    deps: ['120'],
    skipGit: true,
  })

  const early = maybeCleanupEnv(store, 'group-a')
  assert.equal(early.cleaned, false)
  assert.ok(early.pending.includes('121'))

  markTaskCompleted(store, 'group-a', '121')
  assert.equal(allMembersCompleted(JSON.parse(fs.readFileSync(path.join(store, 'group-a.json'), 'utf8'))), true)
  const done = maybeCleanupEnv(store, 'group-a')
  assert.equal(done.cleaned, true)
})
