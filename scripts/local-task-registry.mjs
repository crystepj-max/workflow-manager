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
import { execFileSync } from 'node:child_process'
import os from 'node:os'

// 旧编号（2026-09-15 及之前分配的历史任务）：LOC-<三位序号>，由本机计算，双机并行会撞号。
export const TASK_ID_PREFIX = 'LOC-'
export const ID_PATTERN = /^LOC-(\d{3,})$/

// 新编号（2026-09-16 起）：<类型>-<远端 issue 号>，号由 CNB 服务端分配，本机不自己算。
// FEAT 需求迭代 / FIX 缺陷修复 / CHORE 维护性（文档、脚本、口径收敛、测试补齐）
export const TASK_TYPES = ['FEAT', 'FIX', 'CHORE']
export const TYPE_LABELS = { FEAT: '需求迭代', FIX: '缺陷修复', CHORE: '维护性' }
export const NEW_ID_PATTERN = /^(FEAT|FIX|CHORE)-(\d+)$/
// 远端不可达时的临时号：TMP-<机器码>-<日期><当日序号>，联网后必须换取正式号
export const TMP_ID_PATTERN = /^TMP-[a-z0-9]+-\d{6}[a-z]?$/i

// 状态词汇唯一来源（LOC-002）：merge / preflight 一律引用这里的常量，禁止字面量重抄。
export const STATUS_LOCAL_DEFINED = '本地已定义'
export const STATUS_WAITING_ACCEPTANCE = '等待验收'
export const STATUS_EXECUTION_BLOCKED = '执行受阻'
export const STATUS_MERGED = '已合并'

