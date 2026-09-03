#!/usr/bin/env node
// Workspace Isolation 宿主包装脚本（#93 DSH Runtime Integration）
// 供 host.js runNode 调用，桥接 vm 沙箱与 workspace-isolation.mjs Core。
// 禁止平行实现 Git/lock —— 所有业务逻辑委托 Core。
//
// 安全边界（Codex Round 1 A 类修复）：
//  - A1：注册表 load-modify-save 全程跨进程文件锁 + 临时文件原子换入，
//    并发 allocate / acquireLock 等不再后写覆盖先写（integration lock 串行语义）。
//  - A4：写操作 RPC 只接收 Run 身份（logical_run_id / workspace_id），
//    权威 workspace 在本脚本内从注册表解析，不信任调用方传入的对象路径。

import {
  createRegistry, allocateWorkspace, getRunWorkspace, setLifecycle, markAbandoned,
  recordSourceSync, workerScratchPath, assembleWorkerContext, writeWorkerFile, readWorkerFile,
  writeSourceFile, readSourceFile, buildAttemptProvenance, assertProofBinding,
  computeIntegrationCheckpointFromRepo, observeTargetHead,
  acquireLock, releaseLock, activeLockFor, cleanupWorkspace, recoverStale,
  resolveWorkspacePolicy,
} from './workspace-isolation.mjs'
import {
  mkdirSync, writeFileSync, readFileSync, existsSync,
  unlinkSync, renameSync, linkSync,
} from 'node:fs'

const CMD = process.argv[2]
const INPUT = process.argv[3] ? JSON.parse(process.argv[3]) : {}

// 本进程缓存：每个 wsHostCall 是独立进程，缓存无跨进程意义；统一从磁盘
// load 权威状态，保证并发下读到最新。进程内缓存仅避免同进程重复 IO。
const REGISTRIES = new Map()

function registryPath(workRoot) {
  return workRoot + '/.vwf-registry'
}

function lockPath(workRoot) {
  return registryPath(workRoot) + '.lock'
}

// ── 跨进程文件锁（A1 / A2-2 / R3-4）──────────────────────────────────────
// 用原子 hardlink 发布锁记录：先把完整 JSON 写进临时文件，再 linkSync 到锁路径
// （目标已存在则 EEXIST）。锁文件从出现那一刻起就含完整 {pid, token, at}，消除
// openSync('wx') 与写内容之间的空文件窗口——竞争者不会再因读到空/半写内容而误判
// stale 删除仍存活的锁（Codex Round 3 R3-4）。
// stale 判定：仅当持有者进程已退出（PID 不存活）才接管——长事务（如大型仓库
// git worktree add）即使超过固定秒数也不得抢占仍存活的锁；释放只允许持有 token
// 的所有者，避免原持有者无条件删除继任者的锁（Codex Round 2 A2-2）。
function sleepMs(ms) {
  const sab = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(sab), 0, 0, ms)
}

function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

// 返回本进程持有的锁 token（释放时必须带回）。
function acquireFileLock(lockPath, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  const token = Math.random().toString(36).slice(2) + '-' + Date.now().toString(36) + '-' + process.pid.toString(36)
  const payload = JSON.stringify({ pid: process.pid, token, at: Date.now() }) + '\n'
  for (;;) {
    // 原子发布：临时文件（唯一名）→ hardlink 到锁路径；目标存在 → EEXIST = 被占用
    const tmp = lockPath + '.init-' + process.pid + '-' + Math.random().toString(36).slice(2)
    let created = false
    try {
      writeFileSync(tmp, payload)
      created = true
      try {
        linkSync(tmp, lockPath)
        try { unlinkSync(tmp) } catch { /* 临时文件清理失败不阻塞持锁 */ }
        return token
      } catch (e) {
        try { unlinkSync(tmp) } catch { /* ignore */ }
        if (e.code !== 'EEXIST') throw e
        // 锁被占用：落入下方 stale 检查（内容必完整，无初始化窗口）
      }
    } catch (e) {
      if (created) { try { unlinkSync(tmp) } catch { /* ignore */ } }
      if (e.code !== 'EEXIST') throw e
      // tmp 唯一名撞车（几乎不可能）：重试下一轮
      continue
    }
    // 仅当持有者进程已退出才接管；否则继续等待（长事务不误伤）。
    // 内容不可解析理论上不发生（原子发布保证）；若发生按非 stale 等待，绝不当即接管
    let stale = false
    try {
      const info = JSON.parse(readFileSync(lockPath, 'utf8'))
      if (!info || typeof info.pid !== 'number') stale = true
      else if (!processAlive(info.pid)) stale = true
    } catch {
      stale = false
    }
    if (stale) {
      try { unlinkSync(lockPath) } catch { /* 已被其他进程接管 */ }
      continue
    }
    if (Date.now() > deadline) throw new Error('workspace 注册表跨进程锁等待超时: ' + lockPath)
    sleepMs(20)
  }
}

