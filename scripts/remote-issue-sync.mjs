#!/usr/bin/env node
/**
 * 历史登记册 ↔ GitHub Issue 同步实现。当前 CLI（包括 plan）全部退役。
 *
 * Multica 是当前 Task 身份、状态与编号的唯一真源；不要从本模块把旧 registry 作为当前任务源。
 *
 * 退役说明（WFM-158）：
 *   plan / apply / reissue 均在读取旧登记册或调用远端之前拒绝，稳定原因码为
 *   `legacy_github_task_sync_disabled`。历史纯函数仍供旧记录核对使用。
 *
 * CLI:
 *   node scripts/remote-issue-sync.mjs <command> # 已退役；不会读取登记册或访问远端
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
  console.error(JSON.stringify({
    ok: false,
    code: 'legacy_github_task_sync_disabled',
    reason: '旧 GitHub Task 登记同步通道已退役；GitHub 只记录代码交付事实，任务由 Multica 管理。',
    effects: '未读取 registry.json，未查询或写入 GitHub Issue。',
  }, null, 2))
  process.exitCode = 2
}
