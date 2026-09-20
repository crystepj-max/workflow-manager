#!/usr/bin/env node
/**
 * M5-1 候选采集（本地事实层）：从登记册 + run 现场筛出本批可开工任务，产出 M3
 * batch.json 兼容的候选列表。只读，不建现场、不改登记册。
 *
 * 与 M3 assessAndSort 的分工：
 *   本脚本 = 登记册状态 / 已有 run / 环境组 / 黑名单（本地事实排除）；
 *   M3 assessAndSort = 定义资料 preflight 机械门禁（规格文件与依赖 git 事实）。
 *
 * 用法：
 *   node scripts/ai-task-candidate-collect.mjs --repo <主检出> [--blacklist A,B] [--out <batch.json>]
 *
 * 远端任务源（FEAT-237）：本函数仍只做**本地事实层**筛选，不触网；GitHub 侧
 * 「ready-for-agent 就绪 + 非施工中认领」的准入判定由 planTaskSourceAdmission 承担，
 * 由 M5 调度器在拿到远端快照后调用。远端就绪但本地无定义的任务一律「未纳入」。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  loadRegistry,
  STATUS_LOCAL_DEFINED,
  STATUS_MERGED,
} from './local-task-registry.mjs'
import { runsRoot } from './workspace-paths.mjs'
import { collectMergeFacts } from './registry-reconcile.mjs'
import { githubAnchorOf } from './remote-anchors.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 远端任务源不可用时的两种处置（FEAT-237）：
//  block       —— 远端不可信时不开工（默认）。夜间批次宁可空跑并明确报错，也不在没有
//                 「可施工标签 + 认领互斥」保护的情况下拉起会话，避免重复施工。
//  local-only  —— 退回「仅本地登记册」（旧行为），必须在报告里显著标注降级。
export const REMOTE_UNAVAILABLE_POLICIES = ['block', 'local-only']

// 远端任务源排除项的 stage 名（报告归因用，与「采集闸门」「定义门禁」并列）
export const STAGE_TASK_SOURCE = '远端任务源'

// 「已定义」为兼容写法；登记册现行状态枚举中只有「本地已定义」
export const PASS_STATUSES = [STATUS_LOCAL_DEFINED, '已定义']
// 视为「已收口」的 run 阶段；其余阶段（dev/review/test/human_acceptance…）都算未收口
export const CLOSED_RUN_STAGES = new Set(['closed', 'archived', 'merged', 'cancelled'])

export function slugForTaskId(taskId) {
  // run_id 已净化形态约束（见 cwf-run-init assertRunIdSafe）：小写字母/数字/连字符
  return String(taskId).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

export function scanOpenRuns(main) {
  // 扫主检出 .agent-runs/*/run.json；读不到的条目按存在处理（宁可不重开，不重复施工）
  const root = runsRoot(main)
  if (!fs.existsSync(root)) return []
  const out = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const runJsonPath = path.join(root, entry.name, 'run.json')
    if (!fs.existsSync(runJsonPath)) continue
    try {
      const run = JSON.parse(fs.readFileSync(runJsonPath, 'utf8'))
      out.push({
        runId: run.run_id || entry.name,
        identity: run.issue_or_task_identity || null,
        stage: run.stage || null,
        workBranch: run.work_branch || null,
        open: !CLOSED_RUN_STAGES.has(run.stage),
      })
    } catch {
      out.push({ runId: entry.name, identity: null, stage: null, workBranch: null, open: true })
    }
  }
  return out
}

function taskIdsOfRecord(record) {
  // 远端 issue 与本地条目视为同一任务：同时按 task_id 与 legacy_id 匹配
  const ids = [record.task_id]
  if (record.legacy_id) ids.push(record.legacy_id)
  return ids
}

