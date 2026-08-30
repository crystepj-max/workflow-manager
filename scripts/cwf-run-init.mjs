#!/usr/bin/env node
// 建设工作流 Run 引导：从 target 创建分支 + worktree + run 目录 + portable run identity
// 用法（在仓库主检出根目录执行）：
//   node scripts/cwf-run-init.mjs <issue_id> <run_id> [--base <ref>] [--budget <n>]
// 产物：.scratch/worktrees/<branch>/ 与 <worktree>/.agent-runs/<run_id>/run.json

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_BUDGET = 3

export function branchName(runId) {
  // 分支名携带 run_id（净化）：同 issue 的二次/派生 Run 不撞分支（契约支持额度耗尽后派生新 Run）
  const sanitized = String(runId).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  return `dev-${sanitized}`
}

export function assertRunIdSafe(runId) {
  // run 目录为 .agent-runs/<run_id> 单一路径分量；下游按上溯两级定位仓库根，禁止分隔符/穿越
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(String(runId))) {
    throw new Error(`非法 run_id: ${runId}（仅允许字母/数字/下划线/连字符，禁止路径分隔符与穿越）`)
  }
}

export function findIdentityMismatch(stored, requested) {
  // 幂等复用前校验身份一致：run_id 相同不代表 issue/base/budget 相同
  const mismatches = []
  if (stored.issue_or_task_identity !== requested.issue_or_task_identity) mismatches.push(`issue(${stored.issue_or_task_identity}≠${requested.issue_or_task_identity})`)
  if (stored.base_ref !== requested.base_ref) mismatches.push(`base_ref(${stored.base_ref}≠${requested.base_ref})`)
  if ((stored.rollback_budget ?? DEFAULT_BUDGET) !== requested.rollback_budget) mismatches.push(`budget(${stored.rollback_budget}≠${requested.rollback_budget})`)
  return mismatches
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim()
}

function parseArgs(argv) {
  const [issue, runId, ...rest] = argv
  if (!issue || !runId) {
    console.error('用法: node scripts/cwf-run-init.mjs <issue_id> <run_id> [--base <ref>] [--budget <n>]')
    process.exit(2)
  }
  assertRunIdSafe(runId)
  const opts = { base: 'main', budget: DEFAULT_BUDGET }
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--base') opts.base = rest[++i]
    else if (rest[i] === '--budget') opts.budget = parseInt(rest[++i], 10)
    else {
      console.error(`未知参数: ${rest[i]}`)
      process.exit(2)
    }
  }
  return { issue: issue.replace(/^#/, ''), runId, ...opts }
}

function main() {
  const { issue, runId, base, budget } = parseArgs(process.argv.slice(2))
  const repo = git(['rev-parse', '--show-toplevel'])
  const branch = branchName(runId)
  const runDirRel = join('.agent-runs', runId)

  git(['fetch', 'origin', base], repo)
  const baseRef = `origin/${base}`
  const baseCommit = git(['rev-parse', baseRef], repo)
  const worktreeDir = `.scratch/worktrees/${branch}`
  const worktreePath = join(repo, worktreeDir)

  // 幂等：同 run_id 的既有 worktree/run 目录直接复用，不重复建分支
  const existingRunJson = join(worktreePath, runDirRel, 'run.json')
  if (git(['branch', '--list', branch], repo)) {
    if (existsSync(existingRunJson)) {
      const existing = JSON.parse(readFileSync(existingRunJson, 'utf-8'))
      if (existing.run_id === runId) {
        const mismatches = findIdentityMismatch(existing, {
          issue_or_task_identity: `#${issue}`,
          base_ref: base,
          rollback_budget: budget,
        })
        if (mismatches.length === 0) {
          console.log(JSON.stringify({ worktree: worktreePath, runDir: join(worktreePath, runDirRel), identity: existing, reused: true }, null, 2))
          return
        }
        console.error(`run_id 相同但身份不一致，拒绝静默复用: ${mismatches.join('；')}`)
        process.exit(1)
      }
    }
    console.error(`分支已存在且不属于本 Run: ${branch}（换用不同 run_id 或先清理旧 workspace）`)
    process.exit(1)
  }
  git(['branch', branch, baseRef], repo)
  git(['worktree', 'add', worktreeDir, branch], repo)

  const runDir = join(worktreePath, runDirRel)
  mkdirSync(runDir, { recursive: true })

  const identity = {
    run_id: runId,
    issue_or_task_identity: `#${issue}`,
    workspace_id: `wt-${branch}`,
    repository: git(['remote', 'get-url', 'origin'], repo).replace(/^.*github\.com[:/]/, '').replace(/\.git$/, ''),
    base_ref: base,
    base_commit: baseCommit,
    work_branch: branch,
    current_head: baseCommit,
    stage: 'requirements',
    attempt: 1,
  }
  const runState = {
    ...identity,
    rollback_budget: budget,
    rollback_used: 0,
    rollback_history: [],
    created_at: new Date().toISOString(),
  }
  writeFileSync(join(runDir, 'run.json'), JSON.stringify(runState, null, 2) + '\n')

  console.log(JSON.stringify({ worktree: worktreePath, runDir, identity }, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
