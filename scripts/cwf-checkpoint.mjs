#!/usr/bin/env node
// Integration Checkpoint：从实际仓库状态计算 target 是否前进（不得信任产生者自报）
// 用法：
//   node scripts/cwf-checkpoint.mjs <runDir>                 —— 计算并输出结构化 checkpoint
//   node scripts/cwf-checkpoint.mjs <runDir> --proofs-rerun  —— 声明受影响 Proof 已重跑
// target 未前进 → proofs_state=still_valid（exit 0）
// target 已前进且未声明重跑 → 输出 needs_rerun 提示并 exit 1（按契约 §7.3 先重跑 Proof）
// target 已前进且已声明重跑 → proofs_state=rerun_completed（exit 0）

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function verifyRerunEvidence({ synced, currentHead, attempt, proofs }) {
  // 不信 --proofs-rerun 自报（§7.3）：工作分支必须已 sync（含 targetHead），
  // 且当前 attempt 的 review/test 记录必须绑定 sync 后的 HEAD
  const errors = []
  if (!synced) errors.push('工作分支未包含 target 最新 HEAD（未 sync 或 sync 不完整）')
  for (const [rt, rec] of Object.entries(proofs)) {
    if (!rec) {
      errors.push(`缺少当前 attempt 的 ${rt} 记录（index.json 无指向）`)
      continue
    }
    if (rec.record_type !== rt) {
      errors.push(`index 指向的 ${rt} 记录实际 record_type=${rec.record_type}——类型不符（index 可能被指向同一记录）`)
      continue
    }
    if (rec.run?.attempt !== attempt) {
      errors.push(`${rt} 记录 attempt(${rec.run?.attempt}) ≠ 当前 attempt(${attempt})——先 reverify 再重跑`)
    }
    if (rec.payload?.verified_head !== currentHead) {
      errors.push(`${rt} 的 verified_head(${rec.payload?.verified_head}) ≠ sync 后 HEAD(${currentHead})——证据过期`)
    }
  }
  return errors
}

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
      // 不信自报：派生验证 sync 与当前 attempt 的 review/test 证据
      const wt = resolve(runDir, '..', '..')
      let synced = false
      try {
        execFileSync('git', ['merge-base', '--is-ancestor', targetHead, 'HEAD'], { cwd: wt })
        synced = true
      } catch { synced = false }
      const currentHead = git(['rev-parse', 'HEAD'], wt)
      const indexPath = join(runDir, 'index.json')
      const index = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf-8')) : {}
      const proofs = {}
      for (const rt of ['review_proof', 'test_proof']) {
        const f = index[rt]
        proofs[rt] = f && existsSync(join(runDir, f)) ? JSON.parse(readFileSync(join(runDir, f), 'utf-8')) : null
      }
      const errs = verifyRerunEvidence({ synced, currentHead, attempt: run.attempt, proofs })
      if (errs.length > 0) {
        console.error('checkpoint 重跑声明无法证实（§7.3 不信任自报）：')
        for (const e of errs) console.error(`  ${e}`)
        process.exit(1)
      }
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
