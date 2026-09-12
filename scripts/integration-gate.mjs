// Integration Gate 内核侧助手（LOC-017）：目标同步的编排效果执行 + 同步证据记录。
// 只调用 workspace-isolation.mjs 既有内核（不重写算法）；git merge 策略沿用仓库
// 既有做法（普通 merge，不改 rebase/merge 策略本身——规格 §4 非目标）。
//
// 职责边界（与宿主编排 packages/dsh-visual-workflow/src/host.js 的分工）：
//   - 本模块：读侧 plan（workspace 解析 / 脏检查 / 目标观测 / 锁键）、写侧 sync
//     （真 git merge + 冲突检测 fail closed + recordSourceSync 只信实况）、
//     同步证据 entry（B4：每次真实同步产生新的 artifact Record Revision）。
//   - 宿主：观测（复用 computeIntegrationCheckpointFromRepo RPC）、锁的获取/心跳/
//     释放（复用 acquireLock/releaseLock RPC）、自动重跑引擎段、放行判定
//     （复用 assertIntegrationAllowed，经 records-host assertIntegration 命令）。
//
// 用法（workspace-isolation-host.mjs 委托）：
//   import { planTargetSync, performTargetSync, buildSyncRecordEntry, integrationSyncRecordId } from './integration-gate.mjs'

import { execFileSync } from 'node:child_process'
import { getRunWorkspace, integrationResourceKey, recordSourceSync } from './workspace-isolation.mjs'

// 同步证据记录（Formal Records artifact）：B4 的载体——目标前进并完成同步后，
// 宿主必须以本 id 追加新 Revision；重跑产生的新 Proof 依赖它，旧 Proof 由
// coverageStatus 判 not_covering_current。同步未产生新 Revision 时不得放行。
export function integrationSyncRecordId(logicalRunId) {
  return 'artifact:' + String(logicalRunId || '') + ':integration-sync'
}

function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (e) {
    const detail = `${(e.stderr || '') + (e.stdout || '') || e.message}`.trim()
    const err = new Error(detail || e.message)
    err.cause = e
    throw err
  }
}

/**
 * 读侧计划（只读，不落任何写）：解析权威 workspace → 校验 Git ISOLATED_WRITE →
 * 脏检查（有未提交改动拒绝自动同步，不自动吞改动）→ 观测目标 HEAD → 判定
 * 分支是否已含目标 → 给出集成锁键。宿主据此先拿锁，再调 performTargetSync。
 */
export function planTargetSync(registry, logicalRunId, targetRef) {
  const ws = getRunWorkspace(registry, logicalRunId)
  if (ws.provider_id !== 'GitWorktreeWorkspace' || !ws.source_path || !ws.repository_path || !ws.base_commit) {
    return { ok: false, code: 'GATE_NOT_GIT_WORKSPACE', error: `集成闸门仅适用于 Git ISOLATED_WRITE 运行（实际 provider=${ws.provider_id || 'none'}）` }
  }
  const ref = targetRef || ws.base_ref
  if (!ref) return { ok: false, code: 'GATE_NO_TARGET_REF', error: 'workspace 缺少 base_ref，无法观测目标' }
  const dirty = git(['status', '--porcelain'], ws.source_path)
  if (dirty) {
    return { ok: false, code: 'GATE_SYNC_DIRTY', error: '工作区存在未提交改动，拒绝自动同步（不得自动吞改）', dirty: dirty.split('\n').slice(0, 20) }
  }
  const target_head = git(['rev-parse', ref], ws.repository_path)
  let integrated_before = false
  try {
    git(['merge-base', '--is-ancestor', target_head, 'HEAD'], ws.source_path)
    integrated_before = true
  } catch (e) { /* 非祖先 = 未含目标，需要 merge */ }
  return {
    ok: true,
    resource_key: integrationResourceKey({ repository: ws.repository, target_ref: ref }),
    sync_record_id: integrationSyncRecordId(logicalRunId),
    target_head,
    integrated_before,
    effective_base: ws.base_commit,
    source_path: ws.source_path,
    work_branch: ws.work_branch,
  }
}

/**
 * 真实 git merge（不触碰注册表，不持有登记簿文件锁）：调用方必须已持有集成锁。
 * 冲突 fail closed：返回冲突文件清单交人工，不做任何写入。
 * 目标已含于分支（人工先并过）时不再 merge（merge_result='up_to_date'）。
 */
export function mergeTarget(plan) {
  if (!plan || plan.ok !== true) return { ok: false, code: 'GATE_PLAN_INVALID', error: 'mergeTarget 需要通过的 planTargetSync 结果' }
  const { source_path } = plan
  let merge_result = 'up_to_date'
  if (!plan.integrated_before) {
    try {
      git(['merge', plan.target_head, '--no-edit'], source_path)
      merge_result = 'merged'
    } catch (e) {
      let conflicts = []
      try { conflicts = git(['diff', '--name-only', '--diff-filter=U'], source_path).split('\n').filter(Boolean) } catch (e2) { /* 冲突清单读取失败也如实返回 */ }
      return { ok: false, code: 'GATE_SYNC_CONFLICT', error: '自动同步出现冲突，fail closed：请人工解决后恢复', conflicts, target_head: plan.target_head }
    }
  }
  return { ok: true, target_head: plan.target_head, integrated_before: plan.integrated_before, merge_result }
}

/**
 * 内核直调便捷形态（测试/单进程用）：merge + recordSourceSync（只信实况 HEAD，
 * recordSourceSync 内部 observeGitHead 校验，禁止自报）。
 */
export function performTargetSync(registry, logicalRunId, plan) {
  const merged = mergeTarget(plan)
  if (!merged.ok) return merged
  const ws = recordSourceSync(registry, logicalRunId, {})
  return { ...merged, current_head: ws.current_head, source_revision: ws.source_revision }
}

/**
 * 同步证据 entry（records-host commit 的 artifact 条目）：body 记录本次同步事实
 * （目标头 / 上次同步头 / 是否已含目标），provenance 由宿主按当前段号与快照补齐。
 */
export function buildSyncRecordEntry({ logicalRunId, target_head, previous_synced_head, integrated_before, merge_result, node, attempt, snapshot_revision }) {
  return {
    type: 'artifact',
    record_id: integrationSyncRecordId(logicalRunId),
    kind: 'json',
    body_value: {
      synced_head: String(target_head || ''),
      previous_synced_head: previous_synced_head === undefined || previous_synced_head === null ? null : String(previous_synced_head),
      integrated_before: integrated_before === true,
      merge_result: String(merge_result || ''),
    },
    provenance: {
      logical_run_id: String(logicalRunId),
      node: String(node || 'integration-gate'),
      attempt: Number(attempt || 1),
      snapshot_revision: String(snapshot_revision || 'unspecified'),
      provider: 'default',
      model: 'default',
      produced_by: 'vwf:integration-gate',
    },
  }
}
