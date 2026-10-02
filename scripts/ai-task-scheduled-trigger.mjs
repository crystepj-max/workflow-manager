#!/usr/bin/env node
/**
 * M4 到点触发：默认 fail-closed；仅显式 --preview 时运行只读 Execution Plan（M3）。
 * 不负责旧任务账本写入、Task claim 或实施 Run 派发。
 *
 * 用法：
 *   node scripts/ai-task-scheduled-trigger.mjs <schedule.json> [--now] [--wait-ms N] [--preview]
 *
 * schedule.json:
 * {
 *   "runAt": "2026-09-06T22:00:00+08:00",
 *   "batch": "relative-or-abs/batch.json",
 *   "simulate": "optional/events.json",
 *   "reportOut": "optional/night-batch-report.md"
 * }
 *
 * --now：忽略未到点；不会绕过默认 fail-closed
 * --wait-ms：未到点时最多等待毫秒数；0 或不写则未到点直接 pending 退出。
 * --preview：显式运行只读计划预览并写报告，不认领任务或启动实施 Run。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { reconcilePlan } from './registry-reconcile.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const planScript = path.join(__dirname, 'ai-task-execution-plan.mjs')

const argv = process.argv.slice(2)
if (argv.length < 1 || argv[0].startsWith('-')) {
  console.error('用法: node scripts/ai-task-scheduled-trigger.mjs <schedule.json> [--now] [--wait-ms N] [--preview]')
  process.exit(2)
}

const schedulePath = path.resolve(argv[0])
const forceNow = argv.includes('--now')
const previewOnly = argv.includes('--preview')
let waitMs = 0
const wIdx = argv.indexOf('--wait-ms')
if (wIdx >= 0) waitMs = Number(argv[wIdx + 1] || 0)

if (!fs.existsSync(schedulePath)) {
  console.error(`找不到预约单: ${schedulePath}`)
  process.exit(2)
}

const schedule = JSON.parse(fs.readFileSync(schedulePath, 'utf8'))
const runAtRaw = schedule.runAt
if (!runAtRaw) {
  console.error('schedule.json 须含 runAt')
  process.exit(2)
}
const runAt = new Date(runAtRaw)
if (Number.isNaN(runAt.getTime())) {
  console.error(`无效 runAt: ${runAtRaw}`)
  process.exit(2)
}

const scheduleDir = path.dirname(schedulePath)
const batchPath = path.resolve(scheduleDir, schedule.batch)
if (!fs.existsSync(batchPath)) {
  console.error(`找不到批次: ${batchPath}`)
  process.exit(2)
}
let simulatePath = null
if (schedule.simulate) {
  simulatePath = path.resolve(scheduleDir, schedule.simulate)
  if (!fs.existsSync(simulatePath)) {
    console.error(`找不到模拟事件: ${simulatePath}`)
    process.exit(2)
  }
}
const reportOut = path.resolve(
  scheduleDir,
  schedule.reportOut || 'night-batch-report.md',
)

function canonicalOutputPath(filePath) {
  if (fs.existsSync(filePath)) return fs.realpathSync(filePath)
  const parent = path.dirname(filePath)
  return path.join(
    fs.existsSync(parent) ? fs.realpathSync(parent) : path.resolve(parent),
    path.basename(filePath),
  )
}

const protectedOutputPaths = [
  path.join(root, 'docs/tasks/registry.json'),
  path.join(root, 'docs/tasks/BOARD.md'),
].map(canonicalOutputPath)

function stop(reasonCode, message) {
  console.log(JSON.stringify({
    ok: false,
    blocked: true,
    milestone: 'M4',
    trigger: 'scheduled',
    forceNow,
    runAt: runAt.toISOString(),
    reasonCode,
    message,
    effects: {
      registryBoardWrites: false,
      githubWrites: false,
      planInvoked: false,
      implementationRunStarted: false,
    },
  }, null, 2))
  process.exit(1)
}

function sleep(ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    /* busy-ish wait ok for short mechanical waits; long waits use Atomics */
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(50, end - Date.now()))
  }
}

