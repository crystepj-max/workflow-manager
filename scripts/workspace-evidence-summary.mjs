#!/usr/bin/env node
// 生成「证据摘要」（归档三件套之第三件）。
//
// 约定出处：docs/design/workspace-directory-convention.md §1.7.3 —— 阶段一必须
// 入库的「必要文档」第 3 项。证据明细（.agent-runs/<run-id>/）按 7 天保留期清理，
// 摘要永久保留，用于日后回答「这个任务当时做了什么、裁决是什么、谁签的」。
//
// 用法：
//   node scripts/workspace-evidence-summary.mjs <TASK_ID> [--run-id <run_id>] [--repo <path>] [--json]
//   node scripts/workspace-evidence-summary.mjs <TASK_ID> --no-run-evidence [--repo <path>]
//       —— 早期任务无 Run 证据链时使用（摘要中标注 no_run_evidence，不伪造证据）
//
// 也可作为模块使用（收口命令据此在合并时自动补齐第三件）：
//   import { generateEvidenceSummary } from './workspace-evidence-summary.mjs'
//   generateEvidenceSummary({ root, taskId, runId })
//
// 该文件是删除证据明细的前置条件：摘要不存在时，清理动作必须拒绝执行。

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mainCheckout } from './workspace-paths.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

// 各阶段记录中「值得写进摘要」的字段（按 record_type 取）
const KEY_FIELDS = {
  requirements_baseline: ['status', 'revision'],
  design_package: ['decision', 'status'],
  dev_handoff: ['outcome'],
  review_proof: ['verdict'],
  test_proof: ['verdict', 'environment'],
  acceptance_package: ['status', 'decision', 'decided_by', 'decided_at', 'verified_branch', 'verified_head'],
}

const RECORD_ORDER = [
  'requirements_baseline',
  'design_package',
  'dev_handoff',
  'review_proof',
  'test_proof',
  'acceptance_package',
]

function git(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

function walkFiles(dir, base = dir) {
  const out = []
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...walkFiles(full, base))
    else out.push({ path: full, rel: full.slice(base.length + 1), bytes: st.size })
  }
  return out
}

/**
 * 生成证据摘要并写入 <归档目录>/<TASK_ID>/evidence-summary.json。
 * @returns {{summaryJson: object, outPath: string, runDir: string|null, hasEvidence: boolean, stages: object[], fileCount: number, totalBytes: number}}
 */
export function generateEvidenceSummary({ root, taskId, runId, noRunEvidence = false, now = () => new Date() }) {
  const archivedRoot = '.agent-runs'
  const registry = readJson(join(root, 'docs/tasks/registry.json'))
  const task = registry?.tasks?.find((t) => t.task_id === taskId) || null

  const effectiveRunId = runId || (task?.branch ? task.branch.replace(/^dev-/, '') : null)
  if (!effectiveRunId && !noRunEvidence) {
    throw new Error(`无法确定 ${taskId} 的 RUN_ID：登记册 branch 为空，且未提供 runId。若该任务确无 Run 证据链，显式传 noRunEvidence: true`)
  }

  const runDir = effectiveRunId ? join(root, archivedRoot, effectiveRunId) : null
  const hasEvidence = Boolean(runDir && existsSync(runDir))
  if (runDir && !hasEvidence && !noRunEvidence) {
    throw new Error(`证据目录不存在：${archivedRoot}/${effectiveRunId}（先执行 cwf-record.mjs archive 归档到主检出；若确认无证据链，显式传 noRunEvidence: true）`)
  }

  // —— 采集各阶段记录 ——
  const index = hasEvidence ? readJson(join(runDir, 'index.json')) || {} : {}
  const stages = []
  for (const type of RECORD_ORDER) {
    const fileName = index[type]
    if (!fileName) continue
    const rec = readJson(join(runDir, fileName))
    if (!rec) continue
    const summary = {}
    for (const k of KEY_FIELDS[type] || []) {
      if (rec.payload?.[k] !== undefined) summary[k] = rec.payload[k]
    }
    stages.push({
      record_type: type,
      file: fileName,
      created_at: rec.created_at ?? null,
      produced_by: rec.produced_by ?? null,
      ...(Object.keys(summary).length ? { summary } : {}),
    })
  }

  const files = hasEvidence ? walkFiles(runDir) : []
  const totalBytes = files.reduce((n, f) => n + f.bytes, 0)
  const acceptance = stages.find((s) => s.record_type === 'acceptance_package')

  const summaryJson = {
    task_id: taskId,
    ...(effectiveRunId ? { run_id: effectiveRunId } : {}),
    ...(task?.name ? { task_name: task.name } : {}),
    ...(task?.branch ? { branch: task.branch } : {}),
    status: task?.status ?? null,
    decision: acceptance?.summary?.decision ?? null,
    decided_by: acceptance?.summary?.decided_by ?? null,
    decided_at: acceptance?.summary?.decided_at ?? null,
    ...(task?.merge
      ? {
          merge: {
            commit: task.merge.commit ?? null,
            merged_at: task.merge.merged_at ?? null,
            issue: task.merge.issue ?? null,
          },
        }
      : {}),
    stages,
    ...(hasEvidence
      ? {
          evidence: {
            archive_path: `${archivedRoot}/${effectiveRunId}`,
            file_count: files.length,
            total_bytes: totalBytes,
          },
        }
      : {
          evidence: null,
          no_run_evidence: true,
          note: '该任务先于 Run 证据链机制落地（无分支与 .agent-runs 记录），本摘要依据登记册与归档规格生成。',
        }),
    generated_at: now().toISOString(),
  }

  const outDir = join(root, 'docs/tasks/archive', taskId)
  const outPath = join(outDir, 'evidence-summary.json')
  mkdirSync(outDir, { recursive: true })
  writeFileSync(outPath, JSON.stringify(summaryJson, null, 2) + '\n')

  return { summaryJson, outPath, runDir, hasEvidence, stages, fileCount: files.length, totalBytes }
}

// —— CLI ——
function main(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')))
  const positional = argv.filter((a) => !a.startsWith('--'))
  const taskId = positional[0]
  const optValue = (name) => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : undefined
  }

  if (!taskId) {
    console.error('用法: node scripts/workspace-evidence-summary.mjs <TASK_ID> [--run-id <run_id>] [--repo <path>] [--json] [--no-run-evidence]')
    process.exit(2)
  }

  const root = resolve(optValue('--repo') || mainCheckout(process.cwd()) || join(HERE, '..'))

  let res
  try {
    res = generateEvidenceSummary({
      root,
      taskId,
      runId: optValue('--run-id'),
      noRunEvidence: flags.has('--no-run-evidence'),
    })
  } catch (e) {
    console.error(e.message)
    process.exit(2)
  }

  if (flags.has('--json')) {
    console.log(JSON.stringify(res.summaryJson, null, 2))
    return
  }
  console.log(`已生成证据摘要 ${res.outPath.slice(root.length + 1)}`)
  console.log(`  任务 ${taskId} / Run ${res.summaryJson.run_id ?? '（无）'} / 裁决 ${res.summaryJson.decision ?? '（未记录）'}`)
  if (res.hasEvidence) {
    console.log(`  阶段 ${res.stages.length} 项（${res.stages.map((s) => s.record_type).join(', ')}）`)
    console.log(`  证据 ${res.fileCount} 个文件 / ${(res.totalBytes / 1024).toFixed(1)} KB，位于 .agent-runs/${res.summaryJson.run_id}`)
  } else {
    console.log('  ⚠️ 无 Run 证据链（早期任务），摘要已标注 no_run_evidence')
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
}
