#!/usr/bin/env node
// 建设交接包记录写入与校验
// 用法：
//   node scripts/cwf-record.mjs write <runDir> <record_type> <payload.json> [--produced-by X] [--stage S] [--attempt N]
//       —— 组装信封 + schema 校验 + 落盘 <runDir>/<record_type>.json，同时回写 run.json 的 stage/attempt
//   node scripts/cwf-record.mjs check <record.json> [...]
//       —— 只校验（schema 取自 runDir 上层仓库 docs/design/construction-workflow/handoff.schema.json）
//   node scripts/cwf-record.mjs rollback <runDir> <root_cause>
//       —— 记录一次自动回退（root_cause ∈ dev/design/requirements）；超额度打印升级提示并 exit 1

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { validateRecord } from './cwf-validate.mjs'
import { parseBudget } from './cwf-run-init.mjs'

const RECORD_TYPES = [
  'requirements_baseline',
  'design_package',
  'dev_handoff',
  'review_proof',
  'test_proof',
  'acceptance_package',
  'closeout_summary',
]

function repoRoot(runDir) {
  // runDir = <repo>/.agent-runs/<run_id> 或 <worktree>/.agent-runs/<run_id>
  return resolve(runDir, '..', '..')
}

function schemaPath(runDir) {
  // run-init 会把 schema 提供到 .agent-runs/schema/（外仓库自包含分发）；本仓库直接读 docs 版
  const provisioned = join(runDir, '..', 'schema', 'handoff.schema.json')
  if (existsSync(provisioned)) return provisioned
  return join(repoRoot(runDir), 'docs/design/construction-workflow/handoff.schema.json')
}

function loadSchema(runDir) {
  return JSON.parse(readFileSync(schemaPath(runDir), 'utf-8'))
}

function loadRun(runDir) {
  return JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf-8'))
}

function saveRun(runDir, run) {
  writeFileSync(join(runDir, 'run.json'), JSON.stringify(run, null, 2) + '\n')
}

