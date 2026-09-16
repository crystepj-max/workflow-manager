#!/usr/bin/env node
/**
 * M4 机械验收：
 * - 产品短文 / 试跑清单 / 到点启动脚本存在
 * - 未到点 → pending，不唤起执行计划
 * - 到点（--now）唤起同一执行计划，行为与直接跑 M3 一致
 * - 写出夜间批次报告（含等待验收等字段）
 * - 证明未另建调度内核（触发脚本不含资格/补位实现关键词的复制逻辑：通过「只 spawn plan」+ 结果一致）
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const errors = []
function fail(msg) { errors.push(msg) }
function ok(cond, msg) { if (!cond) fail(msg) }
function read(rel) {
  const p = path.join(root, rel)
  ok(fs.existsSync(p), `缺少: ${rel}`)
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
}

const doc = read('docs/design/ai-task-define-delivery/scheduled-trigger-m4.md')
ok(/到点|定时/.test(doc) && /同一.*执行计划|同一套/.test(doc), 'M4 文档须强调到点唤起同一执行计划')
ok(/不.*工作台|不含.*工作台|不做.*工作台/.test(doc), 'M4 须声明不含完整验收工作台')
ok(/约一次|指定时刻|不包含.*每晚/.test(doc), 'M4 须声明约一次、非每晚循环')

const trial = read('docs/design/ai-task-define-delivery/m4-e2e-trial.md')
ok(/3～5|3-5|3\s*~\s*5/.test(trial) || /3～5/.test(trial), '试跑清单须含 3～5 任务')

const trigger = path.join(root, 'scripts/ai-task-scheduled-trigger.mjs')
ok(fs.existsSync(trigger), '缺少 ai-task-scheduled-trigger.mjs')
const triggerSrc = fs.readFileSync(trigger, 'utf8')
ok(/ai-task-execution-plan\.mjs/.test(triggerSrc), '触发脚本须唤起 execution-plan')
ok(!/function fill\s*\(/.test(triggerSrc), '触发脚本不得复制补位 fill 实现')
ok(!/PRI\s*=\s*\{/.test(triggerSrc), '触发脚本不得复制优先级排序表')

const plan = path.join(root, 'scripts/ai-task-execution-plan.mjs')
const fix = path.join(root, 'scripts/test/fixtures/ai-task-scheduled-m4')
const batch = path.join(fix, 'batch.json')
const events = path.join(fix, 'events-scene1.json')
const schedule = path.join(fix, 'schedule.json')
const scheduleFuture = path.join(fix, 'schedule-future.json')

// 1) 未到点 → pending
const pending = spawnSync(process.execPath, [trigger, scheduleFuture], { encoding: 'utf8' })
ok(pending.status === 3, `未到点应 exit 3，got ${pending.status}\n${pending.stdout}\n${pending.stderr}`)
let pendingOut = {}
try { pendingOut = JSON.parse(pending.stdout) } catch (e) { fail('pending 输出非 JSON') }
ok(pendingOut.pending === true, '未到点须 pending:true')

// 2) 直接 M3
const direct = spawnSync(process.execPath, [plan, batch, '--simulate', events], { encoding: 'utf8' })
ok(direct.status === 0, `直接 M3 应成功\n${direct.stderr}`)
let directOut = {}
try { directOut = JSON.parse(direct.stdout) } catch (e) { fail('直接 M3 输出非 JSON') }

// 3) 到点触发（--now），报告写到临时目录
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm4-sched-'))
const tmpSchedule = path.join(tmpDir, 'schedule.json')
const tmpReport = path.join(tmpDir, 'night-batch-report.md')
const schedObj = JSON.parse(fs.readFileSync(schedule, 'utf8'))
schedObj.batch = batch
schedObj.simulate = events
schedObj.reportOut = tmpReport
fs.writeFileSync(tmpSchedule, JSON.stringify(schedObj, null, 2))

const scheduled = spawnSync(process.execPath, [trigger, tmpSchedule, '--now'], { encoding: 'utf8' })
ok(scheduled.status === 0, `到点触发应成功\n${scheduled.stdout}\n${scheduled.stderr}`)
let schedOut = {}
try { schedOut = JSON.parse(scheduled.stdout) } catch (e) { fail('到点触发输出非 JSON') }

ok(schedOut.ok === true && schedOut.milestone === 'M4', '到点触发须 ok/M4')
ok(
  JSON.stringify(schedOut.plan?.launchOrder) === JSON.stringify(directOut.launchOrder),
  `启动序须与立即跑一致：scheduled=${JSON.stringify(schedOut.plan?.launchOrder)} direct=${JSON.stringify(directOut.launchOrder)}`,
)
ok(
  JSON.stringify(schedOut.plan?.snapshotIds) === JSON.stringify(directOut.snapshotIds),
  '快照任务须与立即跑一致',
)
ok(
  JSON.stringify(schedOut.plan?.waiting) === JSON.stringify(directOut.waiting)
    && JSON.stringify(schedOut.plan?.completed) === JSON.stringify(directOut.completed),
  '等待验收/已完成须与立即跑一致',
)

ok(fs.existsSync(tmpReport), '须写出夜间批次报告')
const reportText = fs.readFileSync(tmpReport, 'utf8')
ok(/【夜间批次报告】/.test(reportText), '报告须有夜间抬头')
ok(/【批次前对账（CHORE-73）】/.test(reportText) && /对账：/.test(reportText), '报告须含批次前对账段（CHORE-73）')
ok(/等待验收/.test(reportText) && /未纳入|已完成/.test(reportText), '报告须含汇总分段')
ok(/同一套 Execution Plan|未另写/.test(reportText), '报告须声明未另写调度规则')

// 清理临时目录
try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }

const skill = read('dsh/skills/execution-plan/SKILL.md')
ok(/M4|定时|到点/.test(skill), 'execution-plan Skill 须提及定时/到点（M4）')
ok(/批次前对账|registry-reconcile/.test(skill), 'Skill 须含批次前对账约定（CHORE-73）')

if (errors.length) {
  console.error('M4 检查失败：')
  for (const e of errors) console.error(' -', e)
  process.exit(1)
}
console.log(JSON.stringify({
  ok: true,
  milestone: 'M4',
  launchOrder: schedOut.plan.launchOrder,
  waiting: schedOut.plan.waiting,
  completed: schedOut.plan.completed,
  pendingExit: 3,
}, null, 2))
