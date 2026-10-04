#!/usr/bin/env node
/**
 * M4 safety check:
 * - due-time execution fails closed before ledger reconciliation or M3 planning
 * - explicit preview preserves the read-only M3 comparison
 * - repeated triggers and unavailable GitHub tooling do not write or dispatch
 * - preview output cannot overwrite the legacy registry or board
 */
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const errors = []
function fail(message) { errors.push(message) }
function ok(condition, message) { if (!condition) fail(message) }
function read(rel) {
  const target = path.join(root, rel)
  ok(fs.existsSync(target), `缺少: ${rel}`)
  return fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : ''
}
function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}
function parseJson(result, label) {
  try { return JSON.parse(result.stdout) } catch { fail(`${label} 输出非 JSON: ${result.stdout}\n${result.stderr}`); return {} }
}

const doc = read('docs/design/ai-task-define-delivery/scheduled-trigger-m4.md')
ok(/到点|定时/.test(doc) && /同一.*执行计划|同一套/.test(doc), 'M4 文档须保留同一执行计划定位')
ok(/不.*工作台|不含.*工作台|不做.*工作台/.test(doc), 'M4 须声明不含完整验收工作台')
ok(/约一次|指定时刻|不包含.*每晚/.test(doc), 'M4 须声明约一次、非每晚循环')
ok(/WFM-128/.test(doc) && /fail-closed/.test(doc) && /--preview/.test(doc), 'M4 文档须声明当前 fail-closed 与只读预览覆盖')

const trial = read('docs/design/ai-task-define-delivery/m4-e2e-trial.md')
ok(/3～5|3-5|3\s*~\s*5/.test(trial), '试跑清单须含 3～5 任务')

