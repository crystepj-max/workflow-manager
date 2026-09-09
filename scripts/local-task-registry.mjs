#!/usr/bin/env node
/**
 * 本地任务登记册（本地轨道唯一真源）
 *
 * GitHub 不可用时替代 issue tracker：分配任务标识、记录来源与范围、
 * 跟踪状态、重写看板、列出待同步 GitHub 的任务。
 *
 * CLI:
 *   node scripts/local-task-registry.mjs allocate --name <任务名称> [--slug <x>] [--source <来源>] [--source-ref <x>] [--repo <path>]
 *   node scripts/local-task-registry.mjs set --task LOC-001 [--status <状态>] [--baseline V1] [--branch <b>] [--worktree <p>] [--merge-commit <sha>] [--github-sync <x>] [--repo <path>]
 *   node scripts/local-task-registry.mjs board [--repo <path>]
 *   node scripts/local-task-registry.mjs list [--github-sync pending] [--repo <path>]
 *   node scripts/local-task-registry.mjs show --task LOC-001 [--repo <path>]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const TASK_ID_PREFIX = 'LOC-'
export const ID_PATTERN = /^LOC-(\d{3,})$/

export const STATUSES = [
  '定义中',
  '待确认',
  '本地已定义',
  '交付中',
  '等待验收',
  '执行受阻',
  '已合并',
]

export function nextSeq(records) {
  const max = records.reduce((acc, r) => {
    const m = ID_PATTERN.exec(String(r?.task_id ?? ''))
    return m ? Math.max(acc, parseInt(m[1], 10)) : acc
  }, 0)
  return max + 1
}

export function formatId(seq) {
  return `${TASK_ID_PREFIX}${String(seq).padStart(3, '0')}`
}

export function slugify(name, fallback = 'task') {
  const s = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return s || fallback
}

export function newRecord({
  seq,
  name,
  source = '会话录入',
  sourceRef = '',
  baseline = 'V1',
  now = new Date().toISOString(),
}) {
  if (!name) throw new Error('任务名称必填（--name）')
  return {
    task_id: formatId(seq),
    name,
    slug: slugify(name),
    source,
    source_ref: sourceRef,
    baseline,
    status: '定义中',
    priority: null,
    env_group: null,
    env_role: null,
    deps: [],
    branch: null,
    worktree: null,
    runs: [],
    merge: null,
    github_sync: 'pending',
    created_at: now,
    updated_at: now,
  }
}

export function applyUpdate(record, patch = {}) {
  const allowed = [
    'name',
    'slug',
    'source',
    'source_ref',
    'baseline',
    'status',
    'priority',
    'env_group',
    'env_role',
    'deps',
    'branch',
    'worktree',
    'merge',
    'github_sync',
    'leftovers',
  ]
  const next = { ...record }
  for (const k of allowed) {
    if (patch[k] !== undefined && patch[k] !== null) next[k] = patch[k]
  }
  if (patch.merge_commit) {
    next.merge = { ...(next.merge || {}), commit: patch.merge_commit, merged_at: patch.merged_at || new Date().toISOString() }
  }
  next.updated_at = patch.updated_at || new Date().toISOString()
  return next
}

export function renderBoard(records) {
  const order = [...STATUSES, '其他']
  const groups = new Map(order.map((s) => [s, []]))
  for (const r of records) {
    const key = groups.has(r.status) ? r.status : '其他'
    groups.get(key).push(r)
  }
  const lines = ['# 本地任务看板', '', '> 自动生成，请勿手工编辑。来源：`docs/tasks/registry.json`', '']
  let total = 0
  for (const status of order) {
    const items = groups.get(status)
    if (!items || items.length === 0) continue
    total += items.length
    lines.push(`## ${status}（${items.length}）`, '')
    lines.push('| 任务标识 | 任务名称 | 来源 | 基线 | GitHub 同步 | 更新于 |')
    lines.push('|---|---|---|---|---|---|')
    for (const r of items) {
      lines.push(
        `| ${r.task_id} | ${r.name} | ${r.source ?? '-'} | ${r.baseline ?? '-'} | ${r.github_sync ?? '-'} | ${r.updated_at ?? '-'} |`,
      )
    }
    lines.push('')
  }
  if (total === 0) lines.push('_暂无任务_', '')
  return lines.join('\n')
}

function registryPath(repo) {
  return path.join(repo, 'docs', 'tasks', 'registry.json')
}

export function loadRegistry(repo) {
  const p = registryPath(repo)
  if (!fs.existsSync(p)) return { version: 1, tasks: [] }
  const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'))
  return { version: 1, tasks: [], ...parsed }
}

export function saveRegistry(repo, registry) {
  const p = registryPath(repo)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(registry, null, 2) + '\n')
  return p
}

export function allocate(repo, { name, source, sourceRef, baseline }) {
  const registry = loadRegistry(repo)
  const record = newRecord({ seq: nextSeq(registry.tasks), name, source, sourceRef, baseline })
  registry.tasks.push(record)
  saveRegistry(repo, registry)
  return record
}

export function update(repo, taskId, patch) {
  const registry = loadRegistry(repo)
  const idx = registry.tasks.findIndex((r) => r.task_id === taskId)
  if (idx < 0) throw new Error(`任务不存在：${taskId}`)
  registry.tasks[idx] = applyUpdate(registry.tasks[idx], patch)
  saveRegistry(repo, registry)
  return registry.tasks[idx]
}

export function writeBoard(repo) {
  const registry = loadRegistry(repo)
  const boardPath = path.join(repo, 'docs', 'tasks', 'BOARD.md')
  fs.mkdirSync(path.dirname(boardPath), { recursive: true })
  fs.writeFileSync(boardPath, renderBoard(registry.tasks))
  return boardPath
}

// —— CLI ——
function main(argv) {
  const cmd = argv[0]
  const get = (f) => {
    const i = argv.indexOf(f)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const repo = path.resolve(get('--repo') || process.cwd())

  if (cmd === 'allocate') {
    const name = get('--name')
    if (!name) {
      console.error('用法: allocate --name <任务名称> [--slug <x>] [--source <来源>] [--source-ref <x>] [--repo <path>]')
      process.exit(2)
    }
    const rec = allocate(repo, {
      name,
      source: get('--source') || '会话录入',
      sourceRef: get('--source-ref') || '',
      baseline: get('--baseline') || 'V1',
    })
    writeBoard(repo)
    console.log(JSON.stringify(rec, null, 2))
    return
  }

  if (cmd === 'set') {
    const taskId = get('--task')
    if (!taskId) {
      console.error('用法: set --task LOC-001 [--status <状态>] [--baseline V1] [--branch <b>] [--merge-commit <sha>] [--github-sync <x>]')
      process.exit(2)
    }
    const deps = get('--deps')
    const rec = update(repo, taskId, {
      status: get('--status'),
      baseline: get('--baseline'),
      branch: get('--branch'),
      worktree: get('--worktree'),
      github_sync: get('--github-sync'),
      merge_commit: get('--merge-commit'),
      deps: deps ? deps.split(/[,，]/).map((s) => s.trim()).filter(Boolean) : undefined,
    })
    writeBoard(repo)
    console.log(JSON.stringify(rec, null, 2))
    return
  }

  if (cmd === 'board') {
    const p = writeBoard(repo)
    console.log(JSON.stringify({ board: p }, null, 2))
    return
  }

  if (cmd === 'list') {
    const sync = get('--github-sync')
    const tasks = loadRegistry(repo).tasks.filter((t) => !sync || t.github_sync === sync)
    console.log(JSON.stringify({ count: tasks.length, tasks }, null, 2))
    return
  }

  if (cmd === 'show') {
    const taskId = get('--task')
    const rec = loadRegistry(repo).tasks.find((r) => r.task_id === taskId)
    if (!rec) {
      console.error(`任务不存在：${taskId}`)
      process.exit(1)
    }
    console.log(JSON.stringify(rec, null, 2))
    return
  }

  console.error('用法: allocate | set | board | list | show')
  process.exit(2)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
}