const checkedAt = new Date()
if (!forceNow && checkedAt.getTime() < runAt.getTime()) {
  const remain = runAt.getTime() - checkedAt.getTime()
  if (waitMs > 0) {
    const toWait = Math.min(waitMs, remain)
    sleep(toWait)
  }
  const after = new Date()
  if (after.getTime() < runAt.getTime() && !forceNow) {
    const pending = {
      ok: false,
      pending: true,
      milestone: 'M4',
      runAt: runAt.toISOString(),
      checkedAt: after.toISOString(),
      message: '尚未到点，未启动执行计划',
    }
    console.log(JSON.stringify(pending, null, 2))
    process.exit(3)
  }
}

if (!previewOnly) {
  stop(
    'legacy_scheduler_disabled',
    '旧版定时自动执行已停用：当前平台契约未证明同一 Task 的服务端独占实施 Claim，也未证明旧 Run 停止后的安全接管；Owner、并发和依赖状态无法由本入口权威确认。未执行对账写回、M3 计划、GitHub 写入或实施 Run。仅可使用 --preview 查看只读诊断。',
  )
}

if (protectedOutputPaths.includes(canonicalOutputPath(reportOut))) {
  stop(
    'protected_report_path',
    '拒绝把预览报告写入 docs/tasks/registry.json 或 docs/tasks/BOARD.md；请选择独立报告路径。',
  )
}

const invokedAt = new Date().toISOString()

// Read-only diagnosis for an explicit preview; never write findings back to the legacy ledger.
const repoRoot = path.resolve(__dirname, '..')
const reconcileLines = []
try {
  const audit = reconcilePlan(repoRoot, 'main')
  reconcileLines.push(`只读诊断：${audit.toMerge.length} 条主干合并事实未回写；registry/BOARD 保持不变`)
  if (audit.suspicious.length) {
    reconcileLines.push(
      `⚠️ 可疑差异 ${audit.suspicious.length} 条（含登记/主干不一致与本地施工痕迹漏标，须人工核对）：`,
      ...audit.suspicious.map((s) => `  - ${s.task_id}｜${s.note}`),
    )
  }
} catch (e) {
  reconcileLines.push(`只读诊断不可用：${e.message}；本预览不会据此派发或回退旧账本`)
}

const planArgs = [planScript, batchPath]
if (simulatePath) planArgs.push('--simulate', simulatePath)

const r = spawnSync(process.execPath, planArgs, { encoding: 'utf8' })
if (r.status !== 0 && r.status !== null) {
  console.error(r.stderr || r.stdout || '执行计划失败')
  process.exit(r.status || 1)
}

let planOut
try {
  planOut = JSON.parse(r.stdout)
} catch (e) {
  console.error('执行计划输出非 JSON:', e.message)
  console.error(r.stdout)
  process.exit(1)
}

const nightReport = [
  '【夜间批次报告】',
  '说明：本报告仅为显式只读计划预览；未认领任务、未派发任务、未启动实施 Run。',
  '调度规则来自同一套 Execution Plan；本预览不会回写 registry/BOARD。',
  `预约到点时刻：${runAt.toISOString()}`,
  `实际启动时间：${invokedAt}`,
  `强制到点预览：${forceNow ? '是' : '否'}`,
  '',
  '【批次前只读诊断】',
  ...reconcileLines,
  '',
  planOut.summaryText || '(无汇总文本)',
  '',
].join('\n')

fs.writeFileSync(reportOut, nightReport, 'utf8')

const result = {
  ok: true,
  milestone: 'M4',
  trigger: 'scheduled-preview',
  previewOnly: true,
  implementationRunStarted: false,
  forceNow,
  runAt: runAt.toISOString(),
  invokedAt,
  batchPath,
  reportOut,
  plan: {
    autoPhaseDone: planOut.autoPhaseDone,
    snapshotIds: planOut.snapshotIds,
    launchOrder: planOut.launchOrder,
    waiting: planOut.waiting,
    blocked: planOut.blocked,
    completed: planOut.completed,
    excluded: planOut.excluded,
  },
  message: '仅生成只读计划预览；未认领任务、未派发实施 Run。',
}

console.log(JSON.stringify(result, null, 2))
if (planOut.ok === false || (simulatePath && planOut.autoPhaseDone === false)) {
  process.exit(1)
}