const trigger = path.join(root, 'scripts/ai-task-scheduled-trigger.mjs')
ok(fs.existsSync(trigger), '缺少 ai-task-scheduled-trigger.mjs')
const triggerSrc = fs.readFileSync(trigger, 'utf8')
ok(/--preview/.test(triggerSrc), '触发脚本须显式提供只读预览入口')
ok(/legacy_scheduler_disabled/.test(triggerSrc), '触发脚本须有可识别的 fail-closed 停止路径')
ok(/reconcilePlan/.test(triggerSrc), '只读预览须保留现有诊断行为')
ok(!/reconcileApply|apply as reconcileApply/.test(triggerSrc), '触发脚本不得回写 registry/BOARD')
ok(!/ai-task-dispatcher|fetchTaskSource|markReady|claimIssue/.test(triggerSrc), 'M4 触发器不得接入旧 GitHub/Run 派发入口')
ok(!/function fill\s*\(/.test(triggerSrc), '触发脚本不得复制补位 fill 实现')
ok(!/PRI\s*=\s*\{/.test(triggerSrc), '触发脚本不得复制优先级排序表')

const plan = path.join(root, 'scripts/ai-task-execution-plan.mjs')
const fixture = path.join(root, 'scripts/test/fixtures/ai-task-scheduled-m4')
const batch = path.join(fixture, 'batch.json')
const events = path.join(fixture, 'events-scene1.json')
const schedule = path.join(fixture, 'schedule.json')
const scheduleFuture = path.join(fixture, 'schedule-future.json')
const ledgerPaths = [
  path.join(root, 'docs/tasks/registry.json'),
  path.join(root, 'docs/tasks/BOARD.md'),
]
const ledgerHashesBefore = ledgerPaths.map(hashFile)
let previewLaunchOrder = []

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm4-sched-safety-'))
try {
  const tmpSchedule = path.join(tmpDir, 'schedule.json')
  const tmpReport = path.join(tmpDir, 'night-batch-report.md')
  const scheduleData = JSON.parse(fs.readFileSync(schedule, 'utf8'))
  scheduleData.batch = batch
  scheduleData.simulate = events
  scheduleData.reportOut = tmpReport
  fs.writeFileSync(tmpSchedule, JSON.stringify(scheduleData, null, 2))

  const ghLog = path.join(tmpDir, 'gh-calls.log')
  const ghWriteLog = path.join(tmpDir, 'gh-writes.log')
  const ghBin = path.join(tmpDir, 'bin')
  const missingRemoteBin = path.join(tmpDir, 'missing-remote-bin')
  fs.mkdirSync(ghBin)
  fs.mkdirSync(missingRemoteBin)
  const ghStub = path.join(ghBin, 'gh')
  fs.writeFileSync(ghStub, [
    '#!/bin/sh',
    'printf \'%s\\n\' "$*" >> "$GH_CALL_LOG"',
    'case "$*" in',
    '  "issue edit "*|"issue comment "*|"issue create "*|"issue close "*|"issue reopen "*|"label create "*|"label edit "*|"label delete "*|"api "--method POST"*|"api "--method PATCH"*|"api "--method PUT"*|"api "--method DELETE"*) printf \'%s\\n\' "$*" >> "$GH_WRITE_LOG" ;;',
    'esac',
    'exit 1',
    '',
  ].join('\n'), 'utf8')
  fs.chmodSync(ghStub, 0o755)
  const shimEnv = {
    ...process.env,
    PATH: `${ghBin}:${process.env.PATH || ''}`,
    GH_CALL_LOG: ghLog,
    GH_WRITE_LOG: ghWriteLog,
  }

  // 未到点不进入任何执行路径。
  const pending = spawnSync(process.execPath, [trigger, scheduleFuture], { encoding: 'utf8' })
  ok(pending.status === 3, `未到点应 exit 3，got ${pending.status}\n${pending.stdout}\n${pending.stderr}`)
  ok(parseJson(pending, 'pending').pending === true, '未到点须 pending:true')

  // 旧行为基线：M3 直接预览的计划仍作为显式 --preview 的对照。
  const direct = spawnSync(process.execPath, [plan, batch, '--simulate', events], { encoding: 'utf8', cwd: root })
  ok(direct.status === 0, `直接 M3 对照应成功\n${direct.stderr}`)
  const directOut = parseJson(direct, 'direct M3')
  previewLaunchOrder = directOut.launchOrder || []

  // 缺少可用远端时，重复到点触发也必须在任何 reconcile / M3 调用前停止。
  for (let attempt = 1; attempt <= 2; attempt++) {
    const blocked = spawnSync(process.execPath, [trigger, tmpSchedule, '--now'], {
      encoding: 'utf8',
      cwd: root,
      env: attempt === 1 ? { ...shimEnv, PATH: missingRemoteBin } : shimEnv,
    })
    ok(blocked.status === 1, `第 ${attempt} 次到点触发须 fail-closed，got ${blocked.status}`)
    const blockedOut = parseJson(blocked, `blocked trigger ${attempt}`)
    ok(blockedOut.blocked === true && blockedOut.reasonCode === 'legacy_scheduler_disabled', `第 ${attempt} 次触发须说明旧调度停用原因`)
    ok(blockedOut.effects?.planInvoked === false && blockedOut.effects?.implementationRunStarted === false, `第 ${attempt} 次触发不得运行计划或实施 Run`)
    ok(!fs.existsSync(tmpReport), `第 ${attempt} 次阻断不得生成批次报告`)
  }
  ok(!fs.existsSync(ghLog) || fs.readFileSync(ghLog, 'utf8').trim() === '', '阻断路径不得调用 GitHub CLI')
  ok(!fs.existsSync(ghWriteLog) || fs.readFileSync(ghWriteLog, 'utf8').trim() === '', '阻断路径 GitHub 写调用数须为零')

  // 显式预览仍能诊断并与 M3 计划一致，但远端不可用也不能升级成派发。
  const preview = spawnSync(process.execPath, [trigger, tmpSchedule, '--now', '--preview'], {
    encoding: 'utf8',
    cwd: root,
    env: shimEnv,
  })
  ok(preview.status === 0, `只读预览应成功\n${preview.stdout}\n${preview.stderr}`)
  const previewOut = parseJson(preview, 'preview')
  ok(previewOut.previewOnly === true && previewOut.implementationRunStarted === false, '预览输出须明确未启动实施 Run')
  ok(
    JSON.stringify(previewOut.plan?.launchOrder) === JSON.stringify(directOut.launchOrder),
    `预览计划须与 M3 一致：preview=${JSON.stringify(previewOut.plan?.launchOrder)} direct=${JSON.stringify(directOut.launchOrder)}`,
  )
  ok(fs.existsSync(tmpReport), '显式预览须写出独立夜间报告')
  const reportText = fs.readFileSync(tmpReport, 'utf8')
  ok(/只读计划预览/.test(reportText) && /未.*认领|未.*派发/.test(reportText), '报告须明确只读且未派发')
  ok(/只读诊断/.test(reportText) && /registry\/BOARD 保持不变/.test(reportText), '报告须说明对账只读且账本不变')
  ok(!fs.existsSync(ghWriteLog) || fs.readFileSync(ghWriteLog, 'utf8').trim() === '', '预览期间 GitHub 写调用数须为零')

  // 防止报告路径覆盖受保护的历史账本。
  for (const [index, ledgerPath] of ledgerPaths.entries()) {
    const protectedSchedule = path.join(tmpDir, `protected-schedule-${index}.json`)
    fs.writeFileSync(protectedSchedule, JSON.stringify({ ...scheduleData, reportOut: ledgerPath }, null, 2))
    const protectedResult = spawnSync(process.execPath, [trigger, protectedSchedule, '--now', '--preview'], {
      encoding: 'utf8',
      cwd: root,
      env: shimEnv,
    })
    ok(protectedResult.status === 1, `预览不得覆盖 ${path.basename(ledgerPath)}`)
    ok(parseJson(protectedResult, 'protected report').reasonCode === 'protected_report_path', `${path.basename(ledgerPath)} 路径须明确拒绝`)
  }
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true })
}

const ledgerHashesAfter = ledgerPaths.map(hashFile)
ok(JSON.stringify(ledgerHashesAfter) === JSON.stringify(ledgerHashesBefore), 'registry.json / BOARD.md 前后哈希必须一致')

const skill = read('dsh/skills/execution-plan/SKILL.md')
ok(/M4|定时|到点/.test(skill), 'execution-plan Skill 须提及定时/到点（M4）')
ok(/批次前对账|registry-reconcile/.test(skill), 'Skill 须含历史批次对账约定')

if (errors.length) {
  console.error('M4 安全检查失败：')
  for (const error of errors) console.error(` - ${error}`)
  process.exit(1)
}
console.log(JSON.stringify({
  ok: true,
  milestone: 'M4',
  blockedReason: 'legacy_scheduler_disabled',
  repeatedTriggersBlocked: true,
  githubWrites: 0,
  registryBoardUnchanged: true,
  previewLaunchOrder,
}, null, 2))
