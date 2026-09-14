#!/usr/bin/env node
// 建设工作流 Run 引导：从 target 创建分支 + worktree + run 目录 + portable run identity
// 用法（可在任意工作树内执行——路径一律由主检出派生，不依赖当前目录）：
//   node scripts/cwf-run-init.mjs <issue_id> <run_id> [--base <ref>] [--budget <n>]
// 产物（见 docs/design/workspace-directory-convention.md §1.4 / §1.6）：
//   worktree：<主检出父目录>/<仓库名>-worktrees/<分支名>/   ← 相邻容器，禁止位于仓库内
//   run 目录：<主检出>/.agent-runs/<run_id>/run.json          ← 锚定主检出，不写进工作树
//   开发 DSH 为**单实例固定端口**（约定 §决策六）：不再分配每 Run 独占 Home，
//   env_resources 只登记「本任务插件命名空间 + 固定端口」；隔离由「插件注册名带任务
//   命名空间」+「同一时刻只允许一个任务激活插件」纪律承担。

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  mainCheckout, worktreePathFor, runDirFor, runsRoot,
  DEV_DSH_PORT, pluginNamespaceFor,
} from './workspace-paths.mjs'

const DEFAULT_BUDGET = 3

export function envResourcesFor(runId) {
  // run.json 统一资源字段：按资源类型分层命名，后续新增资源类型（#187）在同一字段下扩展。
  // 决策六（2026-09-13）：开发 DSH 单实例化后不再有独占 Home，本任务只需登记
  // 「插件命名空间」与「固定端口」——它们是收口核对与单激活纪律的唯一依据。
  return {
    plugin_namespace: pluginNamespaceFor(runId),
    dev_dsh_port: DEV_DSH_PORT,
  }
}

export function branchName(runId) {
  // run_id 已被 assertRunIdSafe 限定为净化形态，分支名直接拼接——单射，无归一化碰撞
  return `dev-${runId}`
}

export function repoSlugFromUrl(url) {
  // 与 hostname 无关地剥离认证信息（https://token@host/org/repo、git@host:org/repo 均可）
  let u = String(url).trim()
  u = u.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '') // 协议
  u = u.replace(/^[^@/]+@/, '')                    // userinfo（token/用户名）
  u = u.replace(/\.git$/, '')
  u = u.replace(/^([^:/]+)[:/]/, '$1/')            // host:path → host/path
  if (u.startsWith('github.com/')) u = u.slice('github.com/'.length)
  return u
}

export function ensureGitExclude(excludeFile, entries) {
  // 写入 git 本地排除（不污染仓库 .gitignore）：幂等追加。
  // 注意：linked worktree 的 --git-dir 是 per-worktree 目录，Git 实际读取的是公共 info/exclude；
  // 调用方须以 `git rev-parse --git-path info/exclude` 解析得到本文件路径。
  const excl = excludeFile
  const infoDir = dirname(excl)
  mkdirSync(infoDir, { recursive: true })
  const cur = existsSync(excl) ? readFileSync(excl, 'utf-8') : ''
  const lines = cur.split('\n').map(l => l.trim())
  const add = entries.filter(e => !lines.includes(e))
  if (add.length > 0) {
    writeFileSync(excl, cur + (cur === '' || cur.endsWith('\n') ? '' : '\n') + add.join('\n') + '\n')
  }
  return add
}

export function parseBudget(str) {
  // 完整非负整数校验：NaN / 3junk / 负数一律拒绝
  if (!/^\d+$/.test(String(str))) {
    throw new Error(`非法回退额度: ${str}（须为非负整数）`)
  }
  const n = parseInt(str, 10)
  if (!Number.isSafeInteger(n)) {
    throw new Error(`非法回退额度: ${str}（超出安全整数范围）`)
  }
  return n
}

export function assertRunIdSafe(runId) {
  // run_id 同时充当分支名与 run 目录名：限定为已净化的小写连字符形态，
  // 既防路径穿越（/ 与 ..），也保证分支命名单射（不再做有损归一化）
  if (!/^[a-z0-9][a-z0-9-]*$/.test(String(runId))) {
    throw new Error(`非法 run_id: ${runId}（须为小写字母/数字/连字符的已净化形态，如 cwf-123-01）`)
  }
}