function releaseFileLock(lockPath, token) {
  // 只允许持有者释放：锁文件 token 不匹配说明已被接管，不得删除继任者的锁
  try {
    const info = JSON.parse(readFileSync(lockPath, 'utf8'))
    if (info.token !== token) return
  } catch { /* 锁文件缺失/损坏：尽力清理 */ }
  try { unlinkSync(lockPath) } catch { /* 已释放 */ }
}

// ── Registry 序列化 / 原子换入（A1）──────────────────────────────────────
function loadRegistry(workRoot) {
  const p = registryPath(workRoot)
  try {
    const data = JSON.parse(readFileSync(p + '/state.json', 'utf-8'))
    const reg = createRegistry()
    if (data.workspaces) {
      for (const [k, v] of Object.entries(data.workspaces)) reg.workspaces.set(k, v)
    }
    if (data.locks) {
      for (const [k, v] of Object.entries(data.locks)) reg.locks.set(k, v)
    }
    if (data.locksByKey) {
      for (const [k, v] of Object.entries(data.locksByKey)) reg.locksByKey.set(k, v)
    }
    if (data.timeline) reg.timeline = data.timeline
    if (data.archived) {
      for (const [k, v] of Object.entries(data.archived)) reg.archived.set(k, v)
    }
    if (data.lockSeq) reg.lockSeq = data.lockSeq
    if (data.nextPort) reg.nextPort = data.nextPort
    if (data.ports) {
      for (const port of data.ports) reg.ports.add(port)
    }
    return reg
  } catch {
    return createRegistry()
  }
}

function saveRegistry(workRoot, registry) {
  const p = registryPath(workRoot)
  try { mkdirSync(p, { recursive: true }) } catch { /* ignore */ }
  const data = {
    workspaces: Object.fromEntries(registry.workspaces),
    locks: Object.fromEntries(registry.locks),
    locksByKey: Object.fromEntries(registry.locksByKey),
    timeline: registry.timeline,
    archived: Object.fromEntries(registry.archived),
    lockSeq: registry.lockSeq,
    nextPort: registry.nextPort,
    ports: Array.from(registry.ports),
  }
  // 临时文件 + rename：原子换入，崩溃不产生半写 state.json
  const tmp = p + '/state.json.tmp'
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n')
  renameSync(tmp, p + '/state.json')
}

// 修改型命令统一走事务：跨进程锁 → 最新状态 → 修改 → 原子落盘 → 释放。
// 读命令（get / activeLockFor / provenance 等）同样持锁读，避免读到
// 并发写的中途状态。
// A1-2（Codex Round 2）：事务开始前先递归创建 workRoot——全新 DSH Home
// 尚无 ~/.dsh*/workspaces 时，锁文件与注册表目录的父目录必须存在。
function withRegistryTx(workRoot, fn) {
  const lp = lockPath(workRoot)
  mkdirSync(workRoot, { recursive: true })
  const token = acquireFileLock(lp)
  try {
    const registry = loadRegistry(workRoot)
    const result = fn(registry)
    saveRegistry(workRoot, registry)
    return result
  } finally {
    releaseFileLock(lp, token)
  }
}