export function collectLocalCandidates({ repo, blacklist = [] }) {
  const registry = loadRegistry(repo)
  const tasks = Array.isArray(registry.tasks) ? registry.tasks : Object.values(registry.tasks || {})
  const byId = new Map(tasks.map((t) => [t.task_id, t]))
  const openRuns = scanOpenRuns(repo)
  const blacklistSet = new Set(blacklist)
  // 合并事实：以主干 git 历史为权威源，覆盖登记册状态同步滞后（FIX-76 / LOC-028 复现风险）
  // 非 git 仓库（如测试夹具）无主干历史时降级为空 Map，仅以登记册状态为准，不阻断采集
  let mergeFacts
  try {
    mergeFacts = collectMergeFacts(repo, 'main')
  } catch {
    mergeFacts = new Map()
  }

  const candidates = []
  const excluded = []

  for (const record of tasks) {
    const id = record.task_id
    const name = record.name || id
    const exclude = (reason) => excluded.push({ id, name, reason, stage: '采集闸门' })

    if (!PASS_STATUSES.includes(record.status)) {
      exclude(`状态=${record.status}（未达「本地已定义」或已流转：已合并/取消/在验收）`)
      continue
    }
    const runHit = openRuns.find((r) => {
      if (!r.open) return false
      if (r.identity && taskIdsOfRecord(record).some((tid) => r.identity === `#${tid}`)) return true
      const slug = slugForTaskId(id)
      return slug && new RegExp(`^${slug}-r\\d+$`).test(r.runId)
    })
    if (runHit) {
      exclude(`已有未收口 run（${runHit.runId} stage=${runHit.stage || '?'}；run.json 为权威事实，夜间不重开）`)
      continue
    }
    const unmetDep = (record.deps || []).find((d) => {
      const dep = byId.get(d)
      const gitMerged = mergeFacts.has(d)
      if (gitMerged) return false // 主干有合并痕迹 → 覆盖登记册同步滞后，放行
      if (!dep) return true // 登记册无此依赖且无 git 事实 → 未满足
      return dep.status !== STATUS_MERGED // 否则以登记册状态为准
    })
    if (unmetDep) {
      exclude(`依赖未满足（${unmetDep} 登记册未记合并且主干无合并痕迹）`)
      continue
    }
    if (record.env_role === '成员') {
      const leaders = tasks.filter((t) => t.env_group === record.env_group && t.env_role === '独立')
      const leaderDone = leaders.length > 0 && leaders.every((t) => t.status === STATUS_MERGED)
      if (!leaderDone) {
        exclude(`环境组先导未完成（env_group=${record.env_group || '?'} 同组「独立」任务未合并）`)
        continue
      }
    }
    if (blacklistSet.has(id)) {
      exclude('本批黑名单')
      continue
    }

    const issueBasics = record.slug
      ? path.join('docs/tasks', `${id}-${record.slug}.md`)
      : null
    candidates.push({
      id,
      name,
      priority: record.priority || null,
      registryStatus: record.status,
      issueBasics,
      taskSpec: record.spec_path || null,
    })
  }

  return {
    candidates,
    excluded,
    sourceNote: {
      local: `docs/tasks/registry.json 状态「${PASS_STATUSES.join('」或「')}」：${candidates.length} 个候选 / ${excluded.length} 个排除（共 ${tasks.length} 个任务）`,
      remote: '远端任务源（GitHub）准入由 planTaskSourceAdmission 判定；远端就绪但本地无定义的一律「未纳入」',
    },
  }
}

// ---------- 远端任务源准入（FEAT-237） ----------

/**
 * 把「本地候选」与「远端 GitHub 任务源快照」对齐，产出每个任务的开工资格判定。
 *
 * 判定优先级（先到先判，互斥）：
 *   1. `claimed`（远端带施工中标签）——已被别的施工人认领 → **硬排除**，不进施工池；
 *   2. `no-anchor`（登记册无 github#N 锚点）——无远端信号可依，默认放行并在报告标注
 *      （历史 LOC-/TMP- 任务与离线仓依赖此路径）；`requireAnchor` 打开时硬排除；
 *   3. `ready`（远端带 ready-for-agent）——放行；
 *   4. `not-ready`——放行**前置条件**是补标成功，由调用方在定义门禁之后执行
 *      （标签语义是「满足开工条件」，故不能在门禁之前补，否则会把过不了门禁的任务标记为可施工）。
 *
 * 远端不可信时按 `onUnavailable` 处置：`block`（默认）→ 全体硬排除 + `blocked:true`；
 * `local-only` → 退回仅本地候选，并在 note 里显著标注降级，绝不静默。
 *
 * 纯函数，不触网、无副作用——远端快照与注入项全部由参数传入，便于离线单测。
 */
