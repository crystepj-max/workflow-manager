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
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { loadRegistry, saveRegistry, writeBoard } from './local-task-registry.mjs'

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

/**
 * 对账：登记册 vs git 事实。
 * @returns {{ toMerge: Array, suspicious: Array, ok: number }}
 *   toMerge —— git 有合并事实、登记册未记合并（可自动回写）
 *   suspicious —— 登记册记了已合并、git 无对应事实（只报告，不自动改）
 */
export function reconcilePlan(repo, baseRef = 'main') {
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
  return { toMerge, suspicious, ok, total: registry.tasks.length }
}

function apply(repo, baseRef) {
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

function main() {
  const cmd = process.argv[2]
  const get = (f) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : undefined }
  const repo = path.resolve(get('--repo') || process.cwd())
  const baseRef = get('--base') || 'main'
  if (cmd === 'plan') {
    const r = reconcilePlan(repo, baseRef)
    console.log(JSON.stringify({ total: r.total, ok: r.ok, toMerge: r.toMerge, suspicious: r.suspicious }, null, 2))
    return
  }
  if (cmd === 'apply') {
    const changed = apply(repo, baseRef)
    console.log(JSON.stringify({ changedCount: changed.length, changed }, null, 2))
    return
  }
  console.error('用法: registry-reconcile plan | apply [--repo <path>] [--base <ref>]')
  process.exit(2)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
