#!/usr/bin/env node
/**
 * 迁移前本地任务登记册（只读历史资料）
 *
 * 当前 Task 身份与状态由 Multica 管理。CLI 写命令和旧 GitHub Task 通道已退役；
 * 历史读取须显式传入 { legacyHistoryAudit: true }；程序化写导出同样已退役。
 *
 * CLI（只读）:
 *   node scripts/local-task-registry.mjs list [--github-sync pending] [--repo <path>]
 *   node scripts/local-task-registry.mjs show --task LOC-001 [--repo <path>]
 *
 * 已退役写命令（fail-closed，稳定原因码 legacy_registry_write_disabled，W8 P0-C）：
 *   allocate / set / mark-ready / board —— 任务身份/状态/Run 以 Multica 平台为唯一真源，
 *   CLI 与模块导出均在读写或远端发号前拒绝，历史只读标记不能解锁写入。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import os from 'node:os'

// 旧编号（2026-09-15 及之前分配的历史任务）：LOC-<三位序号>，由本机计算，双机并行会撞号。
export const TASK_ID_PREFIX = 'LOC-'
export const ID_PATTERN = /^LOC-(\d{3,})$/

// 新编号（2026-09-16 起）：<类型>-<远端 issue 号>，号由 GitHub 服务端分配，本机不自己算。
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

// —— 远端发号（GitHub 主源）——
// 任务编号由 GitHub 建 issue 时服务端分配，本机不再自己算号，从根上消除双机/多会话撞号。
// 主源仓库 slug 按「URL 主机是 github.com」从 git remote 里识别，不写死远端名：
// 本仓库的主源远端叫 origin，另有 cnb（灾备镜像）与 mirror（本地镜像）两个非主源远端。

export function remoteUrls(repo) {
  try {
    const out = execFileSync('git', ['-C', repo, 'remote', '-v'], { encoding: 'utf8' })
    const map = {}
    for (const line of out.split('\n')) {
      const m = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim())
      if (m && !(m[1] in map)) map[m[1]] = m[2]
    }
    return map
  } catch {
    return {}
  }
}

/** GitHub 仓库 URL → `owner/repo`；非 GitHub 地址返回 null。 */
export function githubSlugOf(url) {
  const s = String(url || '').trim()
  const m =
    /^(?:https?:\/\/|ssh:\/\/)(?:[^@]+@)?github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(s) ||
    /^[^@\s]+@github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(s)
  return m ? m[1] : null
}

/** 主源 GitHub 远端；无 GitHub 远端时返回 null（CNB 是灾备镜像，不参与发号）。 */
export function resolveGitHubRemote(repo) {
  const candidates = Object.entries(remoteUrls(repo))
    .map(([name, url]) => ({ name, slug: githubSlugOf(url) }))
    .filter((x) => x.slug)
  if (candidates.length === 0) return null
  // fork 布局下可能同时有多个 GitHub 远端：优先约定俗成的主源名，保证跨机器结果稳定
  return candidates.find((x) => x.name === 'origin') || candidates.find((x) => x.name === 'github') || candidates[0]
}

// 兼容既有调用名：返回发号远端（GitHub 主源）的仓库 slug，取不到返回 null。
export function resolveRemoteSlug(repo) {
  const target = resolveGitHubRemote(repo)
  return target ? target.slug : null
}

export function machineCode() {
  return String(os.hostname() || 'local').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'local'
}

/**
 * 宿主/agent 自报名字的变量，按可信度排序，值即 agent 名称。
 * 只读「运行期确实存在」的变量——身份取自环境事实，不取自人工配置，
 * 避免「配置写了别人的名字」这种伪留痕（与施工认领身份同一口径）。
 */
const AGENT_SELF_REPORTED_VARS = ['AI_AGENT_NAME', 'CLIENT_INFO_IDE_TYPE']

/** 兜底：工作树根的身份文件（git 忽略），供不自报名字的 agent 写一次。 */
export const AGENT_IDENTITY_FILE = '.agent-identity'

