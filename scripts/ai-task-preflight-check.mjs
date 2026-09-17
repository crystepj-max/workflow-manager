#!/usr/bin/env node
/**
 * M2 实施前检查：校验「已定义」任务是否具备无人值守开工条件。
 * 本地轨道（GitHub 不可用）：状态「本地已定义」与「已定义」开工资格等价，
 * 但必须带 `GitHub 同步` 字段（pending / synced#N / not-applicable）。
 *
 * 双形态（LOC-003）：
 *   - CLI：node scripts/ai-task-preflight-check.mjs <task-basics.md> <task-spec.md>
 *       [--run-baseline Vn] [--env-store <dir>] [--repo <path>]——exit 0 = 通过；exit 1 = 受阻；exit 2 = 用法错误
 *   - module：import { runPreflight } —— 返回结构化结果，不退出进程、不做 IO 副作用以外的输出
 *
 * LOC-038：增加 reasons[{code,field,source,message}]；严格 Definition Check；跨组依赖登记册+祖先校验。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { field, parseSpecVersion, TASK_FIELDS } from './task-card-parse.mjs'
import { STATUS_LOCAL_DEFINED, STATUS_MERGED, loadRegistry } from './local-task-registry.mjs'
import { parseDeps, normalizeRole } from './ai-task-workspace-env.mjs'

export const DEFINED_STATUSES = new Set(['已定义', STATUS_LOCAL_DEFINED])
export const GITHUB_SYNC_VALUES = /^(not-applicable|pending|synced\s*#?\d+)$/i
const DEP_SATISFIED_STATUSES = new Set([STATUS_MERGED])

/** @param {string} text */
export function strictDefinitionCheck(text) {
  if (!text || !text.trim()) return { ok: false, reason: 'Definition Check 文件缺失或为空' }
  const body = text.split(/^##\s*结论/m)[0]
  const unchecked = [...body.matchAll(/^\s*-\s*\[\s\]/gm)]
  if (unchecked.length) return { ok: false, reason: `Definition Check 存在 ${unchecked.length} 项未勾选` }
  const openMatch = text.match(/未决产品事项[^\n|]*[|｜][^\n|]*[|｜]\s*(\d+)/)
  if (openMatch && Number(openMatch[1]) !== 0) {
    return { ok: false, reason: `Definition Check 未决产品事项=${openMatch[1]}（须为 0）` }
  }
  if (/未决产品事项[^\n]*[：:]\s*[1-9]/.test(text)) {
    return { ok: false, reason: 'Definition Check 声明存在未决产品事项' }
  }
  return { ok: true }
}

/** @param {string} spec */
export function specOpenItemsZero(spec) {
  return /未决产品事项[^\n]*[：:]\s*0\b/.test(spec)
    || /未决[^。\n]*为\s*\*\*0\*\*/.test(spec)
    || /未决事项\s*=\s*0/.test(spec)
    || /\|[^\n]*未决[^\n]*\|\s*0\s*\|/.test(spec)
}

/**
 * @param {string[]} depIds
 * @param {string} repo
 * @param {string} headRef
 * @param {(msg: string, code: string, field?: string) => void} failReason
 */
export function checkCrossGroupDeps(depIds, repo, headRef, failReason) {
  if (!depIds.length) return
  const registry = loadRegistry(repo)
  for (const dep of depIds) {
    const rec = registry.tasks.find((t) => String(t.task_id).toUpperCase() === String(dep).toUpperCase())
    if (!rec) {
      failReason(`前置依赖 ${dep} 未在本地登记册中找到`, 'PREFLIGHT_DEP_UNKNOWN', 'dependencies')
      continue
    }
    if (!DEP_SATISFIED_STATUSES.has(rec.status)) {
      failReason(`前置依赖 ${dep} 状态为「${rec.status}」（须已合并）`, 'PREFLIGHT_DEP_NOT_SATISFIED', 'dependencies')
      continue
    }
    const mergeCommit = rec.merge?.commit
    if (!mergeCommit) {
      failReason(`前置依赖 ${dep} 缺少合入 commit 证据`, 'PREFLIGHT_DEP_NO_MERGE_COMMIT', 'dependencies')
      continue
    }
    try {
      execFileSync('git', ['-C', repo, 'merge-base', '--is-ancestor', mergeCommit, headRef], { stdio: 'pipe' })
    } catch {
      failReason(`前置依赖 ${dep} 合入 commit ${mergeCommit} 不是当前 HEAD ${headRef} 的祖先`, 'PREFLIGHT_DEP_ANCESTOR_FAIL', 'dependencies')
    }
  }
}

/**
 * 资格校验唯一实现（LOC-003/LOC-038）。读入任务基本信息与本地任务规格，返回结构化结果；
 * 不打印、不退出。CLI 薄壳只负责参数解析与输出/退出码映射。
 * @returns {Promise<{ok: boolean, failures: string[], reasons: object[], fields: object|null}>}
 */
export async function runPreflight(issuePath, specPath, opts = {}) {
  const failures = []
  const reasons = []
  const failReason = (msg, code, fieldName = null, source = 'preflight') => {
    failures.push(msg)
    reasons.push({ code, field: fieldName, source, message: msg })
  }

  issuePath = path.resolve(issuePath)
  specPath = path.resolve(specPath)
  const runBaseline = opts.runBaseline ?? null
  const envStore = opts.envStore ?? null
  const repo = path.resolve(opts.repo || path.join(path.dirname(issuePath), '..', '..'))
  const headRef = opts.headRef || 'HEAD'

  function read(p) {
    if (!fs.existsSync(p)) {
      failReason(`文件不存在: ${p}`, 'PREFLIGHT_FILE_MISSING', path.basename(p))
      return ''
    }
    return fs.readFileSync(p, 'utf8')
  }

  const issue = read(issuePath)
  const spec = read(specPath)

  const status = field(issue, TASK_FIELDS.STATUS)
  const unattended = field(issue, TASK_FIELDS.UNATTENDED)
  const baseline = field(issue, TASK_FIELDS.BASELINE)
  const deps = field(issue, TASK_FIELDS.DEPS)
  const specLoc = field(issue, TASK_FIELDS.SPEC_LOC)
  const priority = field(issue, TASK_FIELDS.PRIORITY)
  const definedAt = field(issue, TASK_FIELDS.DEFINED_AT)
  const envGroup = field(issue, TASK_FIELDS.ENV_GROUP)
  const envRole = field(issue, TASK_FIELDS.ENV_ROLE)
  const taskId = field(issue, TASK_FIELDS.TASK_ID)
  const githubSync = field(issue, TASK_FIELDS.GITHUB_SYNC)
  const name = field(issue, TASK_FIELDS.NAME)

  if (!status) failReason('当前状态缺失', 'PREFLIGHT_STATUS_MISSING', TASK_FIELDS.STATUS)
  else if (!DEFINED_STATUSES.has(status)) {
    failReason(`当前状态必须为「已定义」或「${STATUS_LOCAL_DEFINED}」，实际：${status}`, 'PREFLIGHT_STATUS_INVALID', TASK_FIELDS.STATUS)
  }
  if (unattended !== '允许') {
    failReason(`无人值守许可必须为「允许」，实际：${unattended ?? '（缺失）'}`, 'PREFLIGHT_UNATTENDED_DENIED', TASK_FIELDS.UNATTENDED)
  }
  if (!baseline || !/^V\d+$/i.test(baseline)) {
    failReason(`需求基线版本缺失或非法：${baseline ?? '（缺失）'}`, 'PREFLIGHT_BASELINE_INVALID', TASK_FIELDS.BASELINE)
  }
  if (!deps || deps === '') failReason('前置依赖缺失', 'PREFLIGHT_DEPS_MISSING', TASK_FIELDS.DEPS)
  if (!envGroup) failReason('施工环境组缺失', 'PREFLIGHT_ENV_GROUP_MISSING', TASK_FIELDS.ENV_GROUP)
  if (!envRole) failReason('施工环境角色缺失', 'PREFLIGHT_ENV_ROLE_MISSING', TASK_FIELDS.ENV_ROLE)
  else if (!/^(独立|成员|root|member|independent)$/i.test(envRole)) {
    failReason(`施工环境角色须为「独立」或「成员」，实际：${envRole}`, 'PREFLIGHT_ENV_ROLE_INVALID', TASK_FIELDS.ENV_ROLE)
  }
  if (!priority || !/^P[012]$/.test(priority)) {
    failReason(`优先级必须为 P0/P1/P2，实际：${priority ?? '（缺失）'}`, 'PREFLIGHT_PRIORITY_INVALID', TASK_FIELDS.PRIORITY)
  }
  if (!definedAt) failReason('定义时间缺失', 'PREFLIGHT_DEFINED_AT_MISSING', TASK_FIELDS.DEFINED_AT)
  if (!specLoc) failReason('任务规格位置缺失', 'PREFLIGHT_SPEC_LOC_MISSING', TASK_FIELDS.SPEC_LOC)

  if (status === STATUS_LOCAL_DEFINED) {
    if (!taskId) failReason('本地轨道任务必须填写「任务标识」', 'PREFLIGHT_TASK_ID_MISSING', TASK_FIELDS.TASK_ID)
    if (!githubSync) failReason('本地轨道任务必须填写「GitHub 同步」', 'PREFLIGHT_GITHUB_SYNC_MISSING', TASK_FIELDS.GITHUB_SYNC)
    else if (!GITHUB_SYNC_VALUES.test(githubSync.trim())) {
      failReason(`GitHub 同步取值非法：${githubSync}`, 'PREFLIGHT_GITHUB_SYNC_INVALID', TASK_FIELDS.GITHUB_SYNC)
    }
  }

  const depList = parseDeps(deps)
  if (depList.length) checkCrossGroupDeps(depList, repo, headRef, failReason)

  let roleNorm = null
  try {
    roleNorm = normalizeRole(envRole)
  } catch (e) {
    failReason(String(e.message || e), 'PREFLIGHT_ENV_ROLE_INVALID', TASK_FIELDS.ENV_ROLE)
  }

  if (roleNorm === 'member' && !envStore) {
    failReason('成员角色须联调 --env-store 验证同组串行依赖，不得省略环境上下文', 'PREFLIGHT_CONTEXT_MISSING', 'envStore')
  }

  if (envStore && failures.length === 0 && roleNorm) {
    const { planDeliveryWorkspace, loadEnv } = await import('./ai-task-workspace-env.mjs')
    const envTaskId = taskId || path.basename(path.dirname(specPath)) || 'task'
    const existing = loadEnv(path.resolve(envStore), envGroup)
    const plan = planDeliveryWorkspace({
      taskId: envTaskId,
      envId: envGroup,
      role: envRole,
      deps: depList,
      existingEnv: existing,
    })
    if (plan.action === 'block') failReason(plan.reason, 'PREFLIGHT_ENV_BLOCKED', 'envStore')
  }

  const specVersion = parseSpecVersion(spec, specPath)
  if (!specVersion) failReason('本地任务规格无法解析版本号', 'PREFLIGHT_SPEC_VERSION_MISSING', 'spec')
  else if (specVersion.toUpperCase() !== baseline.toUpperCase()) {
    failReason(`版本不一致：Issue=${baseline} 规格=${specVersion}`, 'PREFLIGHT_VERSION_MISMATCH', TASK_FIELDS.BASELINE)
  }

  if (runBaseline && runBaseline.toUpperCase() !== baseline.toUpperCase()) {
    failReason(`Run 绑定版本不一致：Run=${runBaseline} Issue=${baseline}`, 'PREFLIGHT_RUN_BASELINE_MISMATCH', 'runBaseline')
  }

  const defCheckPaths = [
    path.join(path.dirname(specPath), 'definition-check.md'),
    path.join(path.dirname(issuePath), 'definition-check.md'),
  ]
  const defCheckPath = defCheckPaths.find((p) => fs.existsSync(p))
  if (!defCheckPath) {
    failReason('缺少 definition-check.md，不得开工', 'PREFLIGHT_DEF_CHECK_MISSING', 'definition-check')
  } else {
    const defText = fs.readFileSync(defCheckPath, 'utf8')
    const dc = strictDefinitionCheck(defText)
    if (!dc.ok) failReason(dc.reason, 'PREFLIGHT_DEF_CHECK_INCOMPLETE', 'definition-check')
  }

  if (!specOpenItemsZero(spec)) {
    failReason('规格未声明未决产品事项=0', 'PREFLIGHT_OPEN_ITEMS', 'spec')
  }
  if (/待决|TBD|TODO.*决策|未决产品事项[^\n]*[1-9]/.test(spec)) {
    failReason('仍存在未决产品事项迹象，不得开工', 'PREFLIGHT_OPEN_ITEMS', 'spec')
  }

  if (failures.length) return { ok: false, failures, reasons, fields: null }

  return {
    ok: true,
    failures,
    reasons,
    fields: {
      track: status === STATUS_LOCAL_DEFINED ? 'local' : 'github',
      task_id: taskId ?? null,
      github_sync: githubSync ?? null,
      status,
      baseline,
      name: name ?? null,
      unattended_permission: '允许',
      dependencies: deps,
      workspace_env: envGroup,
      workspace_role: envRole,
      priority,
      defined_at: definedAt,
      spec_path: specPath,
    },
  }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length < 2) {
    console.error('用法: node scripts/ai-task-preflight-check.mjs <issue-basics.md> <task-spec.md> [--run-baseline Vn] [--env-store <dir>] [--repo <path>]')
    process.exit(2)
  }
  let runBaseline = null
  const rbIdx = args.indexOf('--run-baseline')
  if (rbIdx >= 0) runBaseline = args[rbIdx + 1]
  let envStore = null
  const esIdx = args.indexOf('--env-store')
  if (esIdx >= 0) envStore = args[esIdx + 1]
  let repo = null
  const repoIdx = args.indexOf('--repo')
  if (repoIdx >= 0) repo = args[repoIdx + 1]

  const result = await runPreflight(args[0], args[1], { runBaseline, envStore, repo })
  if (!result.ok) {
    console.error('实施前检查未通过（执行受阻）：')
    for (const f of result.failures) console.error(`  - ${f}`)
    console.log(JSON.stringify({ ok: false, failures: result.failures, reasons: result.reasons, auto_rework_limit: 3 }, null, 2))
    process.exit(1)
  }
  console.log(JSON.stringify({
    ok: true,
    track: result.fields.track,
    task_id: result.fields.task_id,
    github_sync: result.fields.github_sync,
    status: result.fields.status,
    baseline: result.fields.baseline,
    unattended_permission: result.fields.unattended_permission,
    dependencies: result.fields.dependencies,
    workspace_env: result.fields.workspace_env,
    workspace_role: result.fields.workspace_role,
    priority: result.fields.priority,
    spec_path: result.fields.spec_path,
    reasons: result.reasons,
    auto_rework_limit: 3,
    next: '解析施工环境 → 开发',
  }, null, 2))
  process.exit(0)
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isCli) await main()
