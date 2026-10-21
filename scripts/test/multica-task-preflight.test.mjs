import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runMulticaTaskPreflight } from '../multica-task-preflight.mjs'
import { readMulticaTask } from '../multica-task-source.mjs'

const PROFILE = 'desktop-api.multica.ai'
const WORKSPACE = 'workspace-1'
const MAIN_ID = 'task-main'
const DEP_ID = 'task-dependency'

function fixture({ dependencyStatus = 'done', dependencyCategory = 'done', mainStatus = 'todo', mainCategory = 'todo', metadata = true } = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'multica-task-preflight-'))
  fs.mkdirSync(path.join(repo, 'docs', 'specs'), { recursive: true })
  const specRef = 'docs/specs/task-spec-V1.md'
  fs.writeFileSync(path.join(repo, specRef), '# Task V1\n\n**版本**：V1\n\n未决产品事项：0\n')
  fs.writeFileSync(path.join(repo, 'docs/specs/definition-check.md'), '# Definition Check\n\n| 未决产品事项 | 0 |\n\n- [x] 全部通过\n')

  const tasks = {
    [MAIN_ID]: {
      id: MAIN_ID,
      identifier: 'WFM-900',
      workspace_id: WORKSPACE,
      project_id: 'workflow-manager-project',
      assignee_id: 'agent-1',
      assignee_type: 'agent',
      status: mainStatus,
      status_category: mainCategory,
      priority: 'high',
      metadata: metadata
        ? {
            'dev-flow.definition.v1': JSON.stringify({
              definition_status: 'defined',
              baseline_version: 'V1',
              unattended: true,
              env_group: 'group-1',
              env_role: 'independent',
              pending_product_decisions: 0,
              spec_ref: specRef,
            }),
            'dev-flow.dependencies.v1': JSON.stringify([DEP_ID]),
          }
        : {},
    },
    [DEP_ID]: {
      id: DEP_ID,
      identifier: 'WFM-899',
      workspace_id: WORKSPACE,
      project_id: 'another-project',
      status: dependencyStatus,
      status_category: dependencyCategory,
      metadata: {},
    },
  }
  const calls = []
  const execFileSync = (_command, args) => {
    calls.push(args)
    const issueIndex = args.indexOf('issue')
    assert.notEqual(issueIndex, -1)
    assert.equal(args[issueIndex + 1], 'get')
    const id = args[issueIndex + 2]
    if (!tasks[id]) {
      const error = new Error('not found')
      error.status = 1
      throw error
    }
    return JSON.stringify(tasks[id])
  }
  return { repo, tasks, calls, execFileSync }
}

function opts(f) {
  return { repo: f.repo, profile: PROFILE, workspaceId: WORKSPACE, execFileSync: f.execFileSync }
}

test('current construction preflight reads Multica task, project, assignee, definition and dependencies', async () => {
  const f = fixture()
  const result = await runMulticaTaskPreflight(MAIN_ID, opts(f))
  assert.equal(result.ok, true, JSON.stringify(result.failures))
  assert.equal(result.fields.source, 'multica')
  assert.equal(result.fields.identifier, 'WFM-900')
  assert.equal(result.fields.status, 'todo')
  assert.equal(result.fields.project_id, 'workflow-manager-project')
  assert.equal(result.fields.assignee_id, 'agent-1')
  assert.equal(result.fields.dependency_statuses[0].status_category, 'done')
  assert.equal(f.calls.length, 2, '主任务与依赖都必须从 Multica 读取')
  for (const args of f.calls) {
    assert.ok(args.includes('--profile') && args.includes(PROFILE))
    assert.ok(args.includes('--workspace-id') && args.includes(WORKSPACE))
  }
})

test('missing Multica metadata blocks even when a legacy registry says the task is ready', async () => {
  const f = fixture({ metadata: false })
  const registryPath = path.join(f.repo, 'docs/tasks/registry.json')
  fs.mkdirSync(path.dirname(registryPath), { recursive: true })
  const registry = { tasks: [{ task_id: 'WFM-900', status: '已定义', dependencies: [] }] }
  fs.writeFileSync(registryPath, JSON.stringify(registry))

  const result = await runMulticaTaskPreflight(MAIN_ID, opts(f))
  assert.equal(result.ok, false)
  assert.ok(result.reasons.some((reason) => reason.code === 'MULTICA_METADATA_MISSING'))
  assert.equal(f.calls.length, 1)
  assert.deepEqual(JSON.parse(fs.readFileSync(registryPath, 'utf8')), registry, '旧登记册仅被保留，未被读取或写入')
})

test('dependency must be done in both Multica status fields', async () => {
  const f = fixture({ dependencyStatus: 'done', dependencyCategory: 'in_progress' })
  const result = await runMulticaTaskPreflight(MAIN_ID, opts(f))
  assert.equal(result.ok, false)
  assert.ok(result.reasons.some((reason) => reason.code === 'MULTICA_DEPENDENCY_NOT_DONE'))
})

test('non-startable Multica state and mismatched workspace fail closed', async () => {
  const blocked = fixture({ mainStatus: 'blocked', mainCategory: 'blocked' })
  const blockedResult = await runMulticaTaskPreflight(MAIN_ID, opts(blocked))
  assert.ok(blockedResult.reasons.some((reason) => reason.code === 'MULTICA_TASK_STATUS_NOT_STARTABLE'))

  const mismatch = fixture()
  const original = mismatch.execFileSync
  mismatch.execFileSync = (command, args, options) => {
    const issue = JSON.parse(original(command, args, options))
    issue.workspace_id = 'wrong-workspace'
    return JSON.stringify(issue)
  }
  const mismatchResult = await runMulticaTaskPreflight(MAIN_ID, opts(mismatch))
  assert.ok(mismatchResult.reasons.some((reason) => reason.code === 'MULTICA_WORKSPACE_MISMATCH'))
})

test('Multica profile/workspace are required and CLI failure never falls back to files', () => {
  assert.throws(() => readMulticaTask(MAIN_ID, { profile: PROFILE }), /指定 Multica workspace/)
  assert.throws(() => readMulticaTask(MAIN_ID, { workspaceId: WORKSPACE }), /指定 Multica profile/)
  const f = fixture()
  const unavailable = awaitableError(f)
  assert.equal(unavailable.code, 'MULTICA_UNAVAILABLE')
})

function awaitableError(f) {
  try {
    readMulticaTask(MAIN_ID, {
      profile: PROFILE,
      workspaceId: WORKSPACE,
      execFileSync() { throw new Error('not connected') },
    })
  } catch (error) {
    return error
  }
  throw new Error('expected Multica read to fail')
}
