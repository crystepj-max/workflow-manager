#!/usr/bin/env node
/**
 * M2 实施前检查：校验「已定义」任务是否具备无人值守开工条件。
 * 本地轨道（GitHub 不可用）：状态「本地已定义」与「已定义」开工资格等价，
 * 但必须带 `GitHub 同步` 字段（pending / synced#N / not-applicable）。
 * 用法：
 *   node scripts/ai-task-preflight-check.mjs <task-basics.md> <task-spec.md> [--run-baseline Vn]
 * exit 0 = 通过；exit 1 = 受阻（打印原因）
 */
import fs from 'node:fs'
import path from 'node:path'

export const DEFINED_STATUSES = new Set(['已定义', '本地已定义'])
export const GITHUB_SYNC_VALUES = /^(not-applicable|pending|synced\s*#?\d+)$/i

const args = process.argv.slice(2)
if (args.length < 2) {
  console.error('用法: node scripts/ai-task-preflight-check.mjs <issue-basics.md> <task-spec.md> [--run-baseline Vn]')
  process.exit(2)
}

const issuePath = path.resolve(args[0])
const specPath = path.resolve(args[1])
let runBaseline = null
const rbIdx = args.indexOf('--run-baseline')
if (rbIdx >= 0) runBaseline = args[rbIdx + 1]

const failures = []
function fail(msg) { failures.push(msg) }

function read(p) {
  if (!fs.existsSync(p)) {
    fail(`文件不存在: ${p}`)
    return ''
  }
  return fs.readFileSync(p, 'utf8')
}

function field(md, name) {
  // 表格行：| 字段 | 值 |
  const re = new RegExp(`\\|\\s*${name}\\s*\\|\\s*([^|]+)\\|`)
  const m = md.match(re)
  return m ? m[1].trim() : null
}

const issue = read(issuePath)
const spec = read(specPath)

const status = field(issue, '当前状态')
const unattended = field(issue, '无人值守许可')
const baseline = field(issue, '需求基线版本')
const deps = field(issue, '前置依赖')
const specLoc = field(issue, '任务规格位置')
const priority = field(issue, '优先级')
const definedAt = field(issue, '定义时间')
const envGroup = field(issue, '施工环境组')
const envRole = field(issue, '施工环境角色')
const taskId = field(issue, '任务标识')
const githubSync = field(issue, 'GitHub 同步')

let envStore = null
const esIdx = args.indexOf('--env-store')
if (esIdx >= 0) envStore = args[esIdx + 1]

if (!status) fail('当前状态缺失')
else if (!DEFINED_STATUSES.has(status)) {
  fail(`当前状态必须为「已定义」或「本地已定义」，实际：${status}`)
}
if (unattended !== '允许') fail(`无人值守许可必须为「允许」，实际：${unattended ?? '（缺失）'}`)
if (!baseline || !/^V\d+$/i.test(baseline)) fail(`需求基线版本缺失或非法：${baseline ?? '（缺失）'}`)
if (!deps || deps === '') fail('前置依赖缺失')
if (!envGroup) fail('施工环境组缺失')
if (!envRole) fail('施工环境角色缺失')
else if (!/^(独立|成员|root|member|independent)$/i.test(envRole)) {
  fail(`施工环境角色须为「独立」或「成员」，实际：${envRole}`)
}
if (!priority || !/^P[012]$/.test(priority)) fail(`优先级必须为 P0/P1/P2，实际：${priority ?? '（缺失）'}`)
if (!definedAt) fail('定义时间缺失')
if (!specLoc) fail('任务规格位置缺失')

// 本地轨道附加校验：任务标识 + GitHub 同步状态
if (status === '本地已定义') {
  if (!taskId) fail('本地轨道任务必须填写「任务标识」（LOC-<序号>）')
  if (!githubSync) fail('本地轨道任务必须填写「GitHub 同步」（pending / synced#N）')
  else if (!GITHUB_SYNC_VALUES.test(githubSync.trim())) {
    fail(`GitHub 同步取值非法：${githubSync}（应为 pending / synced#N / not-applicable）`)
  }
}

// 可选：联调环境组串行门禁（不创建 Git）
if (envStore && failures.length === 0) {
  const { planDeliveryWorkspace, loadEnv, parseDeps, normalizeRole } = await import('./ai-task-workspace-env.mjs')
  const envTaskId = taskId || path.basename(path.dirname(specPath)) || 'task'
  let roleNorm
  try {
    roleNorm = normalizeRole(envRole)
  } catch (e) {
    fail(String(e.message || e))
    roleNorm = null
  }
  if (roleNorm) {
    const existing = loadEnv(path.resolve(envStore), envGroup)
    const plan = planDeliveryWorkspace({
      taskId: envTaskId,
      envId: envGroup,
      role: envRole,
      deps: parseDeps(deps),
      existingEnv: existing,
    })
    if (plan.action === 'block') fail(plan.reason)
  }
}

const specVersion =
  field(spec, '需求基线版本') ||
  (spec.match(/\*\*版本\*\*[：:]\s*(V\d+)/i) || [])[1] ||
  (spec.match(/版本[：:]\s*(V\d+)/i) || [])[1] ||
  (spec.match(/^#\s*.*\b(V\d+)\b/m) || [])[1] ||
  (spec.match(/task-spec-(V\d+)/i) || [])[1] ||
  (path.basename(specPath).match(/(V\d+)/i) || [])[1]

if (!specVersion) fail('本地任务规格无法解析版本号')
else if (specVersion.toUpperCase() !== baseline.toUpperCase()) {
  fail(`版本不一致：Issue=${baseline} 规格=${specVersion}`)
}

if (runBaseline && runBaseline.toUpperCase() !== baseline.toUpperCase()) {
  fail(`Run 绑定版本不一致：Run=${runBaseline} Issue=${baseline}`)
}

// 未决事项：规格或同目录 definition-check 声明
const openItems =
  /未决产品事项[^\n]*[：:]\s*0\b/.test(spec) ||
  /未决[^。\n]*为\s*\*\*0\*\*/.test(spec) ||
  /未决事项\s*=\s*0/.test(spec) ||
  /\|[^\n]*未决[^\n]*\|\s*0\s*\|/.test(spec)

const defCheckNearby = [
  path.join(path.dirname(specPath), 'definition-check.md'),
  path.join(path.dirname(issuePath), 'definition-check.md'),
]
let defCheckOk = openItems
for (const p of defCheckNearby) {
  if (!fs.existsSync(p)) continue
  const d = fs.readFileSync(p, 'utf8')
  if (/未决.*0|全部通过|检查结果[：:].*通过/.test(d)) defCheckOk = true
}
if (!defCheckOk) {
  // 宽松：若规格有「已确认的关键决策」且无「待决/TBD/TODO 决策」字样
  const hasPending = /待决|TBD|TODO.*决策|未决产品事项[^\n]*[1-9]/.test(spec)
  if (hasPending) fail('仍存在未决产品事项迹象，不得开工')
  else defCheckOk = true
}

if (failures.length) {
  console.error('实施前检查未通过（执行受阻）：')
  for (const f of failures) console.error(`  - ${f}`)
  console.log(JSON.stringify({ ok: false, failures, auto_rework_limit: 3 }, null, 2))
  process.exit(1)
}

const result = {
  ok: true,
  track: status === '本地已定义' ? 'local' : 'github',
  task_id: taskId ?? null,
  github_sync: githubSync ?? null,
  status,
  baseline,
  unattended_permission: '允许',
  dependencies: deps,
  workspace_env: envGroup,
  workspace_role: envRole,
  priority,
  spec_path: specPath,
  auto_rework_limit: 3,
  next: '解析施工环境 → 开发',
}
console.log(JSON.stringify(result, null, 2))
process.exit(0)
