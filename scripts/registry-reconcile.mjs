#!/usr/bin/env node
/**
 * 登记册账实对账（CHORE-73 第一层）：以主干 git 历史为事实源，校准登记册。
 *
 * 背景（2026-09-16 三次同型事故）：登记册是共享账本，「任务已合并」的事实却发生在
 * git 历史里——两个真相来源靠会话自觉同步，出现分叉互相覆盖、收口脚本读旧写回、
 * 远端合并后登记滞后（LOC-028 被夜间批次跳过）。
 *
 * 原理：任务合并进主干时必然留下两类痕迹——
 *   1. 提交信息尾部的任务编号：`feat: xxx (LOC-023 V2)`；
 *   2. 收口标签：`task/loc-023/v2`（旧号）或 `task/feat-012/v1`（新号）。
 * 扫描这两类痕迹即可确定性推导「已合并」事实，把登记册中状态落后于事实的条目回写。
 *
 * CLI:
 *   node scripts/registry-reconcile.mjs plan  [--repo <path>] [--base <ref>]   # 只报告差异
 *   node scripts/registry-reconcile.mjs apply [--repo <path>] [--base <ref>]   # 回写「已合并」类差异
 *
 * 只回写一类差异：git 有合并事实、登记册 status 不是「已合并」。
 * 反向差异（登记册说已合并、git 无痕迹）只报告不动——可能发生在镜像/沙箱缺历史时，
 * 回写它属于破坏性操作，须人工判断。
 *
 * 漏标校验（2026-09-21 事故追加）：本地有施工痕迹（worktree 施工分支 / .agent-runs 运行目录）
 * 但远端 issue 无「施工中」标签时，调度器认领互斥失明、会重复施工（远端是唯一准绳，准入不改）。
 * 此类差异并入 suspicious 只报告不自动处理，交人工补标或清理。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { loadRegistry, saveRegistry, writeBoard } from './local-task-registry.mjs'
import { githubAnchorOf } from './remote-anchors.mjs'

const MERGED_STATUS = '已合并'

/** 从提交信息提取任务号：匹配 `(LOC-001 V2)` / `(FEAT-12 V1)` 这类收口尾部 */
const TASK_REF_IN_SUBJECT = /[(（]((?:LOC-\d{3,}|(?:FEAT|FIX|CHORE)-\d+))\s+V\d+[)）]/

/** 收口标签：task/loc-023/v2、task/feat-012/v1 */
const TAG_PATTERN = (taskId) => new RegExp(`^task/${taskId.toLowerCase().replace(/-/g, '-')}/v`, 'i')

/**
 * 扫描主干历史，收集每个任务号的合并事实。
 * @returns {Map<string, {commit: string, mergedAt: string, subject: string, via: string}>}
 */
export function collectMergeFacts(repo, baseRef = 'main') {
  const log = execFileSync(
    'git', ['-C', repo, 'log', baseRef, '--date=iso-strict', '--format=%H%x09%aI%x09%s'],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  )
  const tags = execFileSync('git', ['-C', repo, 'tag', '--list', 'task/*'], { encoding: 'utf8' })
    .split('\n').filter(Boolean)
  const tagIndex = new Map()
  for (const tag of tags) {
    const m = /^task\/(.+?)\/v/i.exec(tag)
    if (m) tagIndex.set(m[1].toUpperCase(), tag)
  }
  const facts = new Map()
  for (const line of log.split('\n')) {
    if (!line) continue
    const [commit, date, subject] = line.split('\t')
    const m = TASK_REF_IN_SUBJECT.exec(subject)
    if (m) {
      const id = m[1]
      if (!facts.has(id)) facts.set(id, { commit, mergedAt: date, subject, via: '提交信息' })
    }
  }
  // 标签事实：凡有收口标签的任务号，也记为已合并（提交信息可能被改写，标签是收口脚本的正式产物）
  for (const [id, tag] of tagIndex) {
    if (!facts.has(id)) {
      try {
        const commit = execFileSync('git', ['-C', repo, 'rev-list', '-1', tag], { encoding: 'utf8' }).trim()
        if (commit) facts.set(id, { commit, mergedAt: execFileSync('git', ['-C', repo, 'log', '-1', '--format=%aI', commit], { encoding: 'utf8' }).trim(), subject: `收口标签 task/${id.toLowerCase()}`, via: '收口标签' })
      } catch { /* 标签指向不可达时跳过 */ }
    }
  }
  return facts
}

