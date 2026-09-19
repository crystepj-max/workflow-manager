import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const dispatcher = path.join(root, 'scripts/ai-task-dispatcher.mjs')
const fakeAgent = path.join(root, 'scripts/test/fixtures/night-batch/fake-agent.mjs')
const fakeInit = path.join(root, 'scripts/test/fixtures/night-batch/fake-run-init.mjs')
const m3Fixtures = path.join(root, 'scripts/test/fixtures/ai-task-execution-plan-m3')

// 用 M3 同一套 issue/spec 夹具（已通过 preflight），保证候选能走到真实拉起环节
function buildProject({ taskIds, extraTasks = [] }) {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-dispatch-'))
  fs.mkdirSync(path.join(proj, 'docs/tasks'), { recursive: true })
  const tasks = taskIds.map((id, i) => {
    const fx = ['A', 'B', 'C'][i]
    fs.mkdirSync(path.join(proj, '.scratch/specs', id), { recursive: true })
    fs.copyFileSync(path.join(m3Fixtures, fx, 'issue-basics.md'), path.join(proj, 'docs/tasks', `${id}-defined.md`))
    fs.copyFileSync(path.join(m3Fixtures, fx, 'task-spec-V1.md'), path.join(proj, '.scratch/specs', id, 'task-spec-V1.md'))
    // 少了这份，preflight 定义门禁 PREFLIGHT_DEF_CHECK_MISSING 会把候选全部挡在拉起之前
    fs.copyFileSync(path.join(m3Fixtures, fx, 'definition-check.md'), path.join(proj, '.scratch/specs', id, 'definition-check.md'))
    return {
      task_id: id, name: `测试任务${id}`, status: '已定义', slug: 'defined',
      deps: [], env_group: id, env_role: '独立', priority: null,
      spec_path: `.scratch/specs/${id}/task-spec-V1.md`,
    }
  })
  fs.writeFileSync(path.join(proj, 'docs/tasks/registry.json'), JSON.stringify({ version: 1, tasks: [...tasks, ...extraTasks] }, null, 2) + '\n')
  return proj
}

function writeMachine(proj, { plan } = {}) {
  const machine = {
    agent: { templates: { 'full-access': { command: process.execPath, args: [fakeAgent, '{runDir}', '{taskId}'] } } },
    sceneInit: { command: process.execPath, args: [fakeInit, '{runDir}', '{taskId}', '{worktree}'] },
  }
  const p = path.join(proj, '.scratch/night-batches/machine.json')
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(machine, null, 2) + '\n')
  return { machinePath: p, planEnv: plan ? JSON.stringify(plan) : undefined }
}

function writeSchedule(proj, overrides = {}) {
  const schedule = {
    project: proj,
    batchName: overrides.batchName || 'test-batch',
    maxConcurrency: 2,
    permission: 'full-access',
    watchdogMinutes: 1,
    pollMs: 50,
    postValidateCommand: 'node -e "process.exit(0)"',
    machineConfig: '.scratch/night-batches/machine.json',
    ...overrides,
  }
  const p = path.join(proj, 'schedule.json')
  fs.writeFileSync(p, JSON.stringify(schedule, null, 2) + '\n')
  return p
}

function runDispatcher(schedulePath, { args = [], env = {} } = {}) {
  return spawnSync(process.execPath, [dispatcher, schedulePath, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, ...env },
  })
}

function readJsonOut(r) {
  try { return JSON.parse(r.stdout) } catch { return null }
}

