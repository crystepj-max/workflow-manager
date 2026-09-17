#!/usr/bin/env node
// LOC-041 节点隔离宿主包装：桥接 vm 沙箱与 node-isolation.mjs Core。

import {
  ISOLATION_GUARANTEE, NODE_ROLE_CAPABILITIES,
  probeIsolationCapability, resolveNodeCapabilities, prepareNodeContext,
  enforceWrite, enforceRead, writeInZone, readInZone,
  publishProbe, runPrivilegeProbes, verifyCandidateUnchanged, canIssueIndependentProof,
} from './node-isolation.mjs'
import { getRunWorkspace } from './workspace-isolation.mjs'
import { loadRegistryFromWorkRoot } from './workspace-isolation-host-helpers.mjs'

const CMD = process.argv[2]
const INPUT = process.argv[3] ? JSON.parse(process.argv[3]) : {}

function out(result) {
  console.log(JSON.stringify(result))
}

function err(message, detail) {
  console.log(JSON.stringify({ ok: false, error: message, detail }))
  process.exit(0)
}

function resolveWorkspace(workRoot, runId) {
  const registry = loadRegistryFromWorkRoot(workRoot)
  let ws = null
  try {
    ws = getRunWorkspace(registry, runId)
  } catch (e) {
    for (const w of registry.workspaces.values()) {
      if (w.workspace_id === runId) { ws = w; break }
    }
    if (!ws) throw e
  }
  return ws
}

try {
  switch (CMD) {
    case 'probe': {
      const result = probeIsolationCapability(INPUT || {})
      out({ ok: true, ...result })
      break
    }
    case 'capabilities': {
      out({ ok: true, registry: NODE_ROLE_CAPABILITIES })
      break
    }
    case 'resolveCapabilities': {
      const { profile, node_capabilities } = INPUT
      if (!profile) err('缺少 profile')
      out({ ok: true, capabilities: resolveNodeCapabilities(profile, node_capabilities) })
      break
    }
    case 'prepareNode': {
      const { work_root, logical_run_id, node_id, profile, node_capabilities, isolation_guarantee } = INPUT
      if (!work_root || !logical_run_id || !node_id || !profile) err('缺少参数')
      const ws = resolveWorkspace(work_root, logical_run_id)
      const ctx = prepareNodeContext(ws, {
        node_id, profile, node_capabilities,
        isolation_guarantee: isolation_guarantee || ISOLATION_GUARANTEE.UNAVAILABLE,
      })
      out({ ok: true, context: ctx })
      break
    }
    case 'enforceWrite': {
      const { context, abs_path } = INPUT
      if (!context || !abs_path) err('缺少 context 或 abs_path')
      out({ ok: true, result: enforceWrite(context, abs_path) })
      break
    }
    case 'enforceRead': {
      const { context, abs_path } = INPUT
      if (!context || !abs_path) err('缺少 context 或 abs_path')
      out({ ok: true, result: enforceRead(context, abs_path) })
      break
    }
    case 'writeZone': {
      const { context, zone, rel, content, workspace_path } = INPUT
      if (!context || !zone || !rel || content === undefined) err('缺少参数')
      const path = writeInZone(context, zone, rel, content, workspace_path || null)
      out({ ok: true, path })
      break
    }
    case 'readZone': {
      const { context, zone, rel, workspace_path } = INPUT
      if (!context || !zone || !rel) err('缺少参数')
      const content = readInZone(context, zone, rel, workspace_path || null)
      out({ ok: true, content })
      break
    }
    case 'publishProbe': {
      out({ ok: true, result: publishProbe(INPUT || {}) })
      break
    }
    case 'privilegeProbes': {
      const { work_root, logical_run_id, node_id, profile, node_capabilities, isolation_guarantee, options } = INPUT
      if (!work_root || !logical_run_id || !node_id || !profile) err('缺少参数')
      const ws = resolveWorkspace(work_root, logical_run_id)
      const ctx = prepareNodeContext(ws, {
        node_id, profile, node_capabilities,
        isolation_guarantee: isolation_guarantee || ISOLATION_GUARANTEE.ENFORCED,
      })
      const results = runPrivilegeProbes(ctx, options || {})
      out({ ok: true, results, context: ctx })
      break
    }
    case 'verifyCandidate': {
      const { work_root, logical_run_id, node_id, profile, before_digest, node_capabilities, isolation_guarantee } = INPUT
      if (!work_root || !logical_run_id || !node_id || !profile || !before_digest) err('缺少参数')
      const ws = resolveWorkspace(work_root, logical_run_id)
      const ctx = prepareNodeContext(ws, {
        node_id, profile, node_capabilities,
        isolation_guarantee: isolation_guarantee || ISOLATION_GUARANTEE.ENFORCED,
      })
      out({ ok: true, verify: verifyCandidateUnchanged(ctx, before_digest) })
      break
    }
    case 'canIssueProof': {
      const { isolation_guarantee, profile, node_capabilities } = INPUT
      if (!profile) err('缺少 profile')
      const caps = resolveNodeCapabilities(profile, node_capabilities)
      out({ ok: true, decision: canIssueIndependentProof(isolation_guarantee, caps) })
      break
    }
    default:
      err('未知命令: ' + CMD)
  }
} catch (e) {
  err(e.message, e.stack)
}
