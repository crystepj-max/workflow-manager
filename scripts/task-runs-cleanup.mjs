#!/usr/bin/env node
// 证据明细到期清理 —— 约定 §1.8 的执行手段。
//
// 为什么需要它：保留期若只写在文档里，就等于「靠人记得」，等于没有。
// 本脚本把「到期」变成一条可执行的数据事实：到期项由登记册判定，清理由本脚本执行，
// 未清理由校验项 D-9 报红。三个触发点（开工顺带清 / 收口顺带清 / 校验闸门）都调它。
//
// 用法：
//   node scripts/task-runs-cleanup.mjs                 # 只读预演（默认，不删任何东西）
//   node scripts/task-runs-cleanup.mjs --apply         # 执行清理
//   node scripts/task-runs-cleanup.mjs --repo <path>   # 指定仓库
//
// 安全约束（逐条都是硬性的）：
//   1. 默认 dry-run；只有显式 --apply 才删除。
//   2. **删除前置条件**：<归档目录>/<TASK_ID>/evidence-summary.json 必须存在，
//      否则拒绝删除该项（防止误删唯一副本）。
//   3. 只删主检出产物根之内、且名字能以该任务的 RUN_ID 派生的目录。
//   4. 孤儿证据目录（无法归属任何任务）只报告、不自动删。

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadRegistry, update } from './local-task-registry.mjs'
import { mainCheckout, runsRoot } from './workspace-paths.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

function git(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim()
  } catch {
    return null
  }
}

function dirSize(p) {
  let total = 0
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name)
      const st = statSync(full)
      if (st.isDirectory()) walk(full)
      else total += st.size
    }
  }
  try {
    walk(p)
  } catch {
    /* 忽略不可读项 */
  }
  return total
}

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const repoArg = args.indexOf('--repo') >= 0 ? args[args.indexOf('--repo') + 1] : null

const root = resolve(repoArg || mainCheckout(process.cwd()) || git(process.cwd(), ['rev-parse', '--show-toplevel']) || join(HERE, '..'))
const registry = loadRegistry(root)
const runs = runsRoot(root)
const archiveRoot = join(root, 'docs', 'tasks', 'archive')
const now = Date.now()

// —— 分类：到期可清 / 到期但明细已不存在（只需登记） / 证据缺失拒处理 / 孤儿目录 ——
const due = []
const alreadyGone = []
const blocked = []
const claimed = new Set()

for (const t of registry.tasks || []) {
  if (!t.evidence_expires_at) continue
  const runId = t.branch ? t.branch.replace(/^dev-/, '') : null
  if (!runId) continue
  const expired = Date.parse(t.evidence_expires_at) < now
  const cleared = Boolean(t.evidence_cleared_at)
  // 主 run 目录 + 收口期产生的派生目录（如 <run_id>-uat-02）
  const targets = existsSync(runs)
    ? readdirSync(runs).filter((n) => n === runId || n.startsWith(`${runId}-`)).map((n) => join(runs, n))
    : []
  for (const p of targets) claimed.add(p)
  if (cleared || !expired) continue
  const summary = join(archiveRoot, t.task_id, 'evidence-summary.json')
  if (!existsSync(summary)) {
    // 约定 §1.8：摘要缺失时拒绝任何清理动作（防止误删唯一副本）。
    blocked.push({ task: t, targets, why: `缺证据摘要 ${summary}（约定 §1.8 前置条件，拒绝清理与登记）` })
    continue
  }
  if (targets.length === 0) {
    // CHORE-286：明细本就不存在时，原实现只列 pending 而不登记，导致登记册永远停在
    // 「未清理」——D-9 因此长期报红且**无法用本脚本消除**（缺口曾以「潜在」记录，
    // 2026-09-21 实测被触发）。无明细即无残留，且摘要齐备（可回溯），按已清理登记。
    alreadyGone.push({ task: t })
    continue
  }
  due.push({ task: t, targets })
}

// 孤儿目录：在产物根内但无法归属任何任务
const orphans = existsSync(runs)
  ? readdirSync(runs)
      .filter((n) => !claimed.has(join(runs, n)) && n !== 'schema')
      .map((n) => join(runs, n))
  : []

// —— 输出 ——
console.log(`证据明细到期清理 — ${apply ? '【执行模式】' : '【只读预演】'}`)
console.log(`  仓库：${root}`)
console.log(`  产物根：${runs}`)
console.log()

if (due.length === 0) console.log('✅ 无到期可清项')
for (const { task, targets } of due) {
  const bytes = targets.reduce((n, p) => n + dirSize(p), 0)
  console.log(`🔴 ${task.task_id} 到期于 ${task.evidence_expires_at}（${(bytes / 1024).toFixed(0)} KB）`)
  for (const p of targets) console.log(`     - ${p}`)
}
if (alreadyGone.length) {
  console.log()
  for (const { task } of alreadyGone)
    console.log(`⚪ ${task.task_id} 到期于 ${task.evidence_expires_at}：明细目录已不存在（摘要齐备，按已清理登记）`)
}
if (blocked.length) {
  console.log()
  for (const { task, why } of blocked) console.log(`⛔ ${task.task_id} 拒绝处理：${why}`)
}
if (orphans.length) {
  console.log()
  console.log(`⚠️ 孤儿证据目录 ${orphans.length} 个（不属于任何已登记任务，需人工判定，本脚本不动）`)
  for (const p of orphans) console.log(`     - ${p}（${(dirSize(p) / 1024).toFixed(0)} KB）`)
}

// —— 执行 ——
if (apply && (due.length || alreadyGone.length)) {
  console.log()
  console.log('—— 执行清理 ——')
  for (const { task, targets } of due) {
    for (const p of targets) {
      if (!p.startsWith(runs + '/')) {
        console.log(`  ⛔ 拒绝越界删除：${p}`)
        continue
      }
      rmSync(p, { recursive: true, force: true })
      console.log(`  ✅ 已删 ${p}`)
    }
    update(root, task.task_id, { evidence_cleared_at: new Date().toISOString() })
    console.log(`  ✅ 登记册已标记 ${task.task_id} 明细已清理`)
  }
  for (const { task } of alreadyGone) {
    update(root, task.task_id, { evidence_cleared_at: new Date().toISOString() })
    console.log(`  ✅ 登记册已标记 ${task.task_id} 明细已清理（无残留目录）`)
  }
} else if (due.length || alreadyGone.length) {
  console.log()
  console.log(`（预演结束。加 --apply 执行上述 ${due.length} 项清理${alreadyGone.length ? ` + ${alreadyGone.length} 项登记` : ''}）`)
}

process.exit(blocked.length ? 1 : 0)