function cmdWrite(runDir, recordType, payloadPath, flags) {
  const producer = flags.producedBy || process.env.DSH_SESSION_ID
  if (!producer) {
    console.error('必须提供 --produced-by（或环境变量 DSH_SESSION_ID）：无归属记录会破坏证据链 §8.3 ⑨ 的异源判定')
    process.exit(2)
  }
  if (!RECORD_TYPES.includes(recordType)) {
    console.error(`未知 record_type: ${recordType}（合法值: ${RECORD_TYPES.join(' / ')}）`)
    process.exit(2)
  }
  const run = loadRun(runDir)
  const schema = loadSchema(runDir)
  if (flags.stage) run.stage = flags.stage
  if (flags.attempt !== undefined) {
    // attempt 只许前进：过期覆盖会毁掉旧 attempt 的 proof（§8.5 保留纪律）
    if (flags.attempt < run.attempt) {
      console.error(`拒绝过期 attempt 覆盖：--attempt ${flags.attempt} < 当前 ${run.attempt}（契约 §8.5）`)
      process.exit(1)
    }
    run.attempt = flags.attempt
  }
  // 必须 fail closed：取不到真实 HEAD 即中止，不得静默复用旧值伪造 Proof 绑定（§2 不变量 3）
  try {
    run.current_head = currentHead(runDir)
  } catch (e) {
    console.error(`无法读取当前工作区真实 HEAD（${e.message}）：write 中止，Proof 不得绑定未观察的修订`)
    process.exit(1)
  }

  const record = {
    record_type: recordType,
    record_version: schema.properties.record_version.const,
    created_at: new Date().toISOString(),
    produced_by: producer,
    run: {
      run_id: run.run_id,
      issue_or_task_identity: run.issue_or_task_identity,
      workspace_id: run.workspace_id,
      repository: run.repository,
      base_ref: run.base_ref,
      base_commit: run.base_commit,
      work_branch: run.work_branch,
      current_head: run.current_head,
      stage: run.stage,
      attempt: run.attempt,
    },
    payload: JSON.parse(readFileSync(payloadPath, 'utf-8')),
  }

  const errors = validateRecord(schema, record)
  if (errors.length > 0) {
    console.error(`${recordType} 校验失败：`)
    for (const e of errors) console.error(`  ${e}`)
    process.exit(1)
  }

  // lineage 不变量（§7.2）：每次写入都要求实际分支与 run.work_branch 一致；
  // Proof 绑定校验（§7.3）：payload 的 verified_* 必须与真实工作区一致，而非仅非空
  const actualBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot(runDir), encoding: 'utf-8' }).trim()
  if (actualBranch !== run.work_branch) {
    console.error(`当前分支(${actualBranch}) 与 run.work_branch(${run.work_branch}) 不一致，拒绝写入（契约 §7.2 lineage）`)
    process.exit(1)
  }
  if (record.payload && (record.payload.verified_head !== undefined || record.payload.verified_branch !== undefined)) {
    const mismatches = []
    if (record.payload.verified_head !== run.current_head) {
      mismatches.push(`verified_head(${record.payload.verified_head}) ≠ 当前 HEAD(${run.current_head})`)
    }
    if (record.payload.verified_branch !== actualBranch) {
      mismatches.push(`verified_branch(${record.payload.verified_branch}) ≠ 当前分支(${actualBranch})`)
    }
    if (mismatches.length > 0) {
      console.error(`${recordType} Proof 绑定与工作区不符，拒绝写入（契约 §7.3）：`)
      for (const m of mismatches) console.error(`  ${m}`)
      process.exit(1)
    }
  }

  // 已终结记录不可覆盖（§8.5 保留 + 不可覆盖 Decision Record §5）：
  // 同 attempt 内仅允许「未终结成熟刷新」（baseline draft→confirmed、acceptance awaiting→decided）
  const outPath = join(runDir, `${recordType}.a${run.attempt}.json`)
  if (existsSync(outPath)) {
    const existing = JSON.parse(readFileSync(outPath, 'utf-8'))
    if (isFinalized(existing)) {
      console.error(`${outPath} 已是终结态记录，不可覆盖——请推进 attempt（rollback）或 reverify 后重写（契约 §8.5/§5）`)
      process.exit(1)
    }
  }

  // attempt 戳文件名 + index 索引：回退重跑的旧记录不得被覆盖（契约 §8.5）
  const fileName = `${recordType}.a${run.attempt}.json`
  const out = join(runDir, fileName)
  writeFileSync(out, JSON.stringify(record, null, 2) + '\n')
  const indexPath = join(runDir, 'index.json')
  const index = existsSync(indexPath)
    ? JSON.parse(readFileSync(indexPath, 'utf-8'))
    : {}
  index[recordType] = fileName
  writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n')
  saveRun(runDir, run)
  console.log(`${out} valid（stage=${run.stage} attempt=${run.attempt}）`)
}

function assertRunBranch(runDir, run) {
  // lineage 不变量（§7.2）：任何 run 状态变更前都要求实际分支与 run.work_branch 一致
  let actual
  try {
    actual = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot(runDir), encoding: 'utf-8' }).trim()
  } catch (e) {
    console.error(`无法读取当前工作区分支（${e.message}）：变更中止`)
    process.exit(1)
  }
  if (actual !== run.work_branch) {
    console.error(`当前分支(${actual}) 与 run.work_branch(${run.work_branch}) 不一致，拒绝变更 run 状态（契约 §7.2 lineage）`)
    process.exit(1)
  }
}

function currentHead(runDir) {
  // runDir 所在 git 工作区的 HEAD（worktree 场景 = 该 worktree 分支 HEAD）；失败即抛错（fail closed）
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot(runDir), encoding: 'utf-8' }).trim()
}

function isFinalized(existing) {
  const p = existing && existing.payload
  if (!p) return false
  switch (existing.record_type) {
    case 'acceptance_package': return p.status === 'decided'          // 人工签收即终结
    case 'design_package': return p.decision !== undefined            // 含已决 Decision Record 即终结
    case 'requirements_baseline': return p.status === 'confirmed'     // 冻结基线即终结（变动走新 Revision/attempt）
    case 'review_proof':
    case 'test_proof':
    case 'closeout_summary': return true                              // proof/收口一次写入即终结
    default: return false                                             // dev_handoff 允许同 attempt 技术重试刷新
  }
}

