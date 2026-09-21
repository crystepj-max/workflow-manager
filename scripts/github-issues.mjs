#!/usr/bin/env node
/**
 * GitHub issue 通道（唯一真源）：批量任务源筛选 + 施工认领互斥。
 *
 * 把三件事收在一处，避免各脚本各自裸调 `gh`：
 *   1. 任务源筛选信号——`ready-for-agent`（需求清晰可执行，可交 agent 施工）；
 *   2. 施工认领信号——`施工中` 标签 + assignee + 认领评论「三件套」；
 *   3. 施工人身份——`gh` 当前登录账号 + 本机机器码 + AI 会话名 + run_id。
 *
 * 三条不可动摇的口径：
 *   - **gh 执行器可注入**（`setGhRunner`），单测离线断言，不触网；
 *   - **认领互斥靠评论二次确认**：标签检查与标签写入之间没有原子性，故认领后再读一次评论，
 *     以 claim 标记出现最早者为准；后到者主动让位（`ok:false, code:'claim-raced'`），
 *     不覆盖先到者的标签——「宁可少开工，不可重复施工」；
 *   - **失败不得静默降级**（CHORE-111 口径）：任何远端动作失败都返回明确 code + reason，
 *     由调用方决定阻断或告警，禁止悄悄按「无标签」继续。
 *
 * CLI:
 *   node scripts/github-issues.mjs mark-ready --task FIX-224 [--repo <path>]
 *   node scripts/github-issues.mjs claim --task FIX-224 --run-id fix-224-r1 [--branch <b>] [--repo <path>]
 *   node scripts/github-issues.mjs release --task FIX-224 --run-id fix-224-r1 --reason <原因> [--repo <path>]
 *   node scripts/github-issues.mjs list-ready [--repo <path>]
 *   node scripts/github-issues.mjs show --task FIX-224 [--repo <path>]
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadRegistry, resolveGitHubRemote, machineCode, agentName } from './local-task-registry.mjs'
import { githubAnchorOf } from './remote-anchors.mjs'

export const READY_LABEL = 'ready-for-agent'
export const WIP_LABEL = '施工中'

// 标签元数据：仓库缺标签时自动创建（幂等）。颜色与描述是口径的一部分，勿随手改。
export const LABEL_META = {
  [READY_LABEL]: { color: '0e8a16', description: '需求清晰可执行，可交给 agent 施工' },
  [WIP_LABEL]: { color: 'fbca04', description: '已有施工人认领，正在施工；他人请勿重复认领' },
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

// ---------- 认领 / 释放 ----------

function claimBody({ worker, claimKey, runId, branch, at, issueNumber }) {
  return [
    `## 🔧 施工中认领（${claimKey}）`,
    '',
    '| 项 | 值 |',
    '|---|---|',
    `| 施工人 | \`${worker}\` |`,
    `| run | \`${runId}\` |`,
    `| 分支 | \`${branch || '（未提供）'}\` |`,
    `| 认领时间 | ${at} |`,
    `| issue | #${issueNumber} |`,
    '',
    '> 本任务已被上述施工人认领（标签 `施工中`）。请勿重复认领；进展确认请直接找上方施工人。',
    claimMarker(claimKey),
  ].join('\n')
}

/**
 * 开工认领：打 `施工中` + assignee + 认领评论，并用评论做并发二次确认。
 *
 * @returns {{ ok: boolean, code: string, reused?: boolean, holder?: string, issue?: number, reason?: string }}
 *   code: claimed | reused | claimed-by-other | claim-raced | issue-not-open | no-anchor | dry-run
 */