// ----- 漏标校验（2026-09-21 事故）-----
// 事故形态：会话绕过 cwf-run-init 开工（无「施工中」标签、登记册 runs 未登记），
// 调度器认领互斥只认远端标签，于是同一任务被夜间批次重复施工。
// 远端是唯一准绳（准入不改），本校验只在对账时把「本地有施工痕迹、远端未认领」报成可疑差异，
// 交人工补标或处理；不自动补标——标签语义是「需求清晰可执行」，认领语义归开工入口。

const WIP_LABEL = '施工中' // 与 cwf-run-init / machine.json taskSource.wipLabel 同一口径
const TASK_REF_RE = /((?:FEAT|FIX|CHORE|LOC)-\d+)/i
const OPENABLE_STATUSES = new Set(['已定义', '本地已定义'])

/** 从任务的远端锚点字段提取 GitHub issue 号；复用 githubAnchorOf 正确解析双锚点，非 GitHub 锚点返回 null */
export function issueNumberOf(task) {
  const fromRemote = githubAnchorOf(String(task.remote || ''))
  if (fromRemote) return fromRemote
  // github_sync 兜底只认精确形态（synced#N / #N），避免把其他系统的号当 GitHub
  const m = /^(?:synced)?#(\d+)$/i.exec(String(task.github_sync || '').trim())
  return m ? Number(m[1]) : null
}

/**
 * 扫描本地施工痕迹（worktree 施工分支 + .agent-runs 运行目录），按任务号归集证据。
 * 已并入 baseRef 的分支、登记状态已终结（已合并/已取消）的任务不算痕迹。
 * @returns {Map<string, string[]>} taskIdUpper -> 证据描述列表
 */
export function collectLocalConstructionSignals(repo, registry, baseRef = 'main') {
  const terminal = new Set(['已合并', '已取消'])
  const evidence = new Map()
  const add = (taskIdUpper, ev) => {
    if (!evidence.has(taskIdUpper)) evidence.set(taskIdUpper, [])
    const list = evidence.get(taskIdUpper)
    if (!list.includes(ev)) list.push(ev)
  }
  const branchMergedIntoBase = (branch) => {
    try {
      execFileSync('git', ['-C', repo, 'merge-base', '--is-ancestor', branch, baseRef], { stdio: 'ignore' })
      return true
    } catch { return false }
  }
  // worktree 施工分支：分支名含任务号（docs/* 定义分支与无任务号的分支天然不匹配）
  const wt = execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' })
  for (const block of wt.split('\n\n')) {
    const m = /^branch refs\/heads\/(.+)$/m.exec(block)
    if (!m) continue // 主检出 / detached / bare
    const branch = m[1]
    const idMatch = TASK_REF_RE.exec(branch)
    if (!idMatch) continue
    const id = idMatch[1].toUpperCase()
    const task = registry.tasks.find((t) => t.task_id.toUpperCase() === id)
    if (task && terminal.has(task.status)) continue
    if (branchMergedIntoBase(branch)) continue
    add(id, `worktree 施工分支 ${branch}（未并入 ${baseRef}）`)
  }
  // .agent-runs 运行目录：<task>-r<N> 形态
  const runsDir = path.join(repo, '.agent-runs')
  if (fs.existsSync(runsDir)) {
    for (const name of fs.readdirSync(runsDir, { withFileTypes: true })) {
      if (!name.isDirectory()) continue
      const m = /^(.+)-r\d+$/.exec(name.name)
      if (!m) continue
      const idMatch = TASK_REF_RE.exec(m[1])
      if (!idMatch) continue
      const id = idMatch[1].toUpperCase()
      const task = registry.tasks.find((t) => t.task_id.toUpperCase() === id)
      if (task && terminal.has(task.status)) continue
      add(id, `.agent-runs/${name.name}/ 运行记录`)
    }
  }
  return evidence
}

/**
 * 漏标告警：可开工态任务有本地施工痕迹，但远端 issue 无「施工中」标签。
 * @param {{repo: string, registry: object, baseRef?: string, listWip?: (repo: string) => Set<number> | null}} args
 *   listWip 缺省用 gh 查询；返回 null 表示远端不可用（本次校验降级跳过，不误报）。
 * @returns {{ alerts: Array<{task_id: string, note: string}>, skipped: boolean }}
 */
