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
 * 远端（CNB）候选不在本脚本范围：夜间远端候选永远「未纳入（缺本地定义）」不开工，
 * 只做报告性核验，由 M5 调度器按机器配置 best-effort 执行。
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

const __dirname = path.dirname(fileURLToPath(import.meta.url))

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
      return !dep || dep.status !== STATUS_MERGED
    })
    if (unmetDep) {
      exclude(`依赖未满足（${unmetDep} 登记册未记合并）`)
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
      remote: '远端核验由 M5 调度器按机器配置 best-effort 执行；远端有、本地无条目的一律「未纳入（缺本地定义）」',
    },
  }
}

function expandPath(p) {
  if (!p) return p
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
