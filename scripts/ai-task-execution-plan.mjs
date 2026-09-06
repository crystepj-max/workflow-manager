#!/usr/bin/env node
/**
 * M3 Execution Plan 内核：资格筛选 → 快照 → 排序 → 并发启动/补位 → 批次汇总。
 *
 * 用法：
 *   node scripts/ai-task-execution-plan.mjs <batch.json> [--simulate events.json]
 *
 * batch.json:
 * {
 *   "name": "batch-1",
 *   "maxConcurrency": 2,
 *   "candidates": [
 *     { "id": "A", "issueBasics": "path/to/issue-basics.md", "taskSpec": "path/to/task-spec.md" }
 *   ]
 * }
 *
 * --simulate：事件数组，驱动补位（不连真实 DSH）。事件形如：
 *   { "op": "release", "taskId": "A", "to": "WAITING_HUMAN" }
 *   { "op": "release", "taskId": "B", "to": "BLOCKED", "blockedNode": "test", "reason": "..." }
 *   { "op": "release", "taskId": "C", "to": "COMPLETED" }
 *
 * 未给 --simulate 时：仅输出快照与「将启动」顺序（dry-run 启动态）。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const preflight = path.join(root, 'scripts/ai-task-preflight-check.mjs')

const argv = process.argv.slice(2)
if (argv.length < 1) {
  console.error('用法: node scripts/ai-task-execution-plan.mjs <batch.json> [--simulate events.json]')
  process.exit(2)
}

const batchPath = path.resolve(argv[0])
let simulatePath = null
const sIdx = argv.indexOf('--simulate')
if (sIdx >= 0) simulatePath = path.resolve(argv[sIdx + 1])

const batch = JSON.parse(fs.readFileSync(batchPath, 'utf8'))
const maxConcurrency = Number(batch.maxConcurrency)
if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
  console.error('maxConcurrency 必须为正整数')
  process.exit(2)
}

const PRI = { P0: 0, P1: 1, P2: 2 }

function field(md, name) {
  const re = new RegExp(`\\|\\s*${name}\\s*\\|\\s*([^|]+)\\|`)
  const m = md.match(re)
  return m ? m[1].trim() : null
}

function assess(candidate) {
  const issuePath = path.resolve(path.dirname(batchPath), candidate.issueBasics)
  const specPath = path.resolve(path.dirname(batchPath), candidate.taskSpec)
  const r = spawnSync(process.execPath, [preflight, issuePath, specPath, '--run-baseline', 'V1'], {
    encoding: 'utf8',
  })
  const issue = fs.existsSync(issuePath) ? fs.readFileSync(issuePath, 'utf8') : ''
  const dep = field(issue, '前置依赖')
  const excluded = {
    id: candidate.id,
    name: field(issue, '任务名称') || candidate.id,
    reason: null,
  }
  if (dep && dep !== '无') {
    excluded.reason = 'V0.1 暂不支持关联任务自动执行'
    return { ok: false, excluded }
  }
  if (r.status !== 0) {
    excluded.reason = (r.stderr || r.stdout || '实施前检查未通过').trim().split('\n')[0]
    return { ok: false, excluded }
  }
  return {
    ok: true,
    task: {
      id: candidate.id,
      name: field(issue, '任务名称') || candidate.id,
      priority: field(issue, '优先级') || 'P2',
      baseline: field(issue, '需求基线版本') || 'V1',
      definedAt: field(issue, '定义时间') || '1970-01-01T00:00:00Z',
      issueBasics: issuePath,
      taskSpec: specPath,
      uatHint: `Issue基本信息: ${issuePath}`,
    },
  }
}

const excluded = []
const eligible = []
for (const c of batch.candidates || []) {
  const a = assess(c)
  if (a.ok) eligible.push(a.task)
  else excluded.push(a.excluded)
}

eligible.sort((a, b) => {
  const pa = PRI[a.priority] ?? 9
  const pb = PRI[b.priority] ?? 9
  if (pa !== pb) return pa - pb
  return String(a.definedAt).localeCompare(String(b.definedAt))
})

const startedAt = new Date().toISOString()
const snapshot = eligible.map((t) => ({ ...t, snapshotAt: startedAt }))

const state = {
  name: batch.name || path.basename(batchPath, '.json'),
  maxConcurrency,
  startedAt,
  snapshot,
  excluded,
  queue: snapshot.map((t) => t.id), // not yet started
  running: new Map(), // id -> task
  waiting: [],
  blocked: [],
  completed: [],
  launchLog: [],
}

function fill() {
  while (state.running.size < maxConcurrency && state.queue.length) {
    const id = state.queue.shift()
    const task = snapshot.find((t) => t.id === id)
    state.running.set(id, { ...task, runStatus: 'RUNNING', launchedAt: new Date().toISOString() })
    state.launchLog.push({ taskId: id, at: new Date().toISOString(), action: 'launch' })
  }
}

fill()

if (simulatePath) {
  const events = JSON.parse(fs.readFileSync(simulatePath, 'utf8'))
  for (const ev of events) {
    if (ev.op !== 'release') continue
    const cur = state.running.get(ev.taskId)
    if (!cur) {
      console.error(`忽略事件：任务 ${ev.taskId} 不在 RUNNING`)
      continue
    }
    state.running.delete(ev.taskId)
    const row = {
      id: ev.taskId,
      name: cur.name,
      to: ev.to,
      blockedNode: ev.blockedNode || null,
      reason: ev.reason || null,
      reworkCount: ev.reworkCount ?? null,
      nextStep: ev.nextStep || null,
      uatHint: cur.uatHint,
    }
    if (ev.to === 'WAITING_HUMAN') state.waiting.push(row)
    else if (ev.to === 'BLOCKED') state.blocked.push(row)
    else if (ev.to === 'COMPLETED') state.completed.push(row)
    else {
      console.error(`未知释放状态: ${ev.to}`)
      process.exit(1)
    }
    state.launchLog.push({ taskId: ev.taskId, at: new Date().toISOString(), action: 'release', to: ev.to })
    fill()
  }
}

const endedAt = new Date().toISOString()
const autoPhaseDone = state.running.size === 0 && state.queue.length === 0

const summaryLines = [
  `批次名称：${state.name}`,
  `开始时间：${state.startedAt}`,
  `自动施工结束时间：${autoPhaseDone ? endedAt : '（仍有 RUNNING 或未启动任务）'}`,
  `快照任务总数：${snapshot.length}`,
  `最大并发：${maxConcurrency}`,
  '',
  '等待验收：',
  ...(state.waiting.length ? state.waiting.map((t) => `- ${t.id} ${t.name}（${t.uatHint}）`) : ['- （无）']),
  '',
  '执行受阻：',
  ...(state.blocked.length
    ? state.blocked.map((t) => `- ${t.id} ${t.name}｜节点=${t.blockedNode || '?'}｜原因=${t.reason || '?'}｜返工=${t.reworkCount ?? '?'}｜下一步=${t.nextStep || '人工查看'}`)
    : ['- （无）']),
  '',
  '已完成：',
  ...(state.completed.length ? state.completed.map((t) => `- ${t.id} ${t.name}`) : ['- （无）']),
  '',
  '未纳入：',
  ...(state.excluded.length ? state.excluded.map((t) => `- ${t.id} ${t.name}｜原因：${t.reason}`) : ['- （无）']),
  '',
  '启动日志：',
  ...state.launchLog.map((e) => `- ${e.at} ${e.action} ${e.taskId}${e.to ? ' → ' + e.to : ''}`),
]

const result = {
  ok: true,
  milestone: 'M3',
  autoPhaseDone,
  maxConcurrency,
  snapshotIds: snapshot.map((t) => t.id),
  launchOrder: state.launchLog.filter((e) => e.action === 'launch').map((e) => e.taskId),
  running: [...state.running.keys()],
  waiting: state.waiting.map((t) => t.id),
  blocked: state.blocked.map((t) => t.id),
  completed: state.completed.map((t) => t.id),
  excluded: state.excluded,
  summaryText: summaryLines.join('\n'),
}

console.log(JSON.stringify(result, null, 2))
if (!autoPhaseDone && simulatePath) process.exit(1)