function cmdCheck(runDir, files) {
  const schema = loadSchema(runDir)
  let allOk = true
  for (const f of files) {
    const errors = validateRecord(schema, JSON.parse(readFileSync(f, 'utf-8')))
    if (errors.length === 0) console.log(`${f} valid`)
    else {
      console.log(`${f} invalid`)
      for (const e of errors) console.error(`  ${e}`)
      allOk = false
    }
  }
  process.exit(allOk ? 0 : 1)
}

function cmdRollback(runDir, rootCause, flags) {
  if (!['dev', 'design', 'requirements'].includes(rootCause)) {
    console.error(`非法根因: ${rootCause}（合法值: dev / design / requirements）`)
    process.exit(2)
  }
  if (flags.by !== undefined && flags.by !== 'human') {
    console.error(`非法 --by 值: ${flags.by}（仅支持 human；拼写错误会静默落到自动路径）`)
    process.exit(2)
  }
  const byHuman = flags.by === 'human'
  if (byHuman && !flags.decidedBy) {
    console.error('人工触发回退必须携带 --decided-by（建议同时 --reason）：无归属的人工记录等于绕过额度与验收门（契约 §4.2/§5.3）')
    process.exit(2)
  }
  const run = loadRun(runDir)
  assertRunBranch(runDir, run)
  const budget = run.rollback_budget ?? 3
  // 持久化所选回退边（§4.1 一次一条边；历史供升级/重放审计）
  const entry = {
    at: new Date().toISOString(),
    source_stage: run.stage,
    root_cause: rootCause,
    target_stage: rootCause,
    attempt: run.attempt,
  }
  run.rollback_history = [...(run.rollback_history || []), entry]
  if (byHuman) {
    // 人工触发的回退不消耗也不检查自动额度（§4.2：Decision/Acceptance 打回显式记录但不耗额度）
    entry.human_triggered = true
    entry.decided_by = flags.decidedBy
    if (flags.reason) entry.reason = flags.reason
    entry.counter = 'human'
  } else if (run.rollback_used >= budget) {
    // 先查容量：被拒边不递增，但持久化生命周期迁移（§4.3：WAITING_HUMAN + MAX_ROUNDS_REACHED）
    entry.rejected = true
    entry.reason = 'MAX_ROUNDS_REACHED'
    run.lifecycle = 'WAITING_HUMAN'
    run.lifecycle_reason = 'MAX_ROUNDS_REACHED'
    saveRun(runDir, run)
    console.error(`自动回退额度耗尽（${run.rollback_used}/${budget}）：按契约 §4.3 保留原 Outcome，升级人工（MAX_ROUNDS_REACHED，已持久化到 run.json）`)
    process.exit(1)
  } else {
    run.rollback_used += 1
    entry.counter = `${run.rollback_used}/${budget}`
  }
  // 回退被接受 ⇒ 持久化目标 Stage 迁移并推进 attempt（下一次写入使用新 attempt 文件名，不覆盖触发回退的 proof）；
  // 成功迁移清除挂起态（人工追加额度后的恢复由此生效）
  run.stage = rootCause
  run.attempt += 1
  entry.attempt_after = run.attempt
  delete run.lifecycle
  delete run.lifecycle_reason
  saveRun(runDir, run)
  const tag = byHuman ? '（人工触发，不耗自动额度）' : `，额度 ${run.rollback_used}/${budget}`
  console.log(`回退已记录：根因=${rootCause}（stage→${rootCause}，attempt→${run.attempt}）${tag}`)
}

