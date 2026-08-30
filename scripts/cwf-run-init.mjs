#!/usr/bin/env node
// 建设工作流 Run 引导：从 target 创建分支 + worktree + run 目录 + portable run identity
// 用法（在仓库主检出根目录执行）：
//   node scripts/cwf-run-init.mjs <issue_id> <run_id> [--base <ref>] [--budget <n>]
// 产物：.scratch/worktrees/<branch>/ 与 <worktree>/.agent-runs/<run_id>/run.json

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const DEFAULT_BUDGET = 3

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim()
}

function parseArgs(argv) {
  const [issue, runId, ...rest] = argv
  if (!issue || !runId) {
    console.error('用法: node scripts/cwf-run-init.mjs <issue_id> <run_id> [--base <ref>] [--budget <n>]')
    process.exit(2)
  }
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
  const branch = `dev-issue-${issue}`

  git(['fetch', 'origin', base], repo)
  const baseRef = `origin/${base}`
  const baseCommit = git(['rev-parse', baseRef], repo)

  if (git(['branch', '--list', branch], repo)) {
    console.error(`分支已存在: ${branch}`)
    process.exit(1)
  }
  git(['branch', branch, baseRef], repo)

  const worktreeDir = `.scratch/worktrees/${branch}`
  const worktreePath = join(repo, worktreeDir)
  git(['worktree', 'add', worktreeDir, branch], repo)

  const runDir = join(worktreePath, '.agent-runs', runId)
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
    created_at: new Date().toISOString(),
  }
  writeFileSync(join(runDir, 'run.json'), JSON.stringify(runState, null, 2) + '\n')

  console.log(JSON.stringify({ worktree: worktreePath, runDir, identity }, null, 2))
}

main()
