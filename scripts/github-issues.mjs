#!/usr/bin/env node
/**
 * GitHub issue 通道：**任务管理写入口已停用，仅保留只读与纯函数**。
 *
 * 治理口径（W8 迁移，WFM-166）：Multica Task 是任务身份 / 状态 / 负责人 / 关系 / 施工互斥的
 * 唯一真源；GitHub 只留 PR / commit / review / CI 等代码交付事实，不再当第二套任务账本。
 * 因此旧「批量任务源筛选 + 施工认领互斥」的**写**路径整体 fail-closed，读路径与纯函数保留。
 *
 * 已停用（fail-closed，稳定原因码 `legacy_github_issue_write_disabled`，CLI 非零退出）：
 *   - API：markReady、claimIssue、releaseIssue
 *   - CLI：mark-ready、claim、release
 *   以上在**任何 GitHub / registry / BOARD 或其他外部写之前**即拒绝，绝不先调 `gh` 探测或打标。
 *   施工互斥改由 Multica 人工单写者把关；本模块不提供原子互斥或跨机器安全保证。
 *
 * 仍保留（只读 / 纯函数，供任务源快照与既有调用方使用）：
 *   - API：listReadyIssues、viewIssue、listLabels、fetchTaskSource、repoSlug、currentActor、
 *          workerIdentity、claimKeysInWindow、remoteAnchorOfTask、issueUrl、setGhRunner 等
 *   - CLI：list-ready、show
 *   只读动作仍按原口径可注入 `gh` 执行器（`setGhRunner`，离线单测不触网）；读失败仍如实抛错，
 *   由调用方决定阻断或降级（CHORE-111 口径），不得静默降级。
 *
 * CLI:
 *   node scripts/github-issues.mjs list-ready [--repo <path>]
 *   node scripts/github-issues.mjs show --task FIX-224 [--repo <path>]
 *   # 旧写命令（mark-ready / claim / release）保留为拒绝壳：稳定返回停用原因码并以非零退出。
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadRegistry, resolveGitHubRemote, machineCode } from './local-task-registry.mjs'
import { githubAnchorOf } from './remote-anchors.mjs'

export const READY_LABEL = 'ready-for-agent'
export const WIP_LABEL = '施工中'

// 标签元数据：仓库缺标签时自动创建（幂等）。颜色与描述是口径的一部分，勿随手改。
export const LABEL_META = {
  [READY_LABEL]: { color: '0e8a16', description: '需求清晰可执行，可交给 agent 施工' },
  [WIP_LABEL]: { color: 'fbca04', description: '已有施工人认领，正在施工；他人请勿重复认领' },
}

// 旧任务管理写入口的稳定停用原因码（对外契约，勿改字面）：调用方据此识别与阻断。
export const LEGACY_GITHUB_ISSUE_WRITE_DISABLED = 'legacy_github_issue_write_disabled'

/**
 * 写入口统一拒绝壳：在任何 GitHub / registry / BOARD 或其他外部写之前 fail-closed。
 * 不调用 `gh`、不探测 issue 状态、不打标签；只返回可识别的稳定原因码 + 说明。
 */
function legacyIssueWriteDisabled(entry) {
  return {
    ok: false,
    code: LEGACY_GITHUB_ISSUE_WRITE_DISABLED,
    entry,
    reason:
      `旧 GitHub issue 任务管理写入口已停用（${entry}）：任务身份 / 状态 / 负责人 / 施工互斥以 Multica 为准，` +
      `GitHub 仅留 PR/commit/review/CI 交付事实；本入口不再写 issue 标签 / assignee / 评论，也不再调用 gh。` +
      `开工互斥须先在 Multica 确保人工单写者（此处没有原子互斥或跨机器安全保证）。`,
  }
}

// ---------- gh 执行器（可注入） ----------