/**
 * 解析当前会话的 agent 名称。三级取值，命中即返回；取不到返回 null，**不猜、不留空默认值**：
 *   1. 宿主自报变量（`AI_AGENT_NAME` 显式覆盖 → `CLIENT_INFO_IDE_TYPE` 宿主标识）
 *   2. 通用约定变量（任何 `*_AGENT_NAME`，新 agent 按约定命名即可自动被识别）
 *   3. 工作树根 `.agent-identity` 文件
 * 返回 null 的调用方必须显式告警，禁止静默留空（历史 87/88 条记录空的根因）。
 */
export function agentName(env = process.env, repo = process.cwd()) {
  for (const key of AGENT_SELF_REPORTED_VARS) {
    const v = String(env[key] ?? '').trim()
    if (v) return v
  }
  for (const [key, value] of Object.entries(env)) {
    if (!/_AGENT_NAME$/.test(key)) continue
    const v = String(value ?? '').trim()
    if (v) return v
  }
  const file = path.join(repo, AGENT_IDENTITY_FILE)
  if (fs.existsSync(file)) {
    const v = fs.readFileSync(file, 'utf-8').trim()
    if (v) return v
  }
  return null
}

let ghRunner = defaultGhRunner
function defaultGhRunner(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** 注入 gh 执行器（测试替身，不触网）；与 delivery-closeout-host 的 setCnbRunner 同形态。 */
export function setGhRunner(fn) {
  ghRunner = fn || defaultGhRunner
}

/**
 * 在 GitHub 主源建 issue 并取得服务端分配的编号。
 * 输出是 issue URL（形如 https://github.com/<owner>/<repo>/issues/<N>），从尾段取号；
 * `gh issue create` 不支持 --json，故不依赖结构化输出。
 * @returns {number} issue 编号
 * @throws 无 GitHub 远端、`gh` 未登录或建 issue 失败时抛错，由调用方降级为临时号
 */
export function remoteAllocate() {
  throw legacyRegistryWriteDisabledError('remoteAllocate')
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
  slug,
  source = '会话录入',
  sourceRef = '',
  baseline = 'V1',
  now = new Date().toISOString(),
  type = 'FEAT',
  remote = null,
  legacyId = null,
  repo = null,
}) {
  if (!name) throw new Error('任务名称必填（--name）')
  return {
    task_id: taskId ?? formatId(seq),
    type,
    remote,
    legacy_id: legacyId,
    origin_machine: machineCode(),
    origin_agent: agentName(process.env, repo ?? process.cwd()),
    name,
    slug: slug || slugify(name),
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
  const lines = ['# 本地任务看板（历史快照）', '', '> 仅用于追溯迁移前资料；内容不代表 Multica 当前 Task 状态。来源：旧 `docs/tasks/registry.json`。', '']
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

export const LEGACY_REGISTRY_READ_DISABLED = 'legacy_registry_read_disabled'
export const LEGACY_REGISTRY_WRITE_DISABLED = 'legacy_registry_write_disabled'

/** 历史取证是显式只读行为；未选择时须在任何 IO 前拒绝当前任务源调用。 */
export function assertLegacyHistoryAudit(opts = {}, entry = 'loadRegistry') {
  if (opts?.legacyHistoryAudit === true) return
  const error = new Error(
    `${entry} 不能把旧登记册作为当前 Task 源；当前任务请查询 Multica。` +
      '仅历史只读取证可显式传入 { legacyHistoryAudit: true }。',
  )
  error.code = LEGACY_REGISTRY_READ_DISABLED
  throw error
}

function legacyRegistryWriteDisabledError(entry) {
  const error = new Error(`${entry} 已退役：任务编号与状态由 Multica 管理，禁止写入历史登记册或远端发号。`)
  error.code = LEGACY_REGISTRY_WRITE_DISABLED
  return error
}

/** 只读历史快照，不提供当前任务状态；返回值修改不会落盘。 */
export function loadRegistry(repo, opts = {}) {
  assertLegacyHistoryAudit(opts, 'loadRegistry')
  const p = registryPath(repo)
  if (!fs.existsSync(p)) return { version: 1, revision: 0, tasks: [] }
  const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'))
  return { version: 1, revision: 0, tasks: [], ...parsed }
}

// 保留导出名供旧依赖得到明确的退役原因；任何参数均不能开启写路径。
export function saveRegistry() {
  throw legacyRegistryWriteDisabledError('saveRegistry')
}

export function allocate() {
  throw legacyRegistryWriteDisabledError('allocate')
}

export function update() {
  throw legacyRegistryWriteDisabledError('update')
}

export function writeBoard() {
  throw legacyRegistryWriteDisabledError('writeBoard')
}

// —— 旧登记册 CLI 入口退役（WFM-342）——
// Multica 平台是任务身份/状态/Run 的唯一真源；本模块 CLI 不再提供写入口。
// 四个 CLI 写命令在任何本地文件写入或 GitHub 调用之前统一拒绝：非零退出 + 稳定原因码。
// 模块写导出同样拒绝；CLI list/show 显式走只读历史路径。
const LEGACY_WRITE_REASON = LEGACY_REGISTRY_WRITE_DISABLED
const RETIRED_WRITE_COMMANDS = new Set(['allocate', 'set', 'mark-ready', 'board'])

function rejectRetiredWrite(cmd) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        code: LEGACY_WRITE_REASON,
        command: cmd,
        reason:
          '本地任务登记 CLI 写入口已退役：任务身份/状态/Run 以 Multica 平台为唯一真源，' +
          '本命令未写任何文件、未调用 GitHub。',
        remediation:
          '任务登记与状态变更改用 multica CLI（multica issue create/update/status）；只读查询仍可用 list/show。',
      },
      null,
      2,
    ),
  )
  process.exit(2)
}

