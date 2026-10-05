#!/usr/bin/env node
/**
 * 任务登记册 ↔ 远端 issue 同步（只读 plan；写入口已退役）
 *
 * 用途：
 *   plan：只读列出「活跃、但还没有远端号（或仍是临时号）」的任务，不建号、不回写。
 *
 * 退役说明（WFM-158）：
 *   apply / reissue 属旧双账本写路径，会在 GitHub/CNB 建 issue 并回写 registry/BOARD。
 *   Multica 已成为内部 Task 身份、状态与编号的唯一真源，该写路径整体退役，不迁移、不重建。
 *   调用 apply / reissue 会在任何远端发号与账本回写之前被拒绝：非零退出 + 稳定
 *   reasonCode `legacy_remote_issue_sync_disabled`。回退方式仅为撤销对应 PR，不恢复旧写路径。
 *
 * CLI:
 *   node scripts/remote-issue-sync.mjs plan [--repo <path>] [--only LOC-016,LOC-018]
 *   node scripts/remote-issue-sync.mjs apply   # 已退役：拒绝并给出 legacy_remote_issue_sync_disabled
 *   node scripts/remote-issue-sync.mjs reissue # 已退役：同上
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadRegistry, resolveRemoteSlug } from './local-task-registry.mjs'

// 未显式指定类型时，按任务名称关键词判定维护类；其余一律视为需求迭代。
const CHORE_KEYWORDS = ['清理', '收敛', '补齐', '文档', '口径', '模板', '残留', '对齐', '验收', '度量']
const MERGED_LIKE = ['已合并', '已取消']

// 旧双账本写入口退役的稳定 reasonCode（WFM-158）。
const LEGACY_WRITE_REASON_CODE = 'legacy_remote_issue_sync_disabled'

export function guessType(task) {
  const n = String(task?.name ?? '')
  return CHORE_KEYWORDS.some((k) => n.includes(k)) ? 'CHORE' : 'FEAT'
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

// 在任何远端发号或 registry/BOARD 回写之前拒绝旧写入口。
function refuseLegacyWrite(cmd) {
  console.error(
    `${cmd} 已退役（legacy 双账本写路径已拆除）：reasonCode=${LEGACY_WRITE_REASON_CODE}。` +
      '不再创建远端 issue，也不回写 registry/BOARD；任务编号与状态以 Multica 为唯一真源。',
  )
  process.exit(3)
}

function main(argv) {
  const cmd = argv[0]
  const get = (f) => {
    const i = argv.indexOf(f)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const repo = path.resolve(get('--repo') || process.cwd())
  const only = get('--only') ? get('--only').split(',').map((s) => s.trim()).filter(Boolean) : null

  if (cmd === 'plan') {
    console.log(JSON.stringify(plan(repo, only), null, 2))
    return
  }
  if (cmd === 'apply' || cmd === 'reissue') {
    refuseLegacyWrite(cmd)
  }
  console.error('用法: plan | apply(已退役) | reissue(已退役)')
  process.exit(2)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
}
