#!/usr/bin/env node
/**
 * 任务登记册 ↔ GitHub 主源 issue 同步
 *
 * 用途：
 *   1. 为已在本地登记、但远端还没有 issue 的活跃任务批量建 issue，并把 issue 号回填登记册；
 *   2. 换号：把远端不可达时产生的临时号（TMP-*，remote=pending）换成正式号。
 *
 * 编号原则：编号由 GitHub 服务端分配（建 issue 时返回），本机不自己算号，
 * 因此双机并行与多 AI 会话并行都不会撞号。详见
 * docs/design/ai-task-define-delivery/task-id-and-remote-sync-proposal.md
 *
 * CLI:
 *   node scripts/remote-issue-sync.mjs plan [--repo <path>]
 *   node scripts/remote-issue-sync.mjs apply [--repo <path>] [--only LOC-016,LOC-018] [--type FEAT|FIX|CHORE]
 *   node scripts/remote-issue-sync.mjs reissue --task TMP-xxx-260916a --type CHORE   # 临时号换正式号
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  TASK_TYPES,
  NEW_ID_PATTERN,
  TMP_ID_PATTERN,
  loadRegistry,
  saveRegistry,
  writeBoard,
  remoteAllocate,
  resolveRemoteSlug,
} from './local-task-registry.mjs'

// 未显式指定类型时，按任务名称关键词判定维护类；其余一律视为需求迭代。
const CHORE_KEYWORDS = ['清理', '收敛', '补齐', '文档', '口径', '模板', '残留', '对齐', '验收', '度量']
const MERGED_LIKE = ['已合并', '已取消']

export function guessType(task) {
  const n = String(task?.name ?? '')
  return CHORE_KEYWORDS.some((k) => n.includes(k)) ? 'CHORE' : 'FEAT'
}

function taskCardPath(repo, task) {
  const dir = path.join(repo, 'docs', 'tasks')
  if (!fs.existsSync(dir)) return null
  const hit = fs.readdirSync(dir).find((f) => f.startsWith(`${task.task_id}-`) && f.endsWith('.md'))
  return hit ? path.join(dir, hit) : null
}

function issueBody(repo, task) {
  const card = taskCardPath(repo, task)
  const head = [
    `任务编号: ${task.task_id}`,
    `任务类型: ${task.type ?? guessType(task)}`,
    `需求来源: ${task.source ?? '会话录入'}`,
    `来源定位: ${task.source_ref || '（待补）'}`,
    `需求基线: ${task.baseline ?? 'V1'}`,
    task.legacy_id ? `历史编号: ${task.legacy_id}` : null,
    '',
  ]
    .filter((x) => x !== null)
    .join('\n')
  if (card) {
    return `${head}${fs.readFileSync(card, 'utf-8').replace(/^#.*\n/, '')}\n`
  }
  return `${head}_任务卡尚未生成，本 issue 正文将在任务定义完成后补全。_\n`
}

/** 需要建远端 issue 的任务：未合并、未取消、且还没有远端号（或还是临时号） */
export function pendingTasks(registry, only = null) {
  return registry.tasks.filter((t) => {
    if (MERGED_LIKE.includes(t.status)) return false
    if (only && !only.includes(t.task_id)) return false
    if (t.remote && t.remote !== 'pending') return false
    return true
  })
}

function plan(repo, only) {
  const registry = loadRegistry(repo)
  const slug = resolveRemoteSlug(repo)
  const items = pendingTasks(registry, only).map((t) => ({
    task_id: t.task_id,
    status: t.status,
    type: t.type ?? guessType(t),
    priority: t.priority ?? null,
    name: t.name,
  }))
  return { remote: slug, count: items.length, items }
}

function apply(repo, only, forcedType) {
  const registry = loadRegistry(repo)
  const targets = pendingTasks(registry, only)
  const done = []
  const failed = []
  for (const t of targets) {
    const type = forcedType ?? t.type ?? guessType(t)
    try {
      const number = remoteAllocate({
        type,
        name: t.name,
        body: issueBody(repo, t),
        priority: t.priority ?? null,
        repo,
      })
      // 临时号换正式号：编号本身也要改，旧号进 legacy_id
      if (TMP_ID_PATTERN.test(t.task_id)) {
        t.legacy_id = t.legacy_id ?? t.task_id
        t.task_id = `${type}-${number}`
      }
      t.type = type
      t.remote = `github#${number}`
      t.updated_at = new Date().toISOString()
      done.push(`${t.task_id} → github#${number}`)
    } catch (err) {
      failed.push(`${t.task_id}: ${err.message}`)
    }
  }
  saveRegistry(repo, registry)
  writeBoard(repo)
  return { count: done.length, done, failed }
}

function reissue(repo, taskId, type) {
  const registry = loadRegistry(repo)
  const t = registry.tasks.find((x) => x.task_id === taskId)
  if (!t) throw new Error(`任务不存在：${taskId}`)
  const nextType = type ?? t.type ?? guessType(t)
  const number = remoteAllocate({
    type: nextType,
    name: t.name,
    body: issueBody(repo, t),
    priority: t.priority ?? null,
    repo,
  })
  t.legacy_id = t.legacy_id ?? t.task_id
  t.task_id = `${nextType}-${number}`
  t.type = nextType
  t.remote = `github#${number}`
  t.updated_at = new Date().toISOString()
  saveRegistry(repo, registry)
  writeBoard(repo)
  return t
}

function main(argv) {
  const cmd = argv[0]
  const get = (f) => {
    const i = argv.indexOf(f)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const repo = path.resolve(get('--repo') || process.cwd())
  const only = get('--only') ? get('--only').split(',').map((s) => s.trim()).filter(Boolean) : null
  const type = get('--type') ? String(get('--type')).toUpperCase() : null
  if (type && !TASK_TYPES.includes(type)) {
    console.error(`任务类型必须是 ${TASK_TYPES.join(' / ')} 之一`)
    process.exit(2)
  }

  if (cmd === 'plan') {
    console.log(JSON.stringify(plan(repo, only), null, 2))
    return
  }
  if (cmd === 'apply') {
    console.log(JSON.stringify(apply(repo, only, type), null, 2))
    return
  }
  if (cmd === 'reissue') {
    const taskId = get('--task')
    if (!taskId) {
      console.error('用法: reissue --task TMP-xxx-260916a [--type FEAT|FIX|CHORE]')
      process.exit(2)
    }
    console.log(JSON.stringify(reissue(repo, taskId, type), null, 2))
    return
  }
  console.error('用法: plan | apply | reissue')
  process.exit(2)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
}
