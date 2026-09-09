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
 *
 * 可导入状态机（LOC-007）：createBatchState / fillCapacity / applyRelease /
 * autoPhaseDone 为纯状态变换（无 IO、不退出），供 CLI 与直测共用；
 * scheduled-trigger 保持子进程边界（M4 到点开跑的进程隔离是刻意设计）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { STATUS_WAITING_ACCEPTANCE, STATUS_EXECUTION_BLOCKED } from './local-task-registry.mjs'
import { runPreflight } from './ai-task-preflight-check.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ---------- 可导入状态机（纯状态变换，LOC-007） ----------

export function createBatchState({ name, maxConcurrency, startedAt, snapshot, excluded = [] }) {
  return {
    name,
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
}

export function fillCapacity(state, nowIso = () => new Date().toISOString()) {
  while (state.running.size < state.maxConcurrency && state.queue.length) {
    const id = state.queue.shift()
    const task = state.snapshot.find((t) => t.id === id)
    state.running.set(id, { ...task, runStatus: 'RUNNING', launchedAt: nowIso() })
    state.launchLog.push({ taskId: id, at: nowIso(), action: 'launch' })
  }
  return state
}

/**
 * 释放路由（三态）。返回 { handled: true }；或 { handled: false, reason }：
 *   - 'not-running'：事件指向不在 RUNNING 的任务（调用方决定忽略/告警）
 *   - 'unknown-status'：未知释放状态（调用方决定报错退出）
 */
export function applyRelease(state, ev, nowIso = () => new Date().toISOString()) {
  const cur = state.running.get(ev.taskId)
  if (!cur) return { handled: false, reason: 'not-running' }
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
  else return { handled: false, reason: 'unknown-status' }
  state.launchLog.push({ taskId: ev.taskId, at: nowIso(), action: 'release', to: ev.to })
  return { handled: true }
}

export function autoPhaseDone(state) {
  return state.running.size === 0 && state.queue.length === 0
}

// ---------- CLI ----------

// batch.json 的路径解析基准（候选相对路径基于 batch 文件所在目录）——见 main 内 baseDir
async function main() {
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

  async function assessCandidate(candidate) {
    const baseDir = path.dirname(batchPath)
    const issuePath = path.resolve(baseDir, candidate.issueBasics)
    const specPath = path.resolve(baseDir, candidate.taskSpec)
    // LOC-003：进程内调用结构化校验，不再 spawn 子进程、不再自行重读 issue 文件
    const pr = await runPreflight(issuePath, specPath, { runBaseline: 'V1' })
    const f = pr.fields || {}
    const dep = f.dependencies ?? null
    const excluded = {
      id: candidate.id,
      name: f.name || candidate.id,
      reason: null,
    }
    if (dep && dep !== '无') {
      excluded.reason = 'V0.1 暂不支持关联任务自动执行'
      return { ok: false, excluded }
    }
    if (!pr.ok) {
      excluded.reason = pr.failures[0] || '实施前检查未通过'
      return { ok: false, excluded }
    }
    return {
      ok: true,
      task: {
        id: candidate.id,
        name: f.name || candidate.id,
        priority: f.priority || 'P2',
        baseline: f.baseline || 'V1',
        definedAt: f.defined_at || '1970-01-01T00:00:00Z',
        issueBasics: issuePath,
        taskSpec: specPath,
        uatHint: `Issue基本信息: ${issuePath}`,
      },
    }
  }

  const excluded = []
  const eligible = []
  const assessments = await Promise.all((batch.candidates || []).map((c) => assessCandidate(c)))
  for (const a of assessments) {
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

  const state = createBatchState({
    name: batch.name || path.basename(batchPath, '.json'),
    maxConcurrency,
    startedAt,
    snapshot,
    excluded,
  })

  fillCapacity(state)

  if (simulatePath) {
    const events = JSON.parse(fs.readFileSync(simulatePath, 'utf8'))
    for (const ev of events) {
      if (ev.op !== 'release') continue
      const r = applyRelease(state, ev)
      if (!r.handled && r.reason === 'not-running') {
        console.error(`忽略事件：任务 ${ev.taskId} 不在 RUNNING`)
        continue
      }
      if (!r.handled && r.reason === 'unknown-status') {
        console.error(`未知释放状态: ${ev.to}`)
        process.exit(1)
      }
      fillCapacity(state)
    }
  }

  const endedAt = new Date().toISOString()
  const done = autoPhaseDone(state)

  const summaryLines = [
    `批次名称：${state.name}`,
    `开始时间：${state.startedAt}`,
    `自动施工结束时间：${done ? endedAt : '（仍有 RUNNING 或未启动任务）'}`,
    `快照任务总数：${snapshot.length}`,
    `最大并发：${maxConcurrency}`,
    '',
    `${STATUS_WAITING_ACCEPTANCE}：`,
    ...(state.waiting.length ? state.waiting.map((t) => `- ${t.id} ${t.name}（${t.uatHint}）`) : ['- （无）']),
    '',
    `${STATUS_EXECUTION_BLOCKED}：`,
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
    autoPhaseDone: done,
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
  if (!done && simulatePath) process.exit(1)
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isCli) await main()