test('M5 真实唤起：独立会话并发补位 + 释放契约 + 报告落盘', () => {
  const proj = buildProject({ taskIds: ['FIX-A', 'FIX-B', 'FIX-C'] })
  const { machinePath, planEnv } = writeMachine(proj, {
    plan: {
      'FIX-A': { delayMs: 400, to: 'WAITING_HUMAN' },
      'FIX-B': { delayMs: 400, to: 'BLOCKED' },
      'FIX-C': { delayMs: 150, to: 'COMPLETED' },
    },
  })
  const schedulePath = writeSchedule(proj, { machineConfig: machinePath })
  const probePath = path.join(proj, 'probe.json')

  const r = runDispatcher(schedulePath, {
    args: ['--now'],
    env: { FAKE_AGENT_PLAN: planEnv, FAKE_AGENT_PROBE: probePath },
  })
  const out = readJsonOut(r)
  assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`)
  assert.equal(out.mode, 'real')
  assert.equal(out.autoPhaseDone, true)
  assert.deepEqual([...out.waiting].sort(), ['FIX-A'])
  assert.deepEqual(out.blocked, ['FIX-B'])
  assert.deepEqual(out.completed, ['FIX-C'])
  assert.equal(out.launchOrder.length, 3, '三个任务都被拉起（并发 2，必有补位）')

  // 快照冻结落盘
  const batch = JSON.parse(fs.readFileSync(out.batchJsonPath, 'utf8'))
  assert.equal(batch.candidates.length, 3)
  assert.equal(batch.snapshotVersion, 'm5-v1')

  // 每任务独立会话现场：run 目录 + 释放事件 + 会话日志
  for (const id of ['FIX-A', 'FIX-B', 'FIX-C']) {
    const runDir = path.join(proj, '.agent-runs', `${id.toLowerCase()}-r1`)
    assert.ok(fs.existsSync(path.join(runDir, 'release-event.json')), `${id} 释放事件`)
    assert.ok(fs.existsSync(path.join(runDir, 'session.log')), `${id} 会话日志`)
    assert.ok(fs.existsSync(path.join(runDir, 'session-prompt.md')), `${id} 会话提示词`)
  }

  // 并发不超上限（探针记录峰值）
  const probe = JSON.parse(fs.readFileSync(probePath, 'utf8'))
  assert.ok(probe.max <= 2, `并发峰值 ${probe.max} 超过 maxConcurrency`)

  // 报告：等待验收定位表 + 受阻原因 + 批次卫生
  const report = fs.readFileSync(out.reportPath, 'utf8')
  assert.match(report, /【夜间批次报告】/)
  assert.match(report, /\| FIX-A \|.*dev-fix-a-r1.*uat-card\.md/)
  assert.match(report, /测试注入受阻/)
  assert.match(report, /未纳入（完整清单）/)
  assert.match(report, /npm run validate：通过/)
})

test('M5 看门狗：会话挂起超时被终止并记受阻，名额不泄漏', () => {
  const proj = buildProject({ taskIds: ['FIX-A'] })
  const { machinePath, planEnv } = writeMachine(proj, { plan: { 'FIX-A': { hang: true } } })
  const schedulePath = writeSchedule(proj, { machineConfig: machinePath, watchdogMinutes: 0.03 })

  const t0 = Date.now()
  const r = runDispatcher(schedulePath, { args: ['--now'], env: { FAKE_AGENT_PLAN: planEnv } })
  const elapsed = Date.now() - t0
  const out = readJsonOut(r)
  assert.equal(out.mode, 'real')
  assert.ok(elapsed < 20_000, `看门狗批次耗时 ${elapsed}ms，疑似未终止挂起会话`)
  assert.deepEqual(out.blocked, ['FIX-A'])
  const report = fs.readFileSync(out.reportPath, 'utf8')
  assert.match(report, /看门狗超时/)
})

test('M5 释放契约：会话退出未写释放事件 → 记受阻', () => {
  const proj = buildProject({ taskIds: ['FIX-A'] })
  const { machinePath, planEnv } = writeMachine(proj, { plan: { 'FIX-A': { exit: true, delayMs: 30 } } })
  const schedulePath = writeSchedule(proj, { machineConfig: machinePath })

  const r = runDispatcher(schedulePath, { args: ['--now'], env: { FAKE_AGENT_PLAN: planEnv } })
  const out = readJsonOut(r)
  assert.equal(out.blocked.length, 1)
  const report = fs.readFileSync(out.reportPath, 'utf8')
  assert.match(report, /会话退出但未写释放事件/)
})

test('M5 dry-run：只出计划与快照，不建现场、不拉会话', () => {
  const proj = buildProject({ taskIds: ['FIX-A', 'FIX-B'] })
  const schedulePath = writeSchedule(proj) // 无 machine.json，dry-run 允许

  const r = runDispatcher(schedulePath, { args: ['--dry-run'] })
  const out = readJsonOut(r)
  assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`)
  assert.equal(out.mode, 'dry-run')
  assert.equal(out.launchOrder.length, 2)
  assert.ok(fs.existsSync(out.batchJsonPath))
  assert.ok(fs.existsSync(out.reportPath))
  assert.ok(!fs.existsSync(path.join(proj, '.agent-runs')), 'dry-run 不得创建 run 现场')
})

test('M5 endAt 截止：到点不开新任务，剩余任务如实报告', () => {
  const proj = buildProject({ taskIds: ['FIX-A', 'FIX-B'] })
  const { machinePath } = writeMachine(proj)
  const schedulePath = writeSchedule(proj, {
    machineConfig: machinePath,
    endAt: new Date(Date.now() - 1000).toISOString(),
  })

  const r = runDispatcher(schedulePath, { args: ['--now'] })
  const out = readJsonOut(r)
  assert.equal(r.status, 1, '有未启动任务时以非零码提示')
  assert.deepEqual([...out.leftoverQueue].sort(), ['FIX-A', 'FIX-B'])
  assert.ok(!fs.existsSync(path.join(proj, '.agent-runs')), '截止后不得开工')
  const report = fs.readFileSync(out.reportPath, 'utf8')
  assert.match(report, /未启动（超出 endAt/)
})

test('M5 未到点：pending 退出码 3，不建任何现场', () => {
  const proj = buildProject({ taskIds: ['FIX-A'] })
  const schedulePath = writeSchedule(proj, { startAt: new Date(Date.now() + 60_000).toISOString() })

  const r = runDispatcher(schedulePath)
  assert.equal(r.status, 3)
  const out = readJsonOut(r)
  assert.equal(out.pending, true)
  assert.ok(!fs.existsSync(path.join(proj, '.scratch/night-batches')), '未到点不得产出批次目录')
})