let ghRunner = defaultGhRunner
function defaultGhRunner(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** 注入 gh 执行器（测试替身，不触网）；与 local-task-registry 的 setGhRunner 同形态。 */
export function setGhRunner(fn) {
  ghRunner = fn || defaultGhRunner
}

function runGh(args) {
  return String(ghRunner(args) ?? '')
}

const ISSUE_JSON_FIELDS = 'number,title,state,labels,assignees,url'

function ghJson(args) {
  const out = runGh(args).trim()
  if (!out) return null
  return JSON.parse(out)
}

function normalizeIssue(raw) {
  if (!raw) return null
  return {
    number: Number(raw.number),
    title: String(raw.title ?? ''),
    state: String(raw.state ?? ''),
    labels: (raw.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)),
    assignees: (raw.assignees ?? []).map((a) => (typeof a === 'string' ? a : a.login)),
    url: String(raw.url ?? ''),
    // 只看 `--json comments` 时才有；认领互斥依赖它的顺序（GitHub 按时间升序返回）
    comments: (raw.comments ?? []).map((c) => ({
      body: String(c.body ?? ''),
      author: c.author?.login ?? null,
      createdAt: c.createdAt ?? null,
    })),
  }
}

// ---------- 仓库与任务锚点 ----------

/** GitHub 主源 `owner/repo`；无 GitHub 远端时抛错（禁止回落到 CNB）。 */
export function repoSlug(repo) {
  const target = resolveGitHubRemote(repo)
  if (!target) throw new Error('未找到 GitHub 主源远端，无法执行 GitHub issue 通道动作')
  return target.slug
}

/**
 * 任务标识 → 远端锚点（唯一依据是登记册 `remote` 字段，不猜 issue 标题）。
 * @returns {{ record: object|null, issue: number|null, anchors: {system:string,issue:number}[] }}
 */
export function remoteAnchorOfTask(repo, taskId) {
  const record = loadRegistry(repo).tasks.find((t) => t.task_id === taskId || t.legacy_id === taskId) || null
  if (!record) return { record: null, issue: null, anchors: [] }
  const issue = githubAnchorOf(record.remote)
  return { record, issue, anchors: issue ? [{ system: 'github', issue }] : [] }
}

export function issueUrl(slug, number) {
  return `https://github.com/${slug}/issues/${number}`
}

// ---------- 基础动作 ----------

export function listReadyIssues({ slug, readyLabel = READY_LABEL, limit = 500 }) {
  const raw = ghJson([
    'issue', 'list', '--repo', slug,
    '--label', readyLabel,
    '--state', 'open',
    '--limit', String(limit),
    '--json', ISSUE_JSON_FIELDS,
  ]) || []
  return raw.map(normalizeIssue)
}

export function viewIssue({ slug, number }) {
  return normalizeIssue(ghJson(['issue', 'view', String(number), '--repo', slug, '--json', `${ISSUE_JSON_FIELDS},comments`]))
}

export function listLabels({ slug }) {
  const raw = ghJson(['label', 'list', '--repo', slug, '--limit', '200', '--json', 'name']) || []
  return raw.map((l) => l.name)
}

/** 幂等创建标签：已存在则不动作（避免依赖 `gh label create` 的报错文案）。 */
export function ensureLabels({ slug, labels }) {
  const existing = new Set(listLabels({ slug }))
  const created = []
  for (const name of labels) {
    if (existing.has(name)) continue
    const meta = LABEL_META[name] || { color: 'ededed', description: '' }
    runGh(['label', 'create', name, '--repo', slug, '--color', meta.color, '--description', meta.description])
    created.push(name)
  }
  return created
}

export function addLabels({ slug, number, labels }) {
  if (!labels.length) return
  runGh(['issue', 'edit', String(number), '--repo', slug, '--add-label', labels.join(',')])
}

export function removeLabels({ slug, number, labels }) {
  if (!labels.length) return
  runGh(['issue', 'edit', String(number), '--repo', slug, '--remove-label', labels.join(',')])
}

export function commentIssue({ slug, number, body }) {
  runGh(['issue', 'comment', String(number), '--repo', slug, '--body', body])
}

/** assignee 只是「便于找人」的增强：失败不改变认领结论，故单独包一层 best-effort。 */
export function addAssignees({ slug, number, logins }) {
  const list = (logins || []).filter(Boolean)
  if (!list.length) return { ok: false, reason: '无可用 GitHub 账号（未登录或未配置）' }
  try {
    runGh(['issue', 'edit', String(number), '--repo', slug, '--add-assignee', list.join(',')])
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: String(e.message || e).slice(0, 200) }
  }
}

/**
 * 摘除 assignee（释放时清场）。
 * 必须做：否则「已释放」的 issue 仍挂着上任施工人，批次报告会把现任认领人指认错（Bugbot 审查 #240 第 3 条）。
 */
