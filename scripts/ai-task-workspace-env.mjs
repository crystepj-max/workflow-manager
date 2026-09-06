#!/usr/bin/env node
/**
 * 单任务施工环境组：沿用关联分支/worktree，或新建；全员验收通过后再清理。
 * 批量调度不得调用本模块管理分支/工作区。
 *
 * CLI:
 *   node scripts/ai-task-workspace-env.mjs resolve --store <dir> --task <id> --env <envId> --role 独立|成员 --deps 无|<id,id> [--repo <path>] [--work-root <path>] [--base-ref <ref>]
 *   node scripts/ai-task-workspace-env.mjs mark-completed --store <dir> --env <envId> --task <id>
 *   node scripts/ai-task-workspace-env.mjs maybe-cleanup --store <dir> --env <envId> [--force-git]
 *
 * 纯函数亦 export，供测试。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  allocateWorkspace,
  cleanupWorkspace,
  createRegistry,
  setLifecycle,
  LIFECYCLE,
} from './workspace-isolation.mjs'

const ROLE_INDEPENDENT = new Set(['独立', 'root', 'independent'])
const ROLE_MEMBER = new Set(['成员', 'member'])

export function normalizeRole(raw) {
  const s = String(raw || '').trim()
  if (ROLE_INDEPENDENT.has(s)) return 'independent'
  if (ROLE_MEMBER.has(s)) return 'member'
  throw new Error(`施工环境角色非法：${raw ?? '（缺失）'}（须为「独立」或「成员」）`)
}

export function parseDeps(raw) {
  const s = String(raw ?? '').trim()
  if (!s || s === '无') return []
  return s.split(/[,，、\s]+/).map((x) => x.trim()).filter(Boolean)
}

function envPath(storeDir, envId) {
  return path.join(storeDir, `${envId}.json`)
}

export function loadEnv(storeDir, envId) {
  const p = envPath(storeDir, envId)
  if (!fs.existsSync(p)) return null
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

export function saveEnv(storeDir, env) {
  fs.mkdirSync(storeDir, { recursive: true })
  const p = envPath(storeDir, env.env_id)
  fs.writeFileSync(p, JSON.stringify(env, null, 2) + '\n')
  return p
}

/**
 * 判定启动策略（不碰 Git）。
 * @returns {{ action: 'create'|'reuse'|'block', reason?: string, env?: object }}
 */
export function planDeliveryWorkspace({
  taskId,
  envId,
  role,
  deps = [],
  existingEnv = null,
}) {
  const id = String(taskId || '').trim()
  const eid = String(envId || '').trim()
  if (!id) return { action: 'block', reason: 'taskId 缺失' }
  if (!eid) return { action: 'block', reason: '施工环境组缺失' }

  let normalized
  try {
    normalized = normalizeRole(role)
  } catch (e) {
    return { action: 'block', reason: String(e.message || e) }
  }

  if (normalized === 'independent') {
    if (existingEnv && !existingEnv.cleaned_up_at) {
      const mine = (existingEnv.members || []).find((m) => m.task_id === id)
      if (mine) {
        return {
          action: 'reuse',
          reason: '本任务已在环境组内登记，沿用现场',
          env: existingEnv,
        }
      }
      return {
        action: 'block',
        reason: `环境组 ${eid} 已存在，独立任务不得覆盖；请改角色为「成员」或换环境组`,
      }
    }
    return { action: 'create', env: existingEnv }
  }

  // member
  if (!existingEnv || existingEnv.cleaned_up_at) {
    return { action: 'block', reason: `环境组 ${eid} 尚未建立或已清理：成员任务须等 root 先开工` }
  }
  const depList = Array.isArray(deps) ? deps : parseDeps(deps)
  for (const dep of depList) {
    const m = (existingEnv.members || []).find((x) => x.task_id === dep)
    if (!m) {
      return { action: 'block', reason: `前置依赖 ${dep} 不在环境组 ${eid} 成员中` }
    }
    if (m.status !== 'completed') {
      return {
        action: 'block',
        reason: `串行等待：前置依赖 ${dep} 状态为 ${m.status}（须已完成）`,
      }
    }
  }
  return { action: 'reuse', env: existingEnv }
}

/**
 * 创建或沿用。create 时调用 #93 allocateWorkspace（可用 injectRegistry 测）。
 */