export function unclaimedConstructionAlerts({ repo, registry, baseRef = 'main', listWip = realListWipIssueNumbers }) {
  const signals = collectLocalConstructionSignals(repo, registry, baseRef)
  if (!signals.size) return { alerts: [], skipped: false }
  let wipNumbers
  try {
    wipNumbers = listWip(repo)
  } catch {
    wipNumbers = null
  }
  if (wipNumbers === null) return { alerts: [], skipped: true }
  const alerts = []
  for (const t of registry.tasks) {
    const ev = signals.get(t.task_id.toUpperCase())
    if (!ev || !OPENABLE_STATUSES.has(t.status)) continue
    const num = issueNumberOf(t)
    if (!num) continue
    if (wipNumbers.has(num)) continue
    alerts.push({
      task_id: t.task_id,
      note: `本地施工痕迹（${ev.join('、')}）但远端 issue #${num} 无「${WIP_LABEL}」标签 → 认领信号缺失，调度器会重复施工；请人工核对补标或清理痕迹`,
    })
  }
  return { alerts, skipped: false }
}

/** 查询远端已带「施工中」标签的 issue 号集合；GitHub 不可用时返回 null（调用方降级） */
export function realListWipIssueNumbers(repo) {
  let url
  try {
    url = execFileSync('git', ['-C', repo, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
  const m = /github\.com[/:](.+?\/.+?)(?:\.git)?\/?$/.exec(url)
  if (!m) return null // 非 GitHub 远端：无标签体系，降级
  try {
    const out = execFileSync('gh', ['issue', 'list', '--repo', m[1], `--label=${WIP_LABEL}`, '--state', 'all', '--limit', '500', '--json', 'number'], { encoding: 'utf8' })
    return new Set(JSON.parse(out).map((i) => i.number))
  } catch {
    return null
  }
}

/**
 * 对账：登记册 vs git 事实。
 * @returns {{ toMerge: Array, suspicious: Array, ok: number }}
 *   toMerge —— git 有合并事实、登记册未记合并（可自动回写）
 *   suspicious —— 登记册记了已合并、git 无对应事实；以及本地施工痕迹但远端未认领（只报告，不自动改）
 */
export function reconcilePlan(repo, baseRef = 'main', opts = {}) {
  const registry = loadRegistry(repo)
  const facts = collectMergeFacts(repo, baseRef)
  const toMerge = []
  const suspicious = []
  let ok = 0
  for (const t of registry.tasks) {
    const fact = facts.get(t.task_id)
    if (t.status === MERGED_STATUS) {
      if (!fact && !t.merge?.commit) suspicious.push({ task_id: t.task_id, note: '登记为已合并但主干无合并痕迹' })
      else ok++
      continue
    }
    if (['已取消'].includes(t.status)) { ok++; continue }
    if (fact) toMerge.push({ task_id: t.task_id, ...fact })
  }
  const { alerts, skipped } = unclaimedConstructionAlerts({ repo, registry, baseRef, listWip: opts.listWip })
  suspicious.push(...alerts)
  return { toMerge, suspicious, ok, total: registry.tasks.length, unclaimedSkipped: skipped }
}

function applyReconcile(repo, baseRef) {
  const registry = loadRegistry(repo)
  const facts = collectMergeFacts(repo, baseRef)
  const changed = []
  for (const t of registry.tasks) {
    if (t.status === MERGED_STATUS || ['已取消'].includes(t.status)) continue
    const fact = facts.get(t.task_id)
    if (!fact) continue
    t.status = MERGED_STATUS
    t.merge = { ...(t.merge || {}), commit: fact.commit, merged_at: fact.mergedAt }
    t.updated_at = new Date().toISOString()
    changed.push(`${t.task_id} → 已合并（${fact.commit.slice(0, 7)} @ ${fact.mergedAt.slice(0, 10)}，via ${fact.via}）`)
  }
  saveRegistry(repo, registry)
  writeBoard(repo)
  return changed
}

export { applyReconcile as apply }

function main() {
  const cmd = process.argv[2]
  const get = (f) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : undefined }
  const repo = path.resolve(get('--repo') || process.cwd())
  const baseRef = get('--base') || 'main'
  if (cmd === 'plan') {
    const r = reconcilePlan(repo, baseRef)
    console.log(JSON.stringify({ total: r.total, ok: r.ok, toMerge: r.toMerge, suspicious: r.suspicious, unclaimedSkipped: r.unclaimedSkipped }, null, 2))
    return
  }
  if (cmd === 'apply') {
    const changed = applyReconcile(repo, baseRef)
    // 回写后再审计：漏标校验用回写后的状态，已合并任务不误报
    const audit = reconcilePlan(repo, baseRef)
    console.log(JSON.stringify({ changedCount: changed.length, changed, suspicious: audit.suspicious, unclaimedSkipped: audit.unclaimedSkipped }, null, 2))
    return
  }
  console.error('用法: registry-reconcile plan | apply [--repo <path>] [--base <ref>]')
  process.exit(2)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
