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

// 未显式指定类型时，按任务名称关键词判定维护类；其余一律视为需求迭代。
const CHORE_KEYWORDS = ['清理', '收敛', '补齐', '文档', '口径', '模板', '残留', '对齐', '验收', '度量']
const MERGED_LIKE = ['已合并', '已取消']

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


if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.error(JSON.stringify({
    ok: false,
    code: 'legacy_github_task_sync_disabled',
    reason: '旧 GitHub Task 登记同步通道已退役；GitHub 只记录代码交付事实，任务由 Multica 管理。',
    effects: '未读取 registry.json，未查询或写入 GitHub Issue。',
  }, null, 2))
  process.exitCode = 2
}
