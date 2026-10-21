import { execFileSync } from 'node:child_process'

export class MulticaTaskSourceError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'MulticaTaskSourceError'
    this.code = code
  }
}

function selectedContext({ profile, workspaceId }) {
  const selectedProfile = String(profile || process.env.MULTICA_PROFILE || '').trim()
  const selectedWorkspace = String(workspaceId || process.env.MULTICA_WORKSPACE_ID || '').trim()
  if (!selectedProfile) {
    throw new MulticaTaskSourceError(
      'MULTICA_PROFILE_REQUIRED',
      '未指定 Multica profile。设置 MULTICA_PROFILE 或传入 multicaProfile，避免误连其他 Multica 服务。',
    )
  }
  if (!selectedWorkspace) {
    throw new MulticaTaskSourceError(
      'MULTICA_WORKSPACE_REQUIRED',
      '未指定 Multica workspace。设置 MULTICA_WORKSPACE_ID 或传入 multicaWorkspaceId。',
    )
  }
  return { profile: selectedProfile, workspaceId: selectedWorkspace }
}

function parseIssue(stdout, taskId) {
  let issue
  try {
    issue = JSON.parse(stdout)
  } catch {
    throw new MulticaTaskSourceError('MULTICA_RESPONSE_INVALID', `Multica 返回的任务 ${taskId} 不是有效 JSON。`)
  }
  if (!issue || typeof issue !== 'object' || !issue.id) {
    throw new MulticaTaskSourceError('MULTICA_TASK_NOT_FOUND', `Multica 未返回任务 ${taskId}。`)
  }
  return issue
}

/** Read one current task snapshot from the explicitly selected Multica workspace. */
export function readMulticaTask(taskId, opts = {}) {
  const identifier = String(taskId || '').trim()
  if (!identifier) throw new MulticaTaskSourceError('MULTICA_TASK_ID_REQUIRED', '缺少 Multica Task ID。')

  const { profile, workspaceId } = selectedContext(opts)
  const exec = opts.execFileSync || execFileSync
  const args = [
    '--profile', profile,
    '--workspace-id', workspaceId,
    'issue', 'get', identifier,
    '--output', 'json',
  ]

  let stdout
  try {
    stdout = exec('multica', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    const status = Number.isInteger(error?.status) ? `（退出码 ${error.status}）` : ''
    throw new MulticaTaskSourceError(
      'MULTICA_UNAVAILABLE',
      `无法从 Multica 读取任务 ${identifier}${status}。检查登录状态、profile 与 workspace；未读取本地登记册作为替代。`,
    )
  }

  const issue = parseIssue(String(stdout), identifier)
  if (issue.workspace_id !== workspaceId) {
    throw new MulticaTaskSourceError(
      'MULTICA_WORKSPACE_MISMATCH',
      `任务 ${identifier} 返回的 workspace_id 与指定 workspace 不一致，拒绝使用该快照。`,
    )
  }
  return issue
}

/** Decode a JSON string stored in Multica task metadata. */
export function readMulticaJsonMetadata(issue, key) {
  const metadata = issue?.metadata
  if (!metadata || typeof metadata !== 'object' || !Object.hasOwn(metadata, key)) {
    throw new MulticaTaskSourceError('MULTICA_METADATA_MISSING', `Multica Task 缺少必需元数据 ${key}。`)
  }

  let value = metadata[key]
  if (value && typeof value === 'object' && Object.hasOwn(value, 'value')) value = value.value
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      throw new MulticaTaskSourceError('MULTICA_METADATA_INVALID', `Multica 元数据 ${key} 不是有效 JSON。`)
    }
  }
  if (!value || typeof value !== 'object') {
    throw new MulticaTaskSourceError('MULTICA_METADATA_INVALID', `Multica 元数据 ${key} 必须是 JSON 对象或数组。`)
  }
  return value
}