// 只读命令：持锁读取，不落盘。
function withRegistryRead(workRoot, fn) {
  const lp = lockPath(workRoot)
  mkdirSync(workRoot, { recursive: true })
  const token = acquireFileLock(lp)
  try {
    const registry = loadRegistry(workRoot)
    return fn(registry)
  } finally {
    releaseFileLock(lp, token)
  }
}

// 从注册表解析权威 workspace（A4）：只接受 Run 身份，禁止信任调用方对象。
function resolveWorkspaceFromRegistry(workRoot, runId) {
  const runIdText = String(runId || '')
  if (!runIdText) throw new Error('缺少 logical_run_id / workspace_id')
  return withRegistryRead(workRoot, (registry) => {
    let ws = null
    try {
      ws = getRunWorkspace(registry, runIdText)
    } catch (e) {
      // 兼容 workspace_id 解析：遍历注册表按 workspace_id 匹配
      for (const w of registry.workspaces.values()) {
        if (w.workspace_id === runIdText) { ws = w; break }
      }
      if (!ws) throw e
    }
    return ws
  })
}

function out(result) {
  console.log(JSON.stringify(result))
}

function err(message, detail) {
  console.log(JSON.stringify({ ok: false, error: message, detail }))
  process.exit(0)
}

try {
  switch (CMD) {
    case 'allocate': {
      const { work_root, ...spec } = INPUT
      if (!work_root) err('缺少 work_root')
      const ws = withRegistryTx(work_root, (registry) => allocateWorkspace(registry, { ...spec, work_root }))
      out({ ok: true, workspace: ws })
      break
    }
    case 'get': {
      const { work_root, logical_run_id } = INPUT
      if (!work_root || !logical_run_id) err('缺少 work_root 或 logical_run_id')
      const ws = withRegistryRead(work_root, (registry) => getRunWorkspace(registry, logical_run_id))
      out({ ok: true, workspace: ws })
      break
    }
    case 'setLifecycle': {
      const { work_root, logical_run_id, lifecycle, extra } = INPUT
      if (!work_root || !logical_run_id || !lifecycle) err('缺少参数')
      const ws = withRegistryTx(work_root, (registry) => setLifecycle(registry, logical_run_id, lifecycle, extra || {}))
      out({ ok: true, workspace: ws })
      break
    }
    case 'markAbandoned': {
      const { work_root, logical_run_id } = INPUT
      if (!work_root || !logical_run_id) err('缺少参数')
      const ws = withRegistryTx(work_root, (registry) => markAbandoned(registry, logical_run_id))
      out({ ok: true, workspace: ws })
      break
    }
    case 'recordSourceSync': {
      const { work_root, logical_run_id, current_head, source_revision } = INPUT
      if (!work_root || !logical_run_id) err('缺少参数')
      const ws = withRegistryTx(work_root, (registry) => recordSourceSync(registry, logical_run_id, { current_head, source_revision }))
      out({ ok: true, workspace: ws })
      break
    }
    case 'buildAttemptProvenance': {
      // A4：只接收 Run 身份，权威 workspace 从注册表解析
      const { work_root, logical_run_id, workspace_id, node, attempt } = INPUT
      const runId = logical_run_id || workspace_id
      if (!work_root || !runId || !node || !attempt) err('缺少参数')
      const ws = resolveWorkspaceFromRegistry(work_root, runId)
      const prov = buildAttemptProvenance(ws, { node, attempt })
      out({ ok: true, provenance: prov })
      break
    }
    case 'assertProofBinding': {
      // A4：workspace 从注册表解析，proof 由 Core 逐字段核对
      const { work_root, logical_run_id, workspace_id, proof } = INPUT
      const runId = logical_run_id || workspace_id
      if (!work_root || !runId || !proof) err('缺少参数')
      const ws = resolveWorkspaceFromRegistry(work_root, runId)
      const ok = assertProofBinding(ws, proof)
      out({ ok: true, valid: ok })
      break
    }
    case 'acquireLock': {
      const { work_root, logical_run_id, resource_key, owner, ttl_ms } = INPUT
      if (!work_root || !logical_run_id || !resource_key || !owner) err('缺少参数')
      const lock = withRegistryTx(work_root, (registry) => acquireLock(registry, { logical_run_id, resource_key, owner, ttl_ms }))
      out({ ok: true, lock })
      break
    }
    case 'releaseLock': {
      const { work_root, lock_id, owner, logical_run_id, reason } = INPUT
      if (!work_root || !lock_id || !owner || !logical_run_id) err('缺少参数')
      const lock = withRegistryTx(work_root, (registry) => releaseLock(registry, { lock_id, owner, logical_run_id, reason }))
      out({ ok: true, lock })
      break
    }
    case 'activeLockFor': {
      const { work_root, resource_key } = INPUT
      if (!work_root || !resource_key) err('缺少参数')
      const lock = withRegistryRead(work_root, (registry) => activeLockFor(registry, resource_key))
      out({ ok: true, lock: lock || null })
      break
    }
    case 'cleanup': {
      const { work_root, logical_run_id, opts } = INPUT
      if (!work_root || !logical_run_id) err('缺少参数')
      const audit = withRegistryTx(work_root, (registry) => cleanupWorkspace(registry, logical_run_id, opts || {}))
      out({ ok: true, audit })
      break
    }
    case 'writeSourceFile': {
      // A4：workspace 从注册表解析，禁止信任调用方路径
      const { work_root, logical_run_id, workspace_id, rel, content } = INPUT
      const runId = logical_run_id || workspace_id
      if (!work_root || !runId || !rel || content === undefined) err('缺少参数')
      const ws = resolveWorkspaceFromRegistry(work_root, runId)
      const path = writeSourceFile(ws, rel, content)
      out({ ok: true, path })
      break
    }
    case 'readSourceFile': {
      const { work_root, logical_run_id, workspace_id, rel } = INPUT
      const runId = logical_run_id || workspace_id
      if (!work_root || !runId || !rel) err('缺少参数')
      const ws = resolveWorkspaceFromRegistry(work_root, runId)
      const content = readSourceFile(ws, rel)
      out({ ok: true, content })
      break
    }
    case 'writeWorkerFile': {
      const { work_root, logical_run_id, workspace_id, worker_id, rel, content } = INPUT
      const runId = logical_run_id || workspace_id
      if (!work_root || !runId || !worker_id || !rel || content === undefined) err('缺少参数')
      const ws = resolveWorkspaceFromRegistry(work_root, runId)
      const path = writeWorkerFile(ws, worker_id, rel, content)
      out({ ok: true, path })
      break
    }
    case 'readWorkerFile': {
      const { work_root, logical_run_id, workspace_id, worker_id, rel } = INPUT
      const runId = logical_run_id || workspace_id
      if (!work_root || !runId || !worker_id || !rel) err('缺少参数')
      const ws = resolveWorkspaceFromRegistry(work_root, runId)
      const content = readWorkerFile(ws, worker_id, rel)
      out({ ok: true, content })
      break
    }
    case 'computeIntegrationCheckpointFromRepo': {
      const { base_ref, base_commit, repository_path, target_ref } = INPUT
      if (!base_ref || !base_commit || !repository_path) err('缺少参数')
      const checkpoint = computeIntegrationCheckpointFromRepo({ base_ref, base_commit, repository_path, target_ref })
      out({ ok: true, checkpoint })
      break
    }
    case 'observeTargetHead': {
      const { repository_path, ref } = INPUT
      if (!repository_path || !ref) err('缺少参数')
      const head = observeTargetHead(repository_path, ref)
      out({ ok: true, head })
      break
    }
    case 'resolvePolicy': {
      const { template_id, input } = INPUT
      if (!template_id) err('缺少 template_id')
      const policy = resolveWorkspacePolicy(template_id, input || {})
      out({ ok: true, policy })
      break
    }
    default:
      err('未知命令: ' + CMD)
  }
} catch (e) {
  err(e.message, e.stack)
}