export function removeAssignees({ slug, number, logins }) {
  const list = (logins || []).filter(Boolean)
  if (!list.length) return { ok: true }
  try {
    runGh(['issue', 'edit', String(number), '--repo', slug, '--remove-assignee', list.join(',')])
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: String(e.message || e).slice(0, 200) }
  }
}

/** 当前 gh 登录账号（施工人的权威来源，比手写配置可靠）。 */
export function currentActor() {
  try {
    const me = ghJson(['api', 'user'])
    return me && me.login ? String(me.login) : null
  } catch {
    return null
  }
}

// ---------- 施工人身份 ----------

/**
 * 施工人 = GitHub 登录账号 @ 机器码（AI 会话名可选）。
 * 单机自测（无 gh 登录）时退回机器码，不阻断本地流程。
 */
export function workerIdentity({ actor, machine = machineCode(), agent = null } = {}) {
  const base = actor ? `${actor}@${machine}` : machine
  return { worker: agent ? `${base}（${agent}）` : base, actor: actor || null, machine, agent: agent || null }
}

export const claimMarker = (claimKey) => `<!-- wip-claim:${claimKey} -->`
export const releaseMarker = '<!-- wip-release -->'

/**
 * 当前认领窗口内的 claim 标记（按评论顺序）。
 * 只取**最后一次释放之后**的标记：释放-重新认领是常态，若把历史标记也算进来，
 * 「现任施工人」会指向早已释放的旧认领（真机实测踩到过）。
 */
export function claimKeysInWindow(comments = []) {
  let start = 0
  comments.forEach((c, i) => {
    if (String(c.body ?? '').includes(releaseMarker)) start = i + 1
  })
  const keys = []
  for (const c of comments.slice(start)) {
    const m = /<!--\s*wip-claim:([^\s>]+)\s*-->/.exec(String(c.body ?? ''))
    if (m) keys.push(m[1])
  }
  return keys
}

/** 现任施工人 = 当前窗口内最早的认领标记；认不出时退回 assignee，再退回给定兜底串。 */
function holderOf(issue, fallback = '未知施工人') {
  const keys = claimKeysInWindow(issue?.comments || [])
  if (keys.length) return keys[0]
  const a = (issue?.assignees || [])[0]
  return a ? `${a}（assignee）` : fallback
}

// ---------- 认领 / 释放（写入口已停用） ----------

/**
 * 开工认领：**写入口已停用**。在任何 GitHub / registry / BOARD 或其他外部写之前 fail-closed，
 * 不打 `施工中` 标签、不指派 assignee、不留认领评论，也不调用 `gh`。
 * 仍保留只读的 `no-task` / `no-anchor` 前置判定（仅读登记册，不碰 gh），便于调用方区分「任务不存在」
 * 与「写入口停用」。施工互斥由 Multica 人工单写者把关。
 *
 * @returns {{ ok: boolean, code: string, reason: string, issue?: number }}
 */
export function claimIssue({ repo, taskId, runId = null, branch = null, actor = null, dryRun = false }) {
  const { record, issue: number } = remoteAnchorOfTask(repo, taskId)
  if (!record) return { ok: false, code: 'no-task', reason: `登记册无此任务：${taskId}` }
  if (!number) {
    return { ok: false, code: 'no-anchor', reason: `任务 ${taskId} 无 github#N 锚点（remote=${record.remote ?? 'null'}），无法远端认领` }
  }
  return legacyIssueWriteDisabled('claimIssue')
}

/**
 * 施工结束释放：**写入口已停用**。不摘 `施工中` 标签、不摘 assignee、不留结束评论，也不调用 `gh`。
 * 保留只读的 `no-task` / `no-anchor` 前置判定。
 */
export function releaseIssue({ repo, taskId, runId = null, reason = '', outcome = '', actor = null, dryRun = false }) {
  const { record, issue: number } = remoteAnchorOfTask(repo, taskId)
  if (!record) return { ok: false, code: 'no-task', reason: `登记册无此任务：${taskId}` }
  if (!number) return { ok: false, code: 'no-anchor', reason: `任务 ${taskId} 无 github#N 锚点，无远端标签可释放` }
  return legacyIssueWriteDisabled('releaseIssue')
}

// ---------- 任务源快照 ----------

/**
 * 远端任务源快照：一次拉齐「已就绪」与「已被认领」两个集合。
 * `claimed` 是 `ready` 的子集（带 `施工中` 标签者），分开给调用方，便于分别归因。
 *
 * 认领人取自 issue 评论里的认领标记（当前窗口内最早者），**不用 assignee**：
 * assignee 可能因手动指派或未清场而过期，而认领标记是认领动作本身留下的痕迹。
 */
