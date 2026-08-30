#!/usr/bin/env node
// Integration Checkpoint：从实际仓库状态计算 target 是否前进（不得信任产生者自报）
// 用法：
//   node scripts/cwf-checkpoint.mjs <runDir>                 —— 计算并输出结构化 checkpoint
//   node scripts/cwf-checkpoint.mjs <runDir> --proofs-rerun  —— 声明受影响 Proof 已重跑
// target 未前进 → proofs_state=still_valid（exit 0）
// target 已前进且未声明重跑 → 输出 needs_rerun 提示并 exit 1（按契约 §7.3 先重跑 Proof）
// target 已前进且已声明重跑 → proofs_state=rerun_completed（exit 0）

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim()
}

export function computeCheckpoint(run, gitState) {
  // gitState: { targetHead }（由调用方从 git 实际查询；此纯函数可测）
  const targetAdvanced = gitState.targetHead !== run.base_commit
  if (!targetAdvanced) {
    return {
      target_ref: run.base_ref,
      target_head_at_check: gitState.targetHead,
      target_advanced: false,
      proofs_state: 'still_valid',
      ok: true,
    }
  }
  return {
    target_ref: run.base_ref,
    target_head_at_check: gitState.targetHead,
    target_advanced: true,
    ok: false,
    hint: 'target 已前进：先 sync 工作分支并重跑受影响 Proof（至少 review/test），然后加 --proofs-rerun 重新执行本命令',
  }
}

function main() {
  const [runDir, ...rest] = process.argv.slice(2)
  if (!runDir) {
    console.error('用法: node scripts/cwf-checkpoint.mjs <runDir> [--proofs-rerun]')
    process.exit(2)
  }
  const proofsRerun = rest.includes('--proofs-rerun')
  const repo = resolve(runDir, '..', '..')
  const run = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf-8'))

  git(['fetch', 'origin', run.base_ref], repo)
  const targetHead = git(['rev-parse', `origin/${run.base_ref}`], repo)

  const ckpt = computeCheckpoint(run, { targetHead })
  if (!ckpt.ok) {
    if (proofsRerun) {
      ckpt.proofs_state = 'rerun_completed'
      ckpt.ok = true
    } else {
      console.error(`checkpoint 失败：${ckpt.hint}`)
      console.log(JSON.stringify(ckpt, null, 2))
      process.exit(1)
    }
  }
  delete ckpt.ok
  delete ckpt.hint
  console.log(JSON.stringify(ckpt, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