export function findIdentityMismatch(stored, requested) {
  // 幂等复用前校验身份一致：run_id 相同不代表 issue/base/budget 相同
  // base_ref_kind 缺失时按历史行为视为 remote，保证旧 run.json 可读
  const mismatches = []
  const storedKind = stored.base_ref_kind ?? 'remote'
  const reqKind = requested.base_ref_kind ?? 'remote'
  if (stored.issue_or_task_identity !== requested.issue_or_task_identity) mismatches.push(`issue(${stored.issue_or_task_identity}≠${requested.issue_or_task_identity})`)
  if (stored.base_ref !== requested.base_ref) mismatches.push(`base_ref(${stored.base_ref}≠${requested.base_ref})`)
  if (storedKind !== reqKind) mismatches.push(`base_ref_kind(${storedKind}≠${reqKind})`)
  if ((stored.rollback_budget ?? DEFAULT_BUDGET) !== requested.rollback_budget) mismatches.push(`budget(${stored.rollback_budget}≠${requested.rollback_budget})`)
  return mismatches
}

/**
 * 解析开工基线。
 * localBase=true（本地轨道 / GitHub 不可用）：不访问远程，直接以本地分支为基线；
 * 否则沿用历史行为：先 fetch 再以 origin/<base> 为基线。
 * git 可注入以便测试。
 */
export function resolveBase({ base, localBase = false, git } = {}) {
  if (localBase) return { baseRef: base, kind: 'local' }
  git(['fetch', 'origin', base])
  return { baseRef: `origin/${base}`, kind: 'remote' }
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim()
}