export function fetchTaskSource({ repo, readyLabel = READY_LABEL, wipLabel = WIP_LABEL, limit = 500 }) {
  const slug = repoSlug(repo)
  const ready = listReadyIssues({ slug, readyLabel, limit })
  const claimed = ready.filter((i) => i.labels.includes(wipLabel))
  const claimedBy = new Map()
  for (const issue of claimed) {
    let holder = (issue.assignees || [])[0] || '未知施工人'
    try {
      const full = viewIssue({ slug, number: issue.number }) // 含 comments，才能解析认领标记
      holder = holderOf(full, holder)
    } catch {
      // 读不到评论就退回 assignee：批次报告宁可略粗，不可因单个 issue 查询失败而中断
    }
    claimedBy.set(issue.number, holder)
  }
  return { slug, ready, claimed, claimedBy }
}

/** 给任务打「可施工」标签：**写入口已停用**。在任何外部写之前 fail-closed，不打标签、不调用 `gh`。
 *  保留只读的 `no-task` / `no-anchor` 前置判定（仅读登记册），其中 `no-anchor` 的换号指引文案保持不变。 */
export function markReady({ repo, taskId, readyLabel = READY_LABEL, dryRun = false }) {
  const { record, issue: number } = remoteAnchorOfTask(repo, taskId)
  if (!record) return { ok: false, code: 'no-task', reason: `登记册无此任务：${taskId}` }
  if (!number) {
    return {
      ok: false,
      code: 'no-anchor',
      remote: record.remote ?? null,
      reason: `任务 ${taskId} 无 github#N 锚点（remote=${record.remote ?? 'null'}）：先换取正式号，再打「可施工」标签`,
    }
  }
  return legacyIssueWriteDisabled('markReady')
}

// ---------- CLI ----------
function parseArgv(argv) {
  const get = (f) => {
    const i = argv.indexOf(f)
    return i >= 0 ? argv[i + 1] : undefined
  }
  return { argv, get }
}

function print(result) {
  console.log(JSON.stringify(result, null, 2))
  return result.ok ? 0 : 1
}

function main(argv) {
  const cmd = argv[0]
  const { get } = parseArgv(argv)
  const repo = path.resolve(get('--repo') || process.cwd())
  const taskId = get('--task')

  if (cmd === 'mark-ready') {
    if (!taskId) { console.error('用法: mark-ready --task <任务标识> [--repo <path>]'); process.exit(2) }
    process.exit(print(markReady({ repo, taskId, dryRun: argv.includes('--dry-run') })))
  }
  if (cmd === 'claim') {
    const runId = get('--run-id')
    if (!taskId || !runId) { console.error('用法: claim --task <任务标识> --run-id <run_id> [--branch <b>] [--repo <path>]'); process.exit(2) }
    process.exit(print(claimIssue({ repo, taskId, runId, branch: get('--branch') || null, dryRun: argv.includes('--dry-run') })))
  }
  if (cmd === 'release') {
    if (!taskId) { console.error('用法: release --task <任务标识> [--run-id <run_id>] [--reason <原因>] [--outcome <结果>] [--repo <path>]'); process.exit(2) }
    process.exit(print(releaseIssue({
      repo, taskId, runId: get('--run-id') || null, reason: get('--reason') || '',
      outcome: get('--outcome') || '', dryRun: argv.includes('--dry-run'),
    })))
  }
  if (cmd === 'list-ready') {
    const snap = fetchTaskSource({ repo })
    console.log(JSON.stringify({
      slug: snap.slug,
      ready: snap.ready.map((i) => ({ number: i.number, title: i.title, claimed: i.labels.includes(WIP_LABEL), assignees: i.assignees })),
    }, null, 2))
    return
  }
  if (cmd === 'show') {
    if (!taskId) { console.error('用法: show --task <任务标识> [--repo <path>]'); process.exit(2) }
    const { record, issue } = remoteAnchorOfTask(repo, taskId)
    console.log(JSON.stringify({ task_id: taskId, remote: record?.remote ?? null, issue, url: issue ? issueUrl(repoSlug(repo), issue) : null }, null, 2))
    return
  }

  console.error('用法: mark-ready | claim | release | list-ready | show')
  process.exit(2)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
}
