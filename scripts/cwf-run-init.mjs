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
  // run_id 已被 assertRunIdSafe 限定为净化形态，分支名直接拼接——单射，无归一化碰撞
  return `dev-${runId}`
}

export function ensureGitExclude(gitDir, entries) {
  // 写入 git 本地排除（info/exclude，不污染仓库 .gitignore）：幂等追加
  const infoDir = join(gitDir, 'info')
  mkdirSync(infoDir, { recursive: true })
  const excl = join(infoDir, 'exclude')
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
  return parseInt(str, 10)
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
    try {
      if (rest[i] === '--base') opts.base = rest[++i]
      else if (rest[i] === '--budget') opts.budget = parseBudget(rest[++i])
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
        // 校验 worktree 实际 git 分支与记录一致（防止检出被切换后 lineage 自相矛盾）
        const actualBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath)
        if (actualBranch !== existing.work_branch) {
          mismatches.push(`worktree 当前分支(${actualBranch}≠${existing.work_branch})`)
        }
        if (mismatches.length === 0) {
          console.log(JSON.stringify({ worktree: worktreePath, runDir: join(worktreePath, runDirRel), identity: existing, reused: true }, null, 2))
          return
        }
        console.error(`run_id 相同但状态不一致，拒绝静默复用: ${mismatches.join('；')}`)
        process.exit(1)
      }
    }
    console.error(`分支已存在且不属于本 Run: ${branch}（换用不同 run_id 或先清理旧 workspace）`)
    process.exit(1)
  }
  git(['branch', branch, baseRef], repo)
  git(['worktree', 'add', worktreeDir, branch], repo)

  // run 产物不得入库（仓库安全规则）：目标仓库可能未 ignore .scratch/ 与 .agent-runs/，
  // 写 git 本地 info/exclude（不改动仓库跟踪的 .gitignore）
  const mainGitDir = git(['rev-parse', '--git-dir'], repo)
  ensureGitExclude(mainGitDir, ['.scratch/', '.agent-runs/'])
  const wtGitDir = git(['rev-parse', '--git-dir'], worktreePath)
  ensureGitExclude(wtGitDir, ['.agent-runs/', '.scratch/'])

  const runDir = join(worktreePath, runDirRel)
  mkdirSync(runDir, { recursive: true })
  // 提供 handoff schema 到目标 workspace（外仓库无本仓库 docs 路径；资产随 skill 分发）
  const scriptDir = new URL('.', import.meta.url).pathname
  const schemaSrcLocal = join(scriptDir, 'handoff.schema.json')
  const schemaSrcRepo = join(scriptDir, '..', 'docs', 'design', 'construction-workflow', 'handoff.schema.json')
  const schemaSrc = existsSync(schemaSrcLocal) ? schemaSrcLocal : schemaSrcRepo
  mkdirSync(join(worktreePath, '.agent-runs', 'schema'), { recursive: true })
  writeFileSync(join(worktreePath, '.agent-runs', 'schema', 'handoff.schema.json'), readFileSync(schemaSrc))

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