export function resolveDeliveryWorkspace(opts) {
  const {
    storeDir,
    taskId,
    envId,
    role,
    deps = [],
    repository_path,
    work_root,
    base_ref = 'HEAD',
    work_branch,
    registry: injectedRegistry,
    skipGit = false,
  } = opts

  if (!storeDir) throw new Error('storeDir 必填')
  const existing = loadEnv(storeDir, envId)
  const plan = planDeliveryWorkspace({
    taskId,
    envId,
    role,
    deps,
    existingEnv: existing,
  })
  if (plan.action === 'block') {
    return { ok: false, blocked: true, reason: plan.reason }
  }

  if (plan.action === 'reuse') {
    const env = plan.env
    const members = env.members || []
    if (!members.some((m) => m.task_id === taskId)) {
      members.push({
        task_id: taskId,
        role: 'member',
        status: 'delivering',
        depends_on: parseDeps(deps),
      })
      env.members = members
      saveEnv(storeDir, env)
    } else {
      const mine = members.find((m) => m.task_id === taskId)
      if (mine.status === 'defined' || mine.status === 'blocked') mine.status = 'delivering'
      saveEnv(storeDir, env)
    }
    return {
      ok: true,
      action: 'reuse',
      env_id: env.env_id,
      work_branch: env.work_branch,
      workspace_path: env.workspace_path,
      source_path: env.source_path,
      logical_run_id: env.logical_run_id,
    }
  }

  // create
  const branch = work_branch || `feat/env-${envId}`
  const logical_run_id = `env-${envId}`
  let workspace_path = null
  let source_path = null
  let allocated = null

  if (!skipGit) {
    const registry = injectedRegistry || createRegistry()
    const root = work_root || path.join(storeDir, '_work')
    fs.mkdirSync(root, { recursive: true })
    allocated = allocateWorkspace(registry, {
      logical_run_id,
      workspace_id: `ws-env-${envId}`,
      mode: 'ISOLATED_WRITE',
      work_root: root,
      repository_path: repository_path || process.cwd(),
      base_ref,
      work_branch: branch,
      task_identity: envId,
      allow_parallel: true,
    })
    workspace_path = allocated.workspace_path
    source_path = allocated.source_path
    // 持久化 registry 快照供 cleanup（简化：把关键字段写入 env）
    opts._registry = registry
  } else {
    workspace_path = path.join(work_root || storeDir, `ws-env-${envId}`)
    source_path = workspace_path
    fs.mkdirSync(workspace_path, { recursive: true })
  }

  const env = {
    env_id: envId,
    work_branch: branch,
    workspace_path,
    source_path,
    repository_path: repository_path || null,
    logical_run_id,
    root_task_id: taskId,
    members: [
      {
        task_id: taskId,
        role: 'independent',
        status: 'delivering',
        depends_on: [],
      },
    ],
    created_at: new Date().toISOString(),
    cleaned_up_at: null,
  }
  saveEnv(storeDir, env)
  return {
    ok: true,
    action: 'create',
    env_id: env.env_id,
    work_branch: env.work_branch,
    workspace_path: env.workspace_path,
    source_path: env.source_path,
    logical_run_id: env.logical_run_id,
    registry: opts._registry || null,
  }
}

export function markTaskCompleted(storeDir, envId, taskId) {
  const env = loadEnv(storeDir, envId)
  if (!env) throw new Error(`环境组不存在：${envId}`)
  const m = (env.members || []).find((x) => x.task_id === taskId)
  if (!m) throw new Error(`任务 ${taskId} 不在环境组 ${envId}`)
  m.status = 'completed'
  saveEnv(storeDir, env)
  return env
}

export function allMembersCompleted(env) {
  const members = env.members || []
  return members.length > 0 && members.every((m) => m.status === 'completed')
}

/**
 * 全员完成后清理。forceGit=false 时仅标记 cleaned_up（单测）；true 时调 #93 cleanup。
 */
export function maybeCleanupEnv(storeDir, envId, { forceGit = false, registry = null } = {}) {
  const env = loadEnv(storeDir, envId)
  if (!env) return { ok: false, cleaned: false, reason: '环境组不存在' }
  if (env.cleaned_up_at) return { ok: true, cleaned: false, reason: '已清理过' }
  if (!allMembersCompleted(env)) {
    return {
      ok: true,
      cleaned: false,
      reason: '同组仍有未验收通过的任务，暂不清理',
      pending: (env.members || []).filter((m) => m.status !== 'completed').map((m) => m.task_id),
    }
  }
  if (forceGit && registry && env.logical_run_id) {
    try {
      setLifecycle(registry, env.logical_run_id, LIFECYCLE.COMPLETED)
    } catch { /* 可能已是终态 */ }
    cleanupWorkspace(registry, env.logical_run_id)
  }
  env.cleaned_up_at = new Date().toISOString()
  saveEnv(storeDir, env)
  return { ok: true, cleaned: true, env_id: envId }
}

// —— CLI ——
function main(argv) {
  const cmd = argv[0]
  const get = (flag) => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  if (cmd === 'resolve') {
    const out = resolveDeliveryWorkspace({
      storeDir: get('--store'),
      taskId: get('--task'),
      envId: get('--env'),
      role: get('--role'),
      deps: parseDeps(get('--deps') || '无'),
      repository_path: get('--repo'),
      work_root: get('--work-root'),
      base_ref: get('--base-ref') || 'HEAD',
      work_branch: get('--branch'),
      skipGit: argv.includes('--skip-git'),
    })
    console.log(JSON.stringify(out, null, 2))
    process.exit(out.ok ? 0 : 1)
  }
  if (cmd === 'mark-completed') {
    const env = markTaskCompleted(get('--store'), get('--env'), get('--task'))
    console.log(JSON.stringify({ ok: true, members: env.members }, null, 2))
    return
  }
  if (cmd === 'maybe-cleanup') {
    const out = maybeCleanupEnv(get('--store'), get('--env'), {
      forceGit: argv.includes('--force-git'),
    })
    console.log(JSON.stringify(out, null, 2))
    process.exit(out.ok ? 0 : 1)
  }
  console.error('用法: resolve | mark-completed | maybe-cleanup')
  process.exit(2)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
}
