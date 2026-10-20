import fs from 'node:fs'
import path from 'node:path'
import { parseSpecVersion } from './task-card-parse.mjs'
import { specOpenItemsZero, strictDefinitionCheck } from './task-definition-checks.mjs'
import { MulticaTaskSourceError, readMulticaJsonMetadata, readMulticaTask } from './multica-task-source.mjs'

const DEFINITION_KEY = 'dev-flow.definition.v1'
const DEPENDENCIES_KEY = 'dev-flow.dependencies.v1'

function resultForFailures(failures, reasons) {
  return { ok: false, failures, reasons, fields: null }
}

function insideRepo(repo, relativePath) {
  const rel = String(relativePath || '').trim()
  if (!rel || path.isAbsolute(rel)) return null
  const resolved = path.resolve(repo, rel)
  const fromRoot = path.relative(repo, resolved)
  if (!fromRoot || fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) return null
  return resolved
}

/**
 * Construction gate backed only by the selected Multica workspace.
 * It deliberately has no local-registry or markdown-status fallback.
 */
export async function runMulticaTaskPreflight(taskId, opts = {}) {
  const failures = []
  const reasons = []
  const fail = (message, code, field = null) => {
    failures.push(message)
    reasons.push({ code, field, source: 'multica-preflight', message })
  }

  let issue
  try {
    issue = readMulticaTask(taskId, opts)
  } catch (error) {
    const code = error instanceof MulticaTaskSourceError ? error.code : 'MULTICA_UNAVAILABLE'
    fail(error.message || `无法读取 Multica Task ${taskId}。`, code, 'multicaTaskId')
    return resultForFailures(failures, reasons)
  }

  const status = String(issue.status || '').trim()
  const statusCategory = String(issue.status_category || '').trim()
  if (!['todo', 'in_progress'].includes(statusCategory)) {
    fail(`Multica Task 状态为「${status || '未知'}」（${statusCategory || '无状态分类'}），须为 todo 或 in_progress。`, 'MULTICA_TASK_STATUS_NOT_STARTABLE', 'status')
  }
  if (!issue.project_id) fail('Multica Task 未归属项目，不能进入项目施工流程。', 'MULTICA_TASK_PROJECT_MISSING', 'project_id')

  let definition
  let dependencies
  try {
    definition = readMulticaJsonMetadata(issue, DEFINITION_KEY)
  } catch (error) {
    fail(error.message, error.code || 'MULTICA_METADATA_INVALID', DEFINITION_KEY)
  }
  try {
    dependencies = readMulticaJsonMetadata(issue, DEPENDENCIES_KEY)
  } catch (error) {
    fail(error.message, error.code || 'MULTICA_METADATA_INVALID', DEPENDENCIES_KEY)
  }
  if (failures.length) return resultForFailures(failures, reasons)

  if (definition.definition_status !== 'defined') {
    fail(`Multica 定义状态为「${definition.definition_status || '缺失'}」，须为 defined。`, 'MULTICA_DEFINITION_NOT_CONFIRMED', 'definition_status')
  }
  const baseline = String(definition.baseline_version || '').trim()
  if (!/^V\d+$/i.test(baseline)) fail('Multica 定义元数据缺少有效 baseline_version。', 'MULTICA_BASELINE_INVALID', 'baseline_version')
  if (definition.unattended !== true) fail('Multica 定义元数据未明确允许无人值守施工。', 'MULTICA_UNATTENDED_NOT_ALLOWED', 'unattended')
  if (Number(definition.pending_product_decisions) !== 0) {
    fail('Multica 定义元数据仍有未决产品事项，须先完成定义。', 'MULTICA_PRODUCT_DECISIONS_PENDING', 'pending_product_decisions')
  }
  if (!String(definition.env_group || '').trim()) fail('Multica 定义元数据缺少 env_group。', 'MULTICA_ENV_GROUP_MISSING', 'env_group')
  if (!['independent', 'member'].includes(String(definition.env_role || '').trim())) {
    fail('Multica 定义元数据 env_role 须为 independent 或 member。', 'MULTICA_ENV_ROLE_INVALID', 'env_role')
  }
  if (!Array.isArray(dependencies)) fail('Multica dependencies 元数据必须是数组；无依赖时须显式写入 []。', 'MULTICA_DEPENDENCIES_INVALID', DEPENDENCIES_KEY)
  if (Array.isArray(dependencies) && dependencies.some((id) => typeof id !== 'string' || !id.trim())) {
    fail('Multica dependencies 元数据包含空或非字符串 Task UUID。', 'MULTICA_DEPENDENCIES_INVALID', DEPENDENCIES_KEY)
  }
  if (Array.isArray(dependencies) && new Set(dependencies).size !== dependencies.length) {
    fail('Multica dependencies 元数据包含重复依赖。', 'MULTICA_DEPENDENCIES_DUPLICATED', DEPENDENCIES_KEY)
  }
  if (failures.length) return resultForFailures(failures, reasons)

  const repo = path.resolve(opts.repo || process.cwd())
  const specPath = insideRepo(repo, definition.spec_ref)
  if (!specPath) {
    fail('Multica spec_ref 必须是仓库内的相对路径。', 'MULTICA_SPEC_REF_INVALID', 'spec_ref')
    return resultForFailures(failures, reasons)
  }
  if (!fs.existsSync(specPath)) {
    fail(`Multica spec_ref 指向的文件不存在：${definition.spec_ref}`, 'MULTICA_SPEC_MISSING', 'spec_ref')
    return resultForFailures(failures, reasons)
  }

  let spec
  try {
    spec = fs.readFileSync(specPath, 'utf8')
  } catch {
    fail(`无法读取 Multica spec_ref 指向的文件：${definition.spec_ref}`, 'MULTICA_SPEC_UNREADABLE', 'spec_ref')
    return resultForFailures(failures, reasons)
  }
  const specVersion = parseSpecVersion(spec, specPath)
  if (!specVersion) fail('本地规格无法解析版本号。', 'MULTICA_SPEC_VERSION_MISSING', 'spec_ref')
  else if (specVersion.toUpperCase() !== baseline.toUpperCase()) {
    fail(`版本不一致：Multica=${baseline}，规格=${specVersion}。`, 'MULTICA_SPEC_VERSION_MISMATCH', 'baseline_version')
  }

  const runBaseline = String(opts.runBaseline || '').trim()
  if (runBaseline && runBaseline.toUpperCase() !== baseline.toUpperCase()) {
    fail(`Run 绑定版本不一致：Run=${runBaseline}，Multica=${baseline}。`, 'MULTICA_RUN_BASELINE_MISMATCH', 'runBaseline')
  }

  const definitionCheckPath = path.join(path.dirname(specPath), 'definition-check.md')
  if (!fs.existsSync(definitionCheckPath)) {
    fail(`Multica spec_ref 同目录缺少 definition-check.md：${definitionCheckPath}`, 'MULTICA_DEFINITION_CHECK_MISSING', 'definition-check')
  } else {
    const check = strictDefinitionCheck(fs.readFileSync(definitionCheckPath, 'utf8'))
    if (!check.ok) fail(check.reason, 'MULTICA_DEFINITION_CHECK_INCOMPLETE', 'definition-check')
  }
  if (!specOpenItemsZero(spec)) fail('规格未声明未决产品事项=0。', 'MULTICA_SPEC_OPEN_ITEMS', 'spec_ref')
  if (/待决|TBD|TODO.*决策|未决产品事项[^\n]*[1-9]/.test(spec)) {
    fail('规格仍存在未决产品事项迹象。', 'MULTICA_SPEC_OPEN_ITEMS', 'spec_ref')
  }

  const dependencyResults = []
  for (const dependencyId of dependencies) {
    let dependency
    try {
      dependency = readMulticaTask(dependencyId, opts)
    } catch (error) {
      fail(`无法从 Multica 确认依赖 ${dependencyId}：${error.message}`, error.code || 'MULTICA_DEPENDENCY_UNAVAILABLE', 'dependencies')
      continue
    }
    const isDone = dependency.status === 'done' && dependency.status_category === 'done'
    dependencyResults.push({ id: dependency.id, identifier: dependency.identifier || dependencyId, status: dependency.status, status_category: dependency.status_category })
    if (!isDone) {
      fail(`前置依赖 ${dependency.identifier || dependencyId} 在 Multica 的状态为「${dependency.status || '未知'}」（${dependency.status_category || '无状态分类'}），须同时为 done / done。`, 'MULTICA_DEPENDENCY_NOT_DONE', 'dependencies')
    }
  }

  if (failures.length) return resultForFailures(failures, reasons)
  return {
    ok: true,
    failures,
    reasons,
    fields: {
      source: 'multica',
      task_id: issue.id,
      identifier: issue.identifier || String(taskId),
      status,
      status_category: statusCategory,
      project_id: issue.project_id,
      assignee_id: issue.assignee_id || null,
      assignee_type: issue.assignee_type || null,
      baseline,
      unattended_permission: definition.unattended,
      dependencies,
      dependency_statuses: dependencyResults,
      workspace_env: definition.env_group,
      workspace_role: definition.env_role,
      priority: issue.priority || null,
      spec_path: specPath,
    },
  }
}
