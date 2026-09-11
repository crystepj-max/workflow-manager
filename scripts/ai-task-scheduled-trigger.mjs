#!/usr/bin/env node
/**
 * M4 到点启动：只负责判断是否到点，然后唤起同一套 Execution Plan（M3），
 * 并落盘「夜间批次报告」。不得复制资格筛选 / 排序 / 并发 / 补位逻辑。
 *
 * 用法：
 *   node scripts/ai-task-scheduled-trigger.mjs <schedule.json> [--now] [--wait-ms N]
 *
 * schedule.json:
 * {
 *   "runAt": "2026-09-06T22:00:00+08:00",
 *   "batch": "relative-or-abs/batch.json",
 *   "simulate": "optional/events.json",
 *   "reportOut": "optional/night-batch-report.md"
 * }
 *
 * --now：忽略未到点，立即唤起（机械对照 / 强制到点）
 * --wait-ms：未到点时最多等待毫秒数；到点后启动。0 或不写则未到点直接 pending 退出。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const planScript = path.join(__dirname, 'ai-task-execution-plan.mjs')

const argv = process.argv.slice(2)
if (argv.length < 1 || argv[0].startsWith('-')) {
  console.error('用法: node scripts/ai-task-scheduled-trigger.mjs <schedule.json> [--now] [--wait-ms N]')
  process.exit(2)
}

const schedulePath = path.resolve(argv[0])
const forceNow = argv.includes('--now')
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

const invokedAt = new Date().toISOString()
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
  `说明：本报告由到点触发产生；调度规则来自同一套 Execution Plan（未另写筛选/排序/补位）。`,
  `预约到点时刻：${runAt.toISOString()}`,
  `实际启动时间：${invokedAt}`,
  `强制到点对照：${forceNow ? '是' : '否'}`,
  '',
  planOut.summaryText || '(无汇总文本)',
  '',
].join('\n')

fs.writeFileSync(reportOut, nightReport, 'utf8')

const result = {
  ok: true,
  milestone: 'M4',
  trigger: 'scheduled',
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
}

console.log(JSON.stringify(result, null, 2))
if (planOut.ok === false || (simulatePath && planOut.autoPhaseDone === false)) {
  process.exit(1)
}