// —— CLI ——
async function main(argv) {
  const cmd = argv[0]
  if (RETIRED_WRITE_COMMANDS.has(cmd)) rejectRetiredWrite(cmd)
  if (cmd === 'list' || cmd === 'show') {
    console.error('历史查阅：以下内容来自迁移前 registry.json，不代表 Multica 当前 Task 状态、负责人或开工资格。')
  }
  const get = (f) => {
    const i = argv.indexOf(f)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const repo = path.resolve(get('--repo') || process.cwd())
  // 函数作用域：mark-ready / set / show 都按 --task 取任务标识
  const taskId = get('--task')

  if (cmd === 'list') {
    const sync = get('--github-sync')
    const tasks = loadRegistry(repo, { legacyHistoryAudit: true }).tasks.filter((t) => !sync || t.github_sync === sync)
    console.log(JSON.stringify({ count: tasks.length, tasks }, null, 2))
    return
  }

  if (cmd === 'show') {
    const rec = loadRegistry(repo, { legacyHistoryAudit: true }).tasks.find((r) => r.task_id === taskId)
    if (!rec) {
      console.error(`任务不存在：${taskId}`)
      process.exit(1)
    }
    console.log(JSON.stringify(rec, null, 2))
    return
  }

  console.error('用法: list | show   # 写命令 allocate/set/mark-ready/board 已退役（legacy_registry_write_disabled）')
  process.exit(2)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // 刻意**不用**顶层 await：mark-ready 会 `await import('./github-issues.mjs')`，而后者反向
  // import 本模块。若本模块的求值被顶层 await 挂起，反向 import 会等一个永不完成的模块求值 →
  // 死锁（现象：exit 13「unsettled top-level await」、stdout 全空）。
  // 浮空 promise 让本模块先求值完成，动态 import 即可正常解析。
  main(process.argv.slice(2)).catch((e) => {
    console.error(e?.stack || String(e))
    process.exit(1)
  })
}