export function planTaskSourceAdmission({
  registryTasks = [],
  candidates = [],
  readyIssues = [],
  claimedBy = new Map(),
  remoteError = null,
  onUnavailable = 'block',
  requireAnchor = false,
} = {}) {
  const verdicts = new Map()
  const preExcluded = []
  const orphans = []
  const fail = (c, reason) => preExcluded.push({ id: c.id, name: c.name, reason, stage: STAGE_TASK_SOURCE })

  if (!REMOTE_UNAVAILABLE_POLICIES.includes(onUnavailable)) {
    throw new Error(`onUnavailable 必须是 ${REMOTE_UNAVAILABLE_POLICIES.join(' / ')} 之一（收到 ${onUnavailable}）`)
  }

  if (remoteError) {
    if (onUnavailable === 'local-only') {
      return {
        available: false,
        blocked: false,
        verdicts,
        preExcluded,
        orphans,
        note: `远端任务源不可用（${remoteError}）→ 已按 local-only 降级为「仅本地登记册」：本批不做标签筛选，也不做端点认领互斥`,
      }
    }
    for (const c of candidates) fail(c, `远端任务源不可用（${remoteError}）→ 本轮不开工（onUnavailable=block）`)
    return {
      available: false,
      blocked: true,
      verdicts,
      preExcluded,
      orphans,
      note: `远端任务源不可用（${remoteError}）→ 已阻断本批全部 ${candidates.length} 个候选（宁可空跑，不冒险重复施工）`,
    }
  }

  const issueByTaskId = new Map()
  for (const r of registryTasks) {
    const n = githubAnchorOf(r.remote)
    if (n) {
      issueByTaskId.set(r.task_id, n)
      if (r.legacy_id) issueByTaskId.set(r.legacy_id, n)
    }
  }
  const candidateIds = new Set(candidates.map((c) => c.id))
  const readyNumbers = new Set(readyIssues.map((i) => Number(i.number)))
  const knownIssues = new Set([...issueByTaskId.values()])

  for (const c of candidates) {
    const issueNumber = issueByTaskId.get(c.id) ?? null
    if (issueNumber && claimedBy.has(issueNumber)) {
      const holder = claimedBy.get(issueNumber)
      verdicts.set(c.id, { status: 'claimed', issueNumber, holder })
      fail(c, `远端 issue #${issueNumber} 已被 ${holder} 认领（标签「施工中」）→ 不重复施工`)
      continue
    }
    if (!issueNumber) {
      verdicts.set(c.id, { status: 'no-anchor', issueNumber: null })
      if (requireAnchor) fail(c, '登记册无 github#N 锚点（requireAnchor=true）→ 无法取得可施工标签与认领保护')
      continue
    }
    if (readyNumbers.has(issueNumber)) {
      verdicts.set(c.id, { status: 'ready', issueNumber })
      continue
    }
    verdicts.set(c.id, { status: 'not-ready', issueNumber })
  }

  // 远端就绪、本地却进不了候选：不是本批要施工的，但必须如实报告（否则「为什么没跑」无人可查）
  for (const issue of readyIssues) {
    const number = Number(issue.number)
    const owner = [...issueByTaskId.entries()].find(([, n]) => n === number)?.[0] ?? null
    if (owner && candidateIds.has(owner)) continue
    orphans.push({
      id: `github#${number}`,
      name: issue.title || `issue #${number}`,
      reason: owner
        ? `远端已标记 ready-for-agent，但本地任务 ${owner} 未进候选（本地采集闸门未过）`
        : '远端已标记 ready-for-agent，但登记册无对应任务 → 缺本地定义（任务卡/规格未入库）',
      stage: STAGE_TASK_SOURCE,
    })
  }

  const tally = { ready: 0, notReady: 0, claimed: 0, noAnchor: 0 }
  for (const v of verdicts.values()) {
    if (v.status === 'ready') tally.ready++
    else if (v.status === 'not-ready') tally.notReady++
    else if (v.status === 'claimed') tally.claimed++
    else tally.noAnchor++
  }

  return {
    available: true,
    blocked: false,
    verdicts,
    preExcluded,
    orphans,
    tally,
    note:
      `远端任务源（GitHub）就绪 ${readyIssues.length} 个 issue：` +
      `本地候选 ${candidates.length} 个 → 已就绪 ${tally.ready} / 待补标签 ${tally.notReady} / ` +
      `他人已认领 ${tally.claimed} / 无远端锚点 ${tally.noAnchor}` +
      (orphans.length ? `；远端就绪未纳入 ${orphans.length} 个` : ''),
  }
}

/**
 * 定义门禁之后的分流：门禁已过、但远端还没打可施工标签的任务，需要先补标再放行。
 * 补标是远端写动作，故由调用方执行；本函数只给「谁需要补」。
 */
export function pendingLabelSync(eligible = [], verdicts = new Map()) {
  return (eligible || [])
    .filter((t) => verdicts.get(t.id)?.status === 'not-ready')
    .map((t) => ({ id: t.id, issueNumber: verdicts.get(t.id).issueNumber }))
}

function expandPath(p) {
  let out = String(p)
  if (out === '~') out = process.env.HOME || out
  else if (out.startsWith('~/')) out = path.join(process.env.HOME || '', out.slice(2))
  return out
}

function argValue(name, argv) {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : null
}

async function main() {
  const argv = process.argv.slice(2)
  const repo = path.resolve(expandPath(argValue('--repo', argv) || '.'))
  const blacklist = (argValue('--blacklist', argv) || '')
    .split(',').map((s) => s.trim()).filter(Boolean)
  const outPath = argValue('--out', argv)

  if (!fs.existsSync(path.join(repo, 'docs/tasks/registry.json'))) {
    console.error(`找不到登记册：${path.join(repo, 'docs/tasks/registry.json')}`)
    process.exit(2)
  }

  const result = collectLocalCandidates({ repo, blacklist })
  const payload = {
    collectedAt: new Date().toISOString(),
    repo,
    blacklist,
    ...result,
  }
  if (outPath) {
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true })
    fs.writeFileSync(path.resolve(outPath), JSON.stringify(payload, null, 2) + '\n', 'utf8')
    payload.outPath = path.resolve(outPath)
  }
  console.log(JSON.stringify(payload, null, 2))
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isCli) await main()