export function claimIssue({ repo, taskId, runId, branch = null, actor = null, dryRun = false }) {
  const slug = repoSlug(repo)
  const { record, issue: number } = remoteAnchorOfTask(repo, taskId)
  if (!record) return { ok: false, code: 'no-task', reason: `登记册无此任务：${taskId}` }
  if (!number) {
    return { ok: false, code: 'no-anchor', reason: `任务 ${taskId} 无 github#N 锚点（remote=${record.remote ?? 'null'}），无法远端认领` }
  }

  const ident = workerIdentity({ actor: actor ?? currentActor(), agent: agentName() })
  const claimKey = `${ident.machine}/${runId}`
  if (dryRun) return { ok: true, code: 'dry-run', issue: number, worker: ident.worker, claimKey }

  ensureLabels({ slug, labels: [WIP_LABEL, READY_LABEL] })
  const before = viewIssue({ slug, number })
  if (before.state && before.state !== 'OPEN') {
    return { ok: false, code: 'issue-not-open', issue: number, reason: `issue #${number} 状态 ${before.state}，不可认领` }
  }
  if (before.labels.includes(WIP_LABEL)) {
    if (claimKeysInWindow(before.comments).includes(claimKey)) {
      return { ok: true, code: 'reused', reused: true, issue: number, worker: ident.worker, claimKey }
    }
    const holder = holderOf(before, claimKey)
    return { ok: false, code: 'claimed-by-other', issue: number, holder, reason: `issue #${number} 已被 ${holder} 认领（标签 ${WIP_LABEL}）` }
  }

  addLabels({ slug, number, labels: [WIP_LABEL] })
  const assign = addAssignees({ slug, number, logins: [ident.actor] })
  commentIssue({
    slug, number,
    body: claimBody({
      worker: ident.worker, claimKey, runId, branch,
      at: new Date().toISOString(), issueNumber: number,
    }),
  })

  // 并发二次确认：评论写入后重读，当前窗口内 claim 标记最早者胜出；
  // 不是自己就让位（不撤标签，保护先到者）。
  const after = viewIssue({ slug, number })
  const holders = claimKeysInWindow(after.comments)
  if (holders.length > 0 && holders[0] !== claimKey) {
    return { ok: false, code: 'claim-raced', issue: number, holder: holders[0], reason: `并发认领竞争：${holders[0]} 先到，本会话让位` }
  }
  return { ok: true, code: 'claimed', issue: number, worker: ident.worker, claimKey, assigned: assign.ok, assignReason: assign.ok ? null : assign.reason }
}

/**
 * 施工结束释放：去掉 `施工中` 标签并留一条结束评论。
 * 标签不存在时视为已释放（幂等），不报错。
 */
export function releaseIssue({ repo, taskId, runId = null, reason = '', outcome = '', actor = null, dryRun = false }) {
  const slug = repoSlug(repo)
  const { record, issue: number } = remoteAnchorOfTask(repo, taskId)
  if (!record) return { ok: false, code: 'no-task', reason: `登记册无此任务：${taskId}` }
  if (!number) return { ok: false, code: 'no-anchor', reason: `任务 ${taskId} 无 github#N 锚点，无远端标签可释放` }

  const ident = workerIdentity({ actor: actor ?? currentActor(), agent: agentName() })
  if (dryRun) return { ok: true, code: 'dry-run', issue: number }

  const before = viewIssue({ slug, number })
  if (!before.labels.includes(WIP_LABEL)) {
    return { ok: true, code: 'already-released', issue: number }
  }
  removeLabels({ slug, number, labels: [WIP_LABEL] })
  // 一并摘 assignee：否则「已释放」的 issue 还挂着上任施工人，下一任认领前后
  // 批次报告都会把现任认领人指认错（Bugbot #240 第 3 条）
  removeAssignees({ slug, number, logins: before.assignees })
  commentIssue({
    slug, number,
    body: [
      `## 🔓 施工结束（${outcome || '已释放'}）`,
      '',
      `- 施工人：\`${ident.worker}\``,
      runId ? `- run：\`${runId}\`` : null,
      reason ? `- 说明：${reason}` : null,
      `- 时间：${new Date().toISOString()}`,
      '',
      releaseMarker,
    ].filter((x) => x !== null).join('\n'),
  })
  return { ok: true, code: 'released', issue: number }
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

/** 给任务打「可施工」标签；幂等，已是就绪状态则 no-op。 */
export function markReady({ repo, taskId, readyLabel = READY_LABEL, dryRun = false }) {
  const slug = repoSlug(repo)
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
  if (dryRun) return { ok: true, code: 'dry-run', issue: number }

  const issue = viewIssue({ slug, number })
  // 已关闭（或已合并）的 issue 不得再被标记为「可施工」——那会把死任务重新推进施工池
  if (issue.state && issue.state !== 'OPEN') {
    return { ok: false, code: 'issue-not-open', issue: number, state: issue.state, reason: `issue #${number} 状态 ${issue.state}，不得打「可施工」标签` }
  }
  if (issue.labels.includes(readyLabel)) {
    return { ok: true, code: 'already-ready', issue: number }
  }
  ensureLabels({ slug, labels: [readyLabel] })
  addLabels({ slug, number, labels: [readyLabel] })
  return { ok: true, code: 'marked', issue: number, url: issueUrl(slug, number) }
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