function cmdBudget(runDir, target, flags) {
  let n
  try {
    n = parseBudget(target)
  } catch (e) {
    console.error(e.message)
    process.exit(2)
  }
  if (!flags.decidedBy) {
    console.error('人工调整额度必须携带 --decided-by（契约 §4.2：额度变化显式记录，不得隐式恢复）')
    process.exit(2)
  }
  const run = loadRun(runDir)
  assertRunBranch(runDir, run)
  const from = run.rollback_budget ?? 3
  run.budget_adjustments = [...(run.budget_adjustments || []), {
    at: new Date().toISOString(),
    from, to: n,
    reason: flags.reason || '',
    decided_by: flags.decidedBy,
  }]
  run.rollback_budget = n
  // 只有新额度确实能容纳下一次自动回退时才恢复挂起态；无扩容则保持 WAITING_HUMAN
  if (run.lifecycle_reason === 'MAX_ROUNDS_REACHED' && n > (run.rollback_used || 0)) {
    delete run.lifecycle
    delete run.lifecycle_reason
    console.log('额度扩容生效，Run 恢复运行')
  } else if (run.lifecycle_reason === 'MAX_ROUNDS_REACHED') {
    console.log(`额度未扩容（${n} <= 已用 ${run.rollback_used}），Run 保持 WAITING_HUMAN`)
  }
  saveRun(runDir, run)
  console.log(`回退额度调整：${from} → ${n}（decided_by=${flags.decidedBy}，已入账 budget_adjustments）`)
}

function cmdReverify(runDir, flags) {
  // Integration Checkpoint sync 后的 Proof 重跑（§7.3）：推进 attempt 产生新修订文件，
  // 保留原 HEAD 绑定的旧 proof（§8.5）；不是回退，不耗额度
  const run = loadRun(runDir)
  assertRunBranch(runDir, run)
  run.attempt += 1
  run.rollback_history = [...(run.rollback_history || []), {
    at: new Date().toISOString(),
    source_stage: run.stage,
    kind: 'reverify',
    attempt_after: run.attempt,
    ...(flags.reason ? { reason: flags.reason } : {}),
  }]
  saveRun(runDir, run)
  console.log(`Proof 重跑修订推进：attempt→${run.attempt}（新修订文件，不耗回退额度）`)
}

function parseFlags(args) {
  const flags = {}
  const rest = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--produced-by') flags.producedBy = args[++i]
    else if (args[i] === '--stage') flags.stage = args[++i]
    else if (args[i] === '--attempt') {
      const raw = args[++i]
      if (!/^[1-9]\d*$/.test(raw)) {
        console.error(`非法 --attempt 值: ${raw}（须为正整数）`)
        process.exit(2)
      }
      const parsed = parseInt(raw, 10)
      if (!Number.isSafeInteger(parsed)) {
        console.error(`非法 --attempt 值: ${raw}（超出安全整数范围）`)
        process.exit(2)
      }
      flags.attempt = parsed
    }
    else if (args[i] === '--by') flags.by = args[++i]
    else if (args[i] === '--reason') flags.reason = args[++i]
    else if (args[i] === '--decided-by') flags.decidedBy = args[++i]
    else if (args[i].startsWith('--')) {
      console.error(`未知选项: ${args[i]}（拼写错误会静默污染 provenance，拒绝执行）`)
      process.exit(2)
    }
    else rest.push(args[i])
  }
  return { flags, rest }
}

function main() {
  const [cmd, ...args] = process.argv.slice(2)
  const { flags, rest } = parseFlags(args)
  if (cmd === 'write') {
    if (rest.length !== 3) {
      console.error('用法: write <runDir> <record_type> <payload.json> [--produced-by X] [--stage S] [--attempt N]（位置参数须恰好 3 个）')
      process.exit(2)
    }
    const [runDir, recordType, payloadPath] = rest
    cmdWrite(runDir, recordType, payloadPath, flags)
  } else if (cmd === 'check') {
    if (rest.length < 2) {
      console.error('用法: check <runDir> <record.json> [...]')
      process.exit(2)
    }
    cmdCheck(rest[0], rest.slice(1))
  } else if (cmd === 'rollback') {
    if (rest.length !== 2) {
      console.error('用法: rollback <runDir> <root_cause> [--by human]')
      process.exit(2)
    }
    cmdRollback(rest[0], rest[1], flags)
  } else if (cmd === 'reverify') {
    if (rest.length !== 1) {
      console.error('用法: reverify <runDir> [--reason <text>]')
      process.exit(2)
    }
    cmdReverify(rest[0], flags)
  } else if (cmd === 'budget') {
    if (rest.length !== 2) {
      console.error('用法: budget <runDir> <n> --decided-by <who> [--reason <text>]')
      process.exit(2)
    }
    cmdBudget(rest[0], rest[1], flags)
  } else {
    console.error('未知子命令:', cmd)
    process.exit(2)
  }
}

main()
