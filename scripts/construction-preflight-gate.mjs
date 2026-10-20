#!/usr/bin/env node
/**
 * LOC-038：建设模板 preflight 机械节点适配器。
 * 三入口（Bootstrap CLI / wf_run mechanical 钩子 / 测试 harness）共用 runPreflight。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runMulticaTaskPreflight } from './multica-task-preflight.mjs'

const MECHANICAL_ID = 'construction-preflight'

/**
 * 将 runPreflight 结果映射为建设 preflight 节点 schema。
 * @param {Awaited<ReturnType<typeof runPreflight>>} pr
 */
export function mapPreflightNodeOutput(pr) {
  if (pr.ok) {
    const baseline = pr.fields?.baseline || 'V1'
    const assignee = pr.fields?.assignee_id
      ? `${pr.fields.assignee_type || 'assignee'}:${pr.fields.assignee_id}`
      : '未分派'
    return {
      route: 'PASS',
      summary: `Multica Task ${pr.fields.identifier} 状态=${pr.fields.status}，项目=${pr.fields.project_id}，负责人=${assignee}；基线 ${baseline}，依赖已核验。`,
      blockers: '',
      baseline_version: baseline,
    }
  }
  const blockers = (pr.failures || []).join('；')
  return {
    route: 'BLOCKED',
    summary: 'Multica Task 权威来源检查未通过；未回退读取本地登记册。',
    blockers,
    baseline_version: '',
  }
}

/**
 * @param {object} ctx
 * @param {string} [ctx.multicaTaskId]
 * @param {string} [ctx.multicaProfile]
 * @param {string} [ctx.multicaWorkspaceId]
 * @param {string} [ctx.repo]
 * @param {string} [ctx.runBaseline]
 */
export async function runConstructionPreflightGate(ctx = {}) {
  const repo = path.resolve(ctx.repo || process.cwd())
  const multicaTaskId = ctx.multicaTaskId
  if (!multicaTaskId) {
    return mapPreflightNodeOutput({
      ok: false,
      failures: ['缺少 multicaTaskId；建设流程必须绑定 Multica Task，不能以本地 taskId 或任务卡代替。'],
      reasons: [{ code: 'MULTICA_TASK_ID_REQUIRED', field: 'multicaTaskId', source: 'entry', message: '正式入口缺少 Multica Task ID' }],
      fields: null,
    })
  }

  const pr = await runMulticaTaskPreflight(multicaTaskId, {
    runBaseline: ctx.runBaseline ?? null,
    repo,
    profile: ctx.multicaProfile,
    workspaceId: ctx.multicaWorkspaceId,
    execFileSync: ctx.execFileSync,
  })
  return mapPreflightNodeOutput(pr)
}

/** wf_run / 生成脚本 mechanical 钩子入口 */
export async function mechanicalConstructionPreflight(_id, ctx = {}) {
  const args = ctx.args || {}
  return runConstructionPreflightGate({
    multicaTaskId: args.multicaTaskId || args.multica_task_id || ctx.multicaTaskId,
    multicaProfile: args.multicaProfile || args.multica_profile || ctx.multicaProfile,
    multicaWorkspaceId: args.multicaWorkspaceId || args.multica_workspace_id || ctx.multicaWorkspaceId,
    repo: args.repo_path || args.repo || ctx.repo,
    runBaseline: args.run_baseline || args.runBaseline,
    execFileSync: ctx.execFileSync,
  })
}

export function buildMechanicalPreamble(repoRoot) {
  const gatePath = path.join(repoRoot, 'scripts', 'construction-preflight-gate.mjs')
  return [
    'async function mechanical(id, ctx) {',
    '  if (String(id) !== ' + JSON.stringify(MECHANICAL_ID) + ') throw new Error(\'未知机械节点：\' + id)',
    '  const { mechanicalConstructionPreflight } = await import(' + JSON.stringify(gatePath) + ')',
    '  return mechanicalConstructionPreflight(id, Object.assign({}, ctx || {}, { repo: ' + JSON.stringify(repoRoot) + ' }))',
    '}',
    '',
  ].join('\n')
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isCli) {
  const argv = process.argv.slice(2)
  let multicaTaskId = null
  let multicaProfile = null
  let multicaWorkspaceId = null
  let repo = process.cwd()
  const taskIndex = argv.indexOf('--multica-task-id')
  if (taskIndex >= 0) multicaTaskId = argv[taskIndex + 1]
  const profileIndex = argv.indexOf('--multica-profile')
  if (profileIndex >= 0) multicaProfile = argv[profileIndex + 1]
  const workspaceIndex = argv.indexOf('--multica-workspace-id')
  if (workspaceIndex >= 0) multicaWorkspaceId = argv[workspaceIndex + 1]
  const ri = argv.indexOf('--repo')
  if (ri >= 0) repo = argv[ri + 1]
  const rbIdx = argv.indexOf('--run-baseline')
  const runBaseline = rbIdx >= 0 ? argv[rbIdx + 1] : null
  const out = await runConstructionPreflightGate({ multicaTaskId, multicaProfile, multicaWorkspaceId, repo, runBaseline })
  console.log(JSON.stringify(out, null, 2))
  process.exit(out.route === 'PASS' ? 0 : 1)
}
