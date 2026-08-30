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
  if (!RECORD_TYPES.includes(recordType)) {
    console.error(`未知 record_type: ${recordType}（合法值: ${RECORD_TYPES.join(' / ')}）`)
    process.exit(2)
  }
  const run = loadRun(runDir)
  const schema = loadSchema(runDir)
  if (flags.stage) run.stage = flags.stage
  if (flags.attempt !== undefined) run.attempt = flags.attempt
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
    produced_by: flags.producedBy || process.env.DSH_SESSION_ID || 'unknown',
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

function currentHead(runDir) {
  // runDir 所在 git 工作区的 HEAD（worktree 场景 = 该 worktree 分支 HEAD）；失败即抛错（fail closed）
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot(runDir), encoding: 'utf-8' }).trim()
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

function cmdRollback(runDir, rootCause) {
  if (!['dev', 'design', 'requirements'].includes(rootCause)) {
    console.error(`非法根因: ${rootCause}（合法值: dev / design / requirements）`)
    process.exit(2)
  }
  const run = loadRun(runDir)
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
  // 先查容量：被拒边不递增，但持久化生命周期迁移（§4.3：WAITING_HUMAN + MAX_ROUNDS_REACHED）
  if (run.rollback_used >= budget) {
    entry.rejected = true
    entry.reason = 'MAX_ROUNDS_REACHED'
    run.lifecycle = 'WAITING_HUMAN'
    run.lifecycle_reason = 'MAX_ROUNDS_REACHED'
    saveRun(runDir, run)
    console.error(`自动回退额度耗尽（${run.rollback_used}/${budget}）：按契约 §4.3 保留原 Outcome，升级人工（MAX_ROUNDS_REACHED，已持久化到 run.json）`)
    process.exit(1)
  }
  run.rollback_used += 1
  entry.counter = `${run.rollback_used}/${budget}`
  saveRun(runDir, run)
  console.log(`回退已记录：根因=${rootCause}（${run.stage}→${rootCause}），额度 ${run.rollback_used}/${budget}`)
}

function parseFlags(args) {
  const flags = {}
  const rest = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--produced-by') flags.producedBy = args[++i]
    else if (args[i] === '--stage') flags.stage = args[++i]
    else if (args[i] === '--attempt') flags.attempt = parseInt(args[++i], 10)
    else rest.push(args[i])
  }
  return { flags, rest }
}

function main() {
  const [cmd, ...args] = process.argv.slice(2)
  const { flags, rest } = parseFlags(args)
  if (cmd === 'write') {
    const [runDir, recordType, payloadPath] = rest
    if (!runDir || !recordType || !payloadPath) {
      console.error('用法: write <runDir> <record_type> <payload.json> [--produced-by X] [--stage S] [--attempt N]')
      process.exit(2)
    }
    cmdWrite(runDir, recordType, payloadPath, flags)
  } else if (cmd === 'check') {
    if (rest.length < 2) {
      console.error('用法: check <runDir> <record.json> [...]')
      process.exit(2)
    }
    cmdCheck(rest[0], rest.slice(1))
  } else if (cmd === 'rollback') {
    if (rest.length !== 2) {
      console.error('用法: rollback <runDir> <root_cause>')
      process.exit(2)
    }
    cmdRollback(rest[0], rest[1])
  } else {
    console.error('未知子命令:', cmd)
    process.exit(2)
  }
}

main()