function parseArgs(argv) {
  const [issue, runId, ...rest] = argv
  if (!issue || !runId) {
    console.error('用法: node scripts/cwf-run-init.mjs <issue_id|任务标识> <run_id> [--base <ref>] [--budget <n>] [--local-base]')
    process.exit(2)
  }
  assertRunIdSafe(runId)
  const opts = { base: 'main', budget: DEFAULT_BUDGET, localBase: false }
  for (let i = 0; i < rest.length; i++) {
    try {
      if (rest[i] === '--base') opts.base = rest[++i]
      else if (rest[i] === '--budget') opts.budget = parseBudget(rest[++i])
      else if (rest[i] === '--local-base' || rest[i] === '--no-fetch') opts.localBase = true
      else {
        console.error(`未知参数: ${rest[i]}`)
        process.exit(2)
      }
    } catch (e) {
      console.error(e.message)
      process.exit(2)
    }
  }
  return { issue: issue.replace(/^#/, ''), runId, ...opts }
}

function main() {
  const { issue, runId, base, budget, localBase } = parseArgs(process.argv.slice(2))
  // 路径一律由**主检出**派生（§1.6 锚定机制）：在任意工作树内执行结果都一致，
  // 且工作树建在仓库之外，嵌套在结构上不可能发生。
  const main = mainCheckout(process.cwd())
  const branch = branchName(runId)
  const runDir = runDirFor(main, runId)
  const worktreePath = worktreePathFor(main, branch)

  const { baseRef, kind: baseRefKind } = resolveBase({ base, localBase, git: (a) => git(a, main) })
  const baseCommit = git(['rev-parse', baseRef], main)

  // 幂等：同 run_id 的既有 worktree/run 目录直接复用，不重复建分支
  const existingRunJson = join(runDir, 'run.json')
  if (git(['branch', '--list', branch], main)) {
    if (existsSync(existingRunJson)) {
      const existing = JSON.parse(readFileSync(existingRunJson, 'utf-8'))
      if (existing.run_id === runId) {
        const mismatches = findIdentityMismatch(existing, {
          issue_or_task_identity: `#${issue}`,
          base_ref: base,
          base_ref_kind: baseRefKind,
          rollback_budget: budget,
        })
        // 校验 worktree 实际 git 分支与记录一致（防止检出被切换后 lineage 自相矛盾）
        const actualBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath)
        if (actualBranch !== existing.work_branch) {
          mismatches.push(`worktree 当前分支(${actualBranch}≠${existing.work_branch})`)
        }
        if (mismatches.length === 0) {
          // 复用时补齐/迁移资源登记（不改变 Run 身份）：
          //  - 旧 run.json（决策六之前）没有 plugin_namespace → 按新语义补登；
          //  - 已有 plugin_namespace 则不动（保留 recycled_at 等回收痕迹）。
          if (!existing.env_resources?.plugin_namespace) {
            existing.task_id_namespace = existing.task_id_namespace || existing.run_id
            existing.env_resources = {
              ...envResourcesFor(existing.run_id),
              ...(existing.env_resources?.recycled_at ? { recycled_at: existing.env_resources.recycled_at } : {}),
            }
            writeFileSync(existingRunJson, JSON.stringify(existing, null, 2) + '\n')
          }
          console.log(JSON.stringify({ worktree: worktreePath, runDir, identity: existing, plugin_namespace: existing.env_resources.plugin_namespace, dev_dsh_port: existing.env_resources.dev_dsh_port, reused: true }, null, 2))
          return
        }
        console.error(`run_id 相同但状态不一致，拒绝静默复用: ${mismatches.join('；')}`)
        process.exit(1)
      }
    }
    console.error(`分支已存在且不属于本 Run: ${branch}（换用不同 run_id 或先清理旧 workspace）`)
    process.exit(1)
  }

  const identity = {
    run_id: runId,
    issue_or_task_identity: `#${issue}`,
    workspace_id: `wt-${branch}`,
    repository: repoSlugFromUrl(git(['remote', 'get-url', 'origin'], main)),
    base_ref: base,
    base_ref_kind: baseRefKind,
    base_commit: baseCommit,
    work_branch: branch,
    current_head: baseCommit,
    stage: 'requirements',
    attempt: 1,
  }

  git(['branch', branch, baseRef], main)
  // 绝对路径 + 仓库外目标：无论从哪个工作树执行，都不会把新工作树建到别人内部
  git(['worktree', 'add', worktreePath, branch], main)

  // run 产物不得入库（仓库安全规则）：目标仓库可能未 ignore .agent-runs/，
  // 写 git 本地 info/exclude（不改动仓库跟踪的 .gitignore）
  // info/exclude 是仓库级公共文件；linked worktree 需经 --git-path 解析（--git-dir 是 per-worktree 目录）
  ensureGitExclude(git(['rev-parse', '--git-path', 'info/exclude'], main), ['.agent-runs/', '.scratch/'])
  ensureGitExclude(git(['rev-parse', '--git-path', 'info/exclude'], worktreePath), ['.agent-runs/', '.scratch/'])

  // 产物锚定主检出（§1.6）：工作树只用于干活，不作为产物落点，
  // 工作树因此成为真正可丢弃的目录。
  mkdirSync(runDir, { recursive: true })
  // 提供 handoff schema 到主检出的产物根（外仓库无本仓库 docs 路径；资产随 skill 分发）
  const scriptDir = dirname(fileURLToPath(import.meta.url))
  const schemaSrcLocal = join(scriptDir, 'handoff.schema.json')
  const schemaSrcRepo = join(scriptDir, '..', 'docs', 'design', 'construction-workflow', 'handoff.schema.json')
  const schemaSrc = existsSync(schemaSrcLocal) ? schemaSrcLocal : schemaSrcRepo
  const schemaDir = join(runsRoot(main), 'schema')
  mkdirSync(schemaDir, { recursive: true })
  writeFileSync(join(schemaDir, 'handoff.schema.json'), readFileSync(schemaSrc))

  const runState = {
    ...identity,
    rollback_budget: budget,
    rollback_used: 0,
    rollback_history: [],
    task_id_namespace: runId,
    env_resources: envResourcesFor(runId),
    created_at: new Date().toISOString(),
  }
  writeFileSync(join(runDir, 'run.json'), JSON.stringify(runState, null, 2) + '\n')

  console.log(JSON.stringify({
    worktree: worktreePath,
    runDir,
    identity,
    plugin_namespace: runState.env_resources.plugin_namespace,
    dev_dsh_port: runState.env_resources.dev_dsh_port,
    task_id_namespace: runId,
  }, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
