#!/usr/bin/env node
// Workspace Isolation 宿主包装脚本（#93 DSH Runtime Integration）
// 供 host.js runNode 调用，桥接 vm 沙箱与 workspace-isolation.mjs Core。
// 禁止平行实现 Git/lock —— 所有业务逻辑委托 Core。

import {
  createRegistry, allocateWorkspace, getRunWorkspace, setLifecycle, markAbandoned,
  recordSourceSync, workerScratchPath, assembleWorkerContext, writeWorkerFile, readWorkerFile,
  writeSourceFile, readSourceFile, buildAttemptProvenance, assertProofBinding,
  computeIntegrationCheckpointFromRepo, observeTargetHead,
  acquireLock, releaseLock, activeLockFor, cleanupWorkspace, recoverStale,
  resolveWorkspacePolicy,
} from './workspace-isolation.mjs'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'

const CMD = process.argv[2]
const INPUT = process.argv[3] ? JSON.parse(process.argv[3]) : {}

// 内存 Registry 单例（按 work_root 隔离）
// #93: Registry 持久化到磁盘，支持跨 runNode 调用保持状态（#79 前临时方案）
const REGISTRIES = new Map()

function registryPath(workRoot) {
  return workRoot + '/.vwf-registry'
}

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
  writeFileSync(p + '/state.json', JSON.stringify(data, null, 2) + '\n')
}

function getRegistry(workRoot) {
  if (!REGISTRIES.has(workRoot)) {
    REGISTRIES.set(workRoot, loadRegistry(workRoot))
  }
  return REGISTRIES.get(workRoot)
}

function persist(workRoot) {
  if (REGISTRIES.has(workRoot)) {
    saveRegistry(workRoot, REGISTRIES.get(workRoot))
  }
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
      const registry = getRegistry(work_root)
      const ws = allocateWorkspace(registry, { ...spec, work_root })
      persist(work_root)
      out({ ok: true, workspace: ws })
      break
    }
    case 'get': {
      const { work_root, logical_run_id } = INPUT
      if (!work_root || !logical_run_id) err('缺少 work_root 或 logical_run_id')
      const registry = getRegistry(work_root)
      const ws = getRunWorkspace(registry, logical_run_id)
      out({ ok: true, workspace: ws })
      break
    }
    case 'setLifecycle': {
      const { work_root, logical_run_id, lifecycle, extra } = INPUT
      if (!work_root || !logical_run_id || !lifecycle) err('缺少参数')
      const registry = getRegistry(work_root)
      const ws = setLifecycle(registry, logical_run_id, lifecycle, extra || {})
      persist(work_root)
      out({ ok: true, workspace: ws })
      break
    }
    case 'markAbandoned': {
      const { work_root, logical_run_id } = INPUT
      if (!work_root || !logical_run_id) err('缺少参数')
      const registry = getRegistry(work_root)
      const ws = markAbandoned(registry, logical_run_id)
      persist(work_root)
      out({ ok: true, workspace: ws })
      break
    }
    case 'recordSourceSync': {
      const { work_root, logical_run_id, current_head, source_revision } = INPUT
      if (!work_root || !logical_run_id) err('缺少参数')
      const registry = getRegistry(work_root)
      const ws = recordSourceSync(registry, logical_run_id, { current_head, source_revision })
      persist(work_root)
      out({ ok: true, workspace: ws })
      break
    }
    case 'buildAttemptProvenance': {
      const { workspace, node, attempt } = INPUT
      if (!workspace || !node || !attempt) err('缺少参数')
      const prov = buildAttemptProvenance(workspace, { node, attempt })
      out({ ok: true, provenance: prov })
      break
    }
    case 'assertProofBinding': {
      const { workspace, proof } = INPUT
      if (!workspace || !proof) err('缺少参数')
      const ok = assertProofBinding(workspace, proof)
      out({ ok: true, valid: ok })
      break
    }
    case 'acquireLock': {
      const { work_root, logical_run_id, resource_key, owner, ttl_ms } = INPUT
      if (!work_root || !logical_run_id || !resource_key || !owner) err('缺少参数')
      const registry = getRegistry(work_root)
      const lock = acquireLock(registry, { logical_run_id, resource_key, owner, ttl_ms })
      persist(work_root)
      out({ ok: true, lock })
      break
    }
    case 'releaseLock': {
      const { work_root, lock_id, owner, logical_run_id, reason } = INPUT
      if (!work_root || !lock_id || !owner || !logical_run_id) err('缺少参数')
      const registry = getRegistry(work_root)
      const lock = releaseLock(registry, { lock_id, owner, logical_run_id, reason })
      persist(work_root)
      out({ ok: true, lock })
      break
    }
    case 'activeLockFor': {
      const { work_root, resource_key } = INPUT
      if (!work_root || !resource_key) err('缺少参数')
      const registry = getRegistry(work_root)
      const lock = activeLockFor(registry, resource_key)
      out({ ok: true, lock: lock || null })
      break
    }
    case 'cleanup': {
      const { work_root, logical_run_id, opts } = INPUT
      if (!work_root || !logical_run_id) err('缺少参数')
      const registry = getRegistry(work_root)
      const audit = cleanupWorkspace(registry, logical_run_id, opts || {})
      persist(work_root)
      out({ ok: true, audit })
      break
    }
    case 'writeSourceFile': {
      const { workspace, rel, content } = INPUT
      if (!workspace || !rel || content === undefined) err('缺少参数')
      const path = writeSourceFile(workspace, rel, content)
      out({ ok: true, path })
      break
    }
    case 'readSourceFile': {
      const { workspace, rel } = INPUT
      if (!workspace || !rel) err('缺少参数')
      const content = readSourceFile(workspace, rel)
      out({ ok: true, content })
      break
    }
    case 'writeWorkerFile': {
      const { workspace, worker_id, rel, content } = INPUT
      if (!workspace || !worker_id || !rel || content === undefined) err('缺少参数')
      const path = writeWorkerFile(workspace, worker_id, rel, content)
      out({ ok: true, path })
      break
    }
    case 'readWorkerFile': {
      const { workspace, worker_id, rel } = INPUT
      if (!workspace || !worker_id || !rel) err('缺少参数')
      const content = readWorkerFile(workspace, worker_id, rel)
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