export const STATUSES = [
  '定义中',
  '待确认',
  STATUS_LOCAL_DEFINED,
  '交付中',
  STATUS_WAITING_ACCEPTANCE,
  STATUS_EXECUTION_BLOCKED,
  STATUS_MERGED,
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

// —— 远端发号（CNB）——
// 任务编号由 CNB 建 issue 时服务端分配，本机不再自己算号，从根上消除双机/多会话撞号。
// 仓库 slug 从 git remote 的 cnb 远端解析，不写死。
export function resolveRemoteSlug(repo) {
  try {
    const url = execFileSync('git', ['-C', repo, 'remote', 'get-url', 'cnb'], { encoding: 'utf8' }).trim()
    const m = /^[a-z]+:\/\/[^/]+\/(.+?)(?:\.git)?$/i.exec(url)
    return m ? m[1] : null
  } catch {
    return null
  }
}

export function machineCode() {
  return String(os.hostname() || 'local').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'local'
}

/**
 * 在 CNB 建 issue 并取得服务端分配的编号。
 * @returns {number} issue 编号
 * @throws 远端不可达或建 issue 失败时抛错，由调用方降级为临时号
 */
export function remoteAllocate({
  type = 'FEAT',
  name,
  body = '',
  priority = null,
  repo = process.cwd(),
} = {}) {
  const slug = resolveRemoteSlug(repo)
  if (!slug) throw new Error('未找到 cnb 远端，无法向远端申请编号')
  const args = [
    'issues', 'create-issue',
    '--repo', slug,
    '--title', name,
    '--labels', String(type).toLowerCase(),
    '--body', body,
    '--verbose',
  ]
  if (priority) args.push('--priority', priority)
  const out = execFileSync('cnb', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const m = /"number"\s*:\s*"?(\d+)"?/.exec(out)
  if (!m) throw new Error('远端未返回 issue 编号')
  return Number(m[1])
}

/**
 * 远端不可达时的临时号：TMP-<机器码>-<年月日><当日序号>。
 * 不计入正式序列，联网后必须换取正式号。
 */
export function tmpId(records, now = new Date()) {
  const d = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
  const prefix = `TMP-${machineCode()}-${d}`
  const used = new Set(
    records.map((r) => String(r?.task_id ?? '')).filter((id) => id.toUpperCase().startsWith(prefix.toUpperCase())),
  )
  const letters = 'abcdefghijklmnopqrstuvwxyz'
  for (const c of letters) {
    const id = `${prefix}${c}`
    if (!used.has(id)) return id
  }
  throw new Error('当日临时号已用尽')
}

// 证据明细保留期（天）。起算点是**合并时间**，不是创建时间。
// 依据：docs/design/workspace-directory-convention.md §1.8。
export const DEFAULT_EVIDENCE_RETENTION_DAYS = 7

export function evidenceExpiry(mergedAt, retentionDays = DEFAULT_EVIDENCE_RETENTION_DAYS) {
  const t = Date.parse(mergedAt)
  if (Number.isNaN(t)) return null
  return new Date(t + retentionDays * 24 * 60 * 60 * 1000).toISOString()
}

export function newRecord({
  seq,
  taskId,
  name,
  source = '会话录入',
  sourceRef = '',
  baseline = 'V1',
  now = new Date().toISOString(),
  type = 'FEAT',
  remote = null,
  legacyId = null,
}) {
  if (!name) throw new Error('任务名称必填（--name）')
  return {
    task_id: taskId ?? formatId(seq),
    type,
    remote,
    legacy_id: legacyId,
    origin_machine: machineCode(),
    origin_agent: process.env.AI_AGENT_NAME ?? null,
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
    // 生命周期三字段（约定 §1.8）：到期时间、实际清理时间、分支是否按暂停期保留
    evidence_expires_at: null,
    evidence_cleared_at: null,
    branch_retained: null,
    created_at: now,
    updated_at: now,
  }
}

export function applyUpdate(record, patch = {}) {
  const allowed = [
    'name',
    'slug',
    'type',
    'remote',
    'legacy_id',
    'origin_agent',
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
    'spec_path',
  ]
  const next = { ...record }
  for (const k of allowed) {
    if (patch[k] !== undefined && patch[k] !== null) next[k] = patch[k]
  }
  if (patch.merge_commit) {
    const mergedAt = patch.merged_at || new Date().toISOString()
    next.merge = { ...(next.merge || {}), commit: patch.merge_commit, merged_at: mergedAt }
    // 合并即自动起算证据保留期（约定 §1.8：起算点 = 合并时间 + 保留期）
    if (patch.evidence_expires_at === undefined) {
      next.evidence_expires_at = evidenceExpiry(mergedAt, patch.retention_days ?? DEFAULT_EVIDENCE_RETENTION_DAYS)
    }
  }
  // 生命周期三字段允许 null（null = 未清理 / 未保留），故不走上面的白名单
  for (const k of ['evidence_expires_at', 'evidence_cleared_at', 'branch_retained']) {
    if (k in patch && patch[k] !== undefined) next[k] = patch[k]
    if (k in patch && patch[k] === null) next[k] = null
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
  const pendingRemote = records.filter(
    (r) => r.status !== '已合并' && r.status !== '已取消' && (r.remote === 'pending' || r.remote == null || r.remote === 'none'),
  )
  if (pendingRemote.length > 0) {
    lines.push(
      `> ⚠️ 待换取远端正式号：**${pendingRemote.length}** 个（${pendingRemote.map((r) => r.task_id).join('、')}）`,
      '',
    )
  }
  let total = 0
  for (const status of order) {
    const items = groups.get(status)
    if (!items || items.length === 0) continue
    total += items.length
    lines.push(`## ${status}（${items.length}）`, '')
    lines.push('| 任务标识 | 类型 | 任务名称 | 来源 | 基线 | 远端 | 更新于 |')
    lines.push('|---|---|---|---|---|---|---|')
    for (const r of items) {
      const type = r.type ? `${TYPE_LABELS[r.type] ?? r.type}` : '-'
      const remote = r.remote ?? (r.github_sync === 'pending' ? '待同步' : (r.github_sync ?? '-'))
      lines.push(
        `| ${r.task_id} | ${type} | ${r.name} | ${r.source ?? '-'} | ${r.baseline ?? '-'} | ${remote} | ${r.updated_at ?? '-'} |`,
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

// CLI 值转换：字符串 'none' / 'null' 表示显式置 null（区别于「未提供参数」）
function nullable(v) {
  if (v === undefined) return undefined
  return v === 'none' || v === 'null' ? null : v
}

function toBool(v) {
  if (v === undefined) return undefined
  return v === 'true' || v === '1' || v === 'yes'
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

// 建 issue 时的正文：任务卡还没写出来，先把登记册里的已知信息落远端，联网可查。
function issueBody({ name, source, sourceRef, baseline }) {
  return [
    `任务名称: ${name}`,
    `需求来源: ${source ?? '会话录入'}`,
    `来源定位: ${sourceRef || '（待补）'}`,
    `需求基线: ${baseline ?? 'V1'}`,
    '',
    '_本 issue 由任务登记册在建任务时自动创建，任务卡全文随后补入。_',
  ].join('\n')
}

/**
 * 分配任务编号：默认向 CNB 申请（服务端发号，双机/多会话不会撞号）；
 * 远端不可达或显式 --offline 时降级为临时号，remote 记为 pending，联网后须换取正式号。
 */
export function allocate(repo, { name, source, sourceRef, baseline, type = 'FEAT', priority = null, offline = false }) {
  const t = String(type).toUpperCase()
  if (!TASK_TYPES.includes(t)) throw new Error(`任务类型必须是 ${TASK_TYPES.join(' / ')} 之一`)
  const registry = loadRegistry(repo)
  let taskId
  let remote
  const slug = offline ? null : resolveRemoteSlug(repo)
  if (offline) {
    taskId = tmpId(registry.tasks)
    remote = 'pending'
  } else if (!slug) {
    // 未配置 cnb 远端（如临时目录、测试仓）：沿用旧的本地序号，并明确标注无远端锚点。
    taskId = formatId(nextSeq(registry.tasks))
    remote = 'none'
    console.error(`[warn] 未配置 cnb 远端，已用本地序号 ${taskId}；该号无远端锚点，双机并行可能撞号`)
  } else {
    try {
      const number = remoteAllocate({
        type: t,
        name,
        body: issueBody({ name, source, sourceRef, baseline }),
        priority,
        repo,
      })
      taskId = `${t}-${number}`
      remote = `cnb#${number}`
    } catch (err) {
      taskId = tmpId(registry.tasks)
      remote = 'pending'
      console.error(`[warn] 远端发号失败（${err.message}），已降级为临时号 ${taskId}，联网后请换取正式号`)
    }
  }
  const record = newRecord({ name, source, sourceRef, baseline, taskId, type: t, remote })
  if (priority) record.priority = priority
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
      console.error(
        '用法: allocate --name <任务名称> [--type FEAT|FIX|CHORE] [--priority P0..P2] [--offline]\n' +
          '        [--slug <x>] [--source <来源>] [--source-ref <x>] [--repo <path>]',
      )
      process.exit(2)
    }
    const rec = allocate(repo, {
      name,
      type: get('--type') || 'FEAT',
      priority: get('--priority') || null,
      offline: argv.includes('--offline'),
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
      console.error(
        '用法: set --task LOC-001 [--status <状态>] [--baseline V1] [--branch <b>] [--merge-commit <sha>] [--github-sync <x>]\n' +
          '        [--worktree <路径|none>] [--evidence-expires-at <iso|none>] [--evidence-cleared-at <iso|none>]\n' +
          '        [--branch-retained <true|false>] [--retention-days <n>]',
      )
      process.exit(2)
    }
    const deps = get('--deps')
    const retention = get('--retention-days')
    const rec = update(repo, taskId, {
      status: get('--status'),
      type: get('--type'),
      remote: get('--remote'),
      baseline: get('--baseline'),
      branch: get('--branch'),
      worktree: nullable(get('--worktree')),
      spec_path: nullable(get('--spec-path')),
      github_sync: get('--github-sync'),
      merge_commit: get('--merge-commit'),
      evidence_expires_at: nullable(get('--evidence-expires-at')),
      evidence_cleared_at: nullable(get('--evidence-cleared-at')),
      branch_retained: toBool(get('--branch-retained')),
      retention_days: retention ? Number(retention) : undefined,
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
