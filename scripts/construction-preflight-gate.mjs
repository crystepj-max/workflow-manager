#!/usr/bin/env node
/**
 * LOC-038：建设模板 preflight 机械节点适配器。
 * 三入口（Bootstrap CLI / wf_run mechanical 钩子 / 测试 harness）共用 runPreflight。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runPreflight } from './ai-task-preflight-check.mjs'
import { field, TASK_FIELDS } from './task-card-parse.mjs'

const MECHANICAL_ID = 'construction-preflight'

/**
 * @param {string} taskId
 * @param {string} repo
 */
export function resolveTaskCardPath(taskId, repo = process.cwd()) {
  const raw = String(taskId || '').trim()
  const m = /^(?:loc-)?(\d{3})$/i.exec(raw.replace(/-r\d+$/i, ''))
    || /^(LOC-\d{3,})/i.exec(raw)
    || /^(FEAT|FIX|CHORE)-(\d+)$/i.exec(raw)
  const id = m ? (m[1] && /^\d{3}$/.test(m[1]) ? `LOC-${m[1]}` : (m[0] || raw).toUpperCase()) : raw.toUpperCase()
  const tasksDir = path.join(repo, 'docs', 'tasks')
  if (!fs.existsSync(tasksDir)) return null
  const exact = path.join(tasksDir, `${id}.md`)
  if (fs.existsSync(exact)) return exact
  const hit = fs.readdirSync(tasksDir).find((f) => f.toUpperCase().startsWith(id + '-') && f.endsWith('.md'))
  return hit ? path.join(tasksDir, hit) : null
}

export function resolveSpecPath(issuePath, repo = process.cwd()) {
  if (!issuePath || !fs.existsSync(issuePath)) return null
  const issue = fs.readFileSync(issuePath, 'utf8')
  const specLoc = field(issue, TASK_FIELDS.SPEC_LOC)
  if (!specLoc) return null
  const rel = specLoc.replace(/^`|`$/g, '').trim()
  const candidates = [
    path.isAbsolute(rel) ? rel : path.join(repo, rel),
    path.resolve(path.dirname(issuePath), rel),
  ]
  for (const p of candidates) if (fs.existsSync(p)) return p
  return candidates[0]
}

/**
 * 将 runPreflight 结果映射为建设 preflight 节点 schema。
 * @param {Awaited<ReturnType<typeof runPreflight>>} pr
 */
export function mapPreflightNodeOutput(pr) {
  if (pr.ok) {
    const baseline = pr.fields?.baseline || 'V1'
    return {
      route: 'PASS',
      summary: `机械实施前检查通过（基线 ${baseline}）`,
      blockers: '',
      baseline_version: baseline,
      reasons: pr.reasons || [],
      mechanical: true,
    }
  }
  const blockers = (pr.failures || []).join('；')
  return {
    route: 'BLOCKED',
    summary: '机械实施前检查未通过',
    blockers,
    baseline_version: '',
    reasons: pr.reasons || [],
    mechanical: true,
  }
}

/**
 * @param {object} ctx
 * @param {string} [ctx.issuePath]
 * @param {string} [ctx.specPath]
 * @param {string} [ctx.taskId]
 * @param {string} [ctx.repo]
 * @param {string} [ctx.runBaseline]
 * @param {string} [ctx.envStore]
 * @param {string} [ctx.headRef]
 */
export async function runConstructionPreflightGate(ctx = {}) {
  const repo = path.resolve(ctx.repo || process.cwd())
  const issuePath = ctx.issuePath
    ? path.resolve(ctx.issuePath)
    : resolveTaskCardPath(ctx.taskId, repo)
  const specPath = ctx.specPath
    ? path.resolve(ctx.specPath)
    : resolveSpecPath(issuePath, repo)

  if (!issuePath || !fs.existsSync(issuePath)) {
    return mapPreflightNodeOutput({
      ok: false,
      failures: [`任务卡不可读：${issuePath || '（未解析）'}`],
      reasons: [{ code: 'PREFLIGHT_CONTEXT_MISSING', field: 'issuePath', source: 'entry', message: '正式入口缺任务卡路径且无法从 taskId 解析' }],
      fields: null,
    })
  }
  if (!specPath || !fs.existsSync(specPath)) {
    return mapPreflightNodeOutput({
      ok: false,
      failures: [`任务规格不可读：${specPath || '（未解析）'}`],
      reasons: [{ code: 'PREFLIGHT_CONTEXT_MISSING', field: 'specPath', source: 'entry', message: '正式入口缺规格路径且无法从任务卡解析' }],
      fields: null,
    })
  }

  const pr = await runPreflight(issuePath, specPath, {
    runBaseline: ctx.runBaseline ?? null,
    envStore: ctx.envStore ?? null,
    repo,
    headRef: ctx.headRef ?? 'HEAD',
    registryPath: ctx.registryPath ?? null,
  })
  return mapPreflightNodeOutput(pr)
}

/** wf_run / 生成脚本 mechanical 钩子入口 */
export async function mechanicalConstructionPreflight(_id, ctx = {}) {
  const args = ctx.args || {}
  return runConstructionPreflightGate({
    issuePath: args.issuePath,
    specPath: args.specPath,
    taskId: args.taskId || ctx.taskId,
    repo: args.repo_path || args.repo || ctx.repo,
    runBaseline: args.run_baseline || args.runBaseline,
    envStore: args.env_store || args.envStore,
    headRef: args.head_ref || args.headRef,
    registryPath: args.registry_path || args.registryPath,
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
  let issue = null
  let spec = null
  let taskId = null
  let repo = process.cwd()
  const ti = argv.indexOf('--task-id')
  if (ti >= 0) taskId = argv[ti + 1]
  const ri = argv.indexOf('--repo')
  if (ri >= 0) repo = argv[ri + 1]
  if (!taskId && argv[0] && !argv[0].startsWith('--')) {
    issue = argv[0]
    spec = argv[1]
  }
  const rbIdx = argv.indexOf('--run-baseline')
  const runBaseline = rbIdx >= 0 ? argv[rbIdx + 1] : null
  const esIdx = argv.indexOf('--env-store')
  const envStore = esIdx >= 0 ? argv[esIdx + 1] : null
  const out = await runConstructionPreflightGate({ issuePath: issue, specPath: spec, taskId, repo, runBaseline, envStore })
  console.log(JSON.stringify(out, null, 2))
  process.exit(out.route === 'PASS' ? 0 : 1)
}
