#!/usr/bin/env node
// LOC-041 节点隔离内核：node_capabilities、isolation_guarantee 探测与执行适配。
// 候选位于节点可写根之外；证据/测试覆盖层/缓存有独立写区；发布走受控通道。
// 强制边界依赖宿主文件/进程沙箱（macOS sandbox-exec 参考配置），chmod/提示词不算证据。

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync,
  realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateRecord } from './cwf-validate.mjs'

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'design', 'node-isolation', 'schema.json')

export const ISOLATION_GUARANTEE = {
  ENFORCED: 'enforced',
  UNAVAILABLE: 'unavailable',
}

export const ZONE = {
  CANDIDATE: 'candidate',
  SOURCE: 'source',
  EVIDENCE: 'evidence',
  TEST_OVERLAY: 'test_overlay',
}

// 按 profile 的最小能力矩阵（规格 §9）。蓝图 node_capabilities 可收紧，不得放宽。
export const NODE_ROLE_CAPABILITIES = {
  dev: {
    candidate: { read: true, write: true },
    source: { read: true, write: true },
    evidence: { read: true, write: true },
    test_overlay: { read: true, write: true },
    publish: false,
    independent_proof: false,
  },
  review: {
    candidate: { read: true, write: false },
    source: { read: true, write: false },
    evidence: { read: true, write: true },
    test_overlay: { read: false, write: false },
    publish: false,
    independent_proof: true,
  },
  test: {
    candidate: { read: true, write: false },
    source: { read: true, write: false },
    evidence: { read: true, write: true },
    test_overlay: { read: true, write: true },
    publish: false,
    independent_proof: true,
  },
  researcher: {
    candidate: { read: true, write: false },
    source: { read: true, write: false },
    evidence: { read: true, write: true },
    test_overlay: { read: false, write: false },
    publish: false,
    independent_proof: false,
  },
  diagnose: {
    candidate: { read: true, write: true },
    source: { read: true, write: true },
    evidence: { read: true, write: true },
    test_overlay: { read: true, write: true },
    publish: false,
    independent_proof: false,
  },
  closeout: {
    candidate: { read: true, write: false },
    source: { read: true, write: false },
    evidence: { read: true, write: true },
    test_overlay: { read: false, write: false },
    publish: true,
    independent_proof: false,
  },
  evaluator: {
    candidate: { read: true, write: false },
    source: { read: true, write: false },
    evidence: { read: true, write: true },
    test_overlay: { read: false, write: false },
    publish: false,
    independent_proof: false,
  },
  accept: {
    candidate: { read: true, write: false },
    source: { read: true, write: false },
    evidence: { read: true, write: true },
    test_overlay: { read: false, write: false },
    publish: false,
    independent_proof: false,
  },
  orchestrator: {
    candidate: { read: true, write: false },
    source: { read: true, write: false },
    evidence: { read: true, write: true },
    test_overlay: { read: false, write: false },
    publish: false,
    independent_proof: false,
  },
  synthesizer: {
    candidate: { read: true, write: false },
    source: { read: true, write: false },
    evidence: { read: true, write: true },
    test_overlay: { read: false, write: false },
    publish: false,
    independent_proof: false,
  },
  requirements: {
    candidate: { read: true, write: false },
    source: { read: true, write: false },
    evidence: { read: true, write: true },
    test_overlay: { read: false, write: false },
    publish: false,
    independent_proof: false,
  },
  designer: {
    candidate: { read: true, write: false },
    source: { read: true, write: false },
    evidence: { read: true, write: true },
    test_overlay: { read: false, write: false },
    publish: false,
    independent_proof: false,
  },
}

let cachedSchema

export function loadNodeIsolationSchema() {
  if (!cachedSchema) cachedSchema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8'))
  return cachedSchema
}

export function validateDef(defName, data) {
  const root = loadNodeIsolationSchema()
  return validateRecord({ $ref: `#/definitions/${defName}`, definitions: root.definitions }, data)
}

export function resolveNodeCapabilities(profile, declared) {
  const base = NODE_ROLE_CAPABILITIES[profile]
  if (!base) throw new Error(`未知 profile 能力：${profile}`)
  if (!declared || typeof declared !== 'object') return clone(base)
  return tightenCapabilities(base, declared)
}

function tightenCapabilities(base, declared) {
  const out = clone(base)
  for (const zone of [ZONE.CANDIDATE, ZONE.SOURCE, ZONE.EVIDENCE, ZONE.TEST_OVERLAY]) {
    if (!declared[zone]) continue
    const d = declared[zone]
    if (d.read === false) out[zone].read = false
    if (d.write === false) out[zone].write = false
    if (d.write === true && !base[zone].write) throw new Error(`node_capabilities 不得放宽 ${zone}.write`)
    if (d.read === true && !base[zone].read) throw new Error(`node_capabilities 不得放宽 ${zone}.read`)
  }
  if (declared.publish === true && !base.publish) throw new Error('node_capabilities 不得放宽 publish')
  if (declared.independent_proof === true && !base.independent_proof) throw new Error('node_capabilities 不得放宽 independent_proof')
  if (declared.publish === false) out.publish = false
  if (declared.independent_proof === false) out.independent_proof = false
  return out
}

// macOS 参考配置：sandbox-exec 可用且能拒绝工作区外写入 → enforced；否则 unavailable。
export function probeIsolationCapability(options = {}) {
  const platform = options.platform || process.platform
  const force = options.force_guarantee
  if (force === ISOLATION_GUARANTEE.ENFORCED || force === ISOLATION_GUARANTEE.UNAVAILABLE) {
    return {
      guarantee: force,
      platform,
      backend: force === ISOLATION_GUARANTEE.ENFORCED ? 'forced' : 'forced-unavailable',
      evidence: { forced: true },
    }
  }
  if (platform !== 'darwin') {
    return { guarantee: ISOLATION_GUARANTEE.UNAVAILABLE, platform, backend: null, evidence: { reason: '非 macOS 参考配置' } }
  }
  try {
    execFileSync('which', ['sandbox-exec'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch {
    return { guarantee: ISOLATION_GUARANTEE.UNAVAILABLE, platform, backend: null, evidence: { reason: 'sandbox-exec 不可用' } }
  }
  const probeDir = options.probe_root || join(process.cwd(), '.scratch', 'ni-probe-' + Date.now())
  const outside = join(probeDir, 'outside')
  const inside = join(probeDir, 'inside')
  mkdirSync(outside, { recursive: true })
  mkdirSync(inside, { recursive: true })
  const targetOutside = join(outside, 'canary.txt')
  const profile = [
    '(version 1)',
    '(deny default)',
    '(allow file-write* (subpath "' + inside + '"))',
    '(allow file-read* (subpath "' + inside + '"))',
    '(allow process-exec (literal "/bin/echo"))',
    '(allow process-fork)',
  ].join('\n')
  let outsideBlocked = false
  let insideAllowed = false
  try {
    try {
      execFileSync('sandbox-exec', ['-p', profile, '/bin/echo', 'ok'], { encoding: 'utf-8', cwd: inside, stdio: ['ignore', 'pipe', 'pipe'] })
      insideAllowed = true
    } catch { /* inside probe failed */ }
    try {
      execFileSync('sandbox-exec', ['-p', profile, '/usr/bin/touch', targetOutside], { encoding: 'utf-8', cwd: inside, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      outsideBlocked = true
    }
    if (!outsideBlocked && existsSync(targetOutside)) outsideBlocked = false
    else if (!existsSync(targetOutside)) outsideBlocked = true
  } finally {
    if (!options.keep_probe_root) {
      try { rmSync(probeDir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  }
  if (insideAllowed && outsideBlocked) {
    return {
      guarantee: ISOLATION_GUARANTEE.ENFORCED,
      platform,
      backend: 'sandbox-exec',
      evidence: { insideAllowed, outsideBlocked },
    }
  }
  return {
    guarantee: ISOLATION_GUARANTEE.UNAVAILABLE,
    platform,
    backend: 'sandbox-exec',
    evidence: { insideAllowed, outsideBlocked, reason: '探针未同时满足区内外读写边界' },
  }
}

export function canIssueIndependentProof(guarantee, capabilities) {
  if (guarantee !== ISOLATION_GUARANTEE.ENFORCED) return { ok: false, reason: 'isolation_guarantee=unavailable，不能签发正式独立 Proof' }
  if (!capabilities || !capabilities.independent_proof) return { ok: false, reason: '节点不具备 independent_proof 能力' }
  return { ok: true }
}

export function prepareNodeContext(workspace, spec) {
  if (!workspace || typeof workspace !== 'object') throw new Error('prepareNodeContext 需要 workspace')
  const nodeId = requireText(spec.node_id, 'node_id')
  const profile = requireText(spec.profile, 'profile')
  const guarantee = spec.isolation_guarantee || ISOLATION_GUARANTEE.UNAVAILABLE
  const caps = resolveNodeCapabilities(profile, spec.node_capabilities)
  const wsPath = requireText(workspace.workspace_path, 'workspace_path')
  const sourcePath = workspace.source_path || null
  const evidencePath = join(wsPath, 'evidence', nodeId)
  const scratchPath = join(wsPath, 'workers', nodeId)
  const testOverlayPath = caps.test_overlay.read || caps.test_overlay.write ? join(wsPath, 'test-overlay') : null
  mkdirSync(evidencePath, { recursive: true })
  mkdirSync(scratchPath, { recursive: true })
  if (testOverlayPath) mkdirSync(testOverlayPath, { recursive: true })
  if (workspace.resources && workspace.resources.cache_dir) mkdirSync(workspace.resources.cache_dir, { recursive: true })

  const writableRoots = []
  if (caps.evidence.write) writableRoots.push(realpathSafe(evidencePath))
  if (caps.test_overlay.write && testOverlayPath) writableRoots.push(realpathSafe(testOverlayPath))
  if (caps.source.write && sourcePath) writableRoots.push(realpathSafe(sourcePath))
  if (caps.candidate.write && sourcePath) writableRoots.push(realpathSafe(sourcePath))
  if (workspace.resources) {
    if (workspace.resources.cache_dir && (profile === 'test' || profile === 'dev')) writableRoots.push(realpathSafe(workspace.resources.cache_dir))
    if (workspace.resources.tmpdir && (profile === 'test' || profile === 'dev')) writableRoots.push(realpathSafe(workspace.resources.tmpdir))
    if (workspace.resources.build_dir && (profile === 'test' || profile === 'dev')) writableRoots.push(realpathSafe(workspace.resources.build_dir))
  }
  writableRoots.push(realpathSafe(scratchPath))

  const agentCwd = caps.source.write && sourcePath ? sourcePath : evidencePath
  let candidateDigest = null
  if (sourcePath && existsSync(sourcePath)) {
    try { candidateDigest = digestTree(sourcePath) } catch { candidateDigest = null }
  }

  const ctx = {
    node_id: nodeId,
    profile,
    capabilities: caps,
    isolation_guarantee: guarantee,
    candidate_path: sourcePath || '',
    evidence_path: evidencePath,
    test_overlay_path: testOverlayPath || '',
    scratch_path: scratchPath,
    agent_cwd: agentCwd,
    writable_roots: [...new Set(writableRoots)],
    candidate_digest: candidateDigest || '',
  }
  const errors = validateDef('nodeExecutionContext', ctx)
  if (errors.length) throw new Error(`nodeExecutionContext 校验失败: ${errors.join('; ')}`)
  return ctx
}

export function classifyPath(ctx, absPath) {
  const p = resolve(absPath)
  const candidate = ctx.candidate_path ? resolve(ctx.candidate_path) : null
  const evidence = resolve(ctx.evidence_path)
  const scratch = resolve(ctx.scratch_path)
  const overlay = ctx.test_overlay_path && ctx.test_overlay_path.trim() ? resolve(ctx.test_overlay_path) : null
  if (candidate && isUnder(p, candidate)) return ZONE.CANDIDATE
  if (isUnder(p, evidence)) return ZONE.EVIDENCE
  if (overlay && isUnder(p, overlay)) return ZONE.TEST_OVERLAY
  if (isUnder(p, scratch)) return ZONE.EVIDENCE
  if (candidate && isUnder(p, candidate)) return ZONE.SOURCE
  return null
}

export function assertAccess(ctx, zone, operation) {
  const caps = ctx.capabilities[zone]
  if (!caps) throw new Error(`未知区域: ${zone}`)
  const ok = operation === 'read' ? caps.read : caps.write
  if (!ok) {
    const err = new Error(`${ctx.profile} 节点禁止 ${operation} ${zone}`)
    err.code = 'ACCESS_DENIED'
    err.zone = zone
    err.operation = operation
    throw err
  }
}

export function enforceWrite(ctx, absPath) {
  const zone = classifyPath(ctx, absPath)
  if (!zone) {
    const err = new Error(`路径不在授权区域内: ${absPath}`)
    err.code = 'PATH_OUT_OF_BOUNDS'
    throw err
  }
  assertAccess(ctx, zone, 'write')
  return { ok: true, zone }
}

export function enforceRead(ctx, absPath) {
  const zone = classifyPath(ctx, absPath)
  if (!zone) {
    const err = new Error(`路径不在授权区域内: ${absPath}`)
    err.code = 'PATH_OUT_OF_BOUNDS'
    throw err
  }
  assertAccess(ctx, zone, 'read')
  return { ok: true, zone }
}

export function writeInZone(ctx, zone, rel, content, workspacePath) {
  assertAccess(ctx, zone, 'write')
  const root = zoneRoot(ctx, zone)
  const rootReal = realpathSafe(root)
  const target = resolveInside(root, rel, workspacePath)
  const targetReal = existsSync(target) ? realpathSync(target) : target
  if (!isUnder(targetReal, rootReal)) {
    const err = new Error(`写入路径逃出 ${zone} 授权根`)
    err.code = 'PATH_OUT_OF_BOUNDS'
    throw err
  }
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
  return target
}

export function readInZone(ctx, zone, rel, workspacePath) {
  assertAccess(ctx, zone, 'read')
  const root = zoneRoot(ctx, zone)
  return readFileSync(resolveInside(root, rel, workspacePath), 'utf-8')
}

function zoneRoot(ctx, zone) {
  switch (zone) {
    case ZONE.CANDIDATE:
    case ZONE.SOURCE:
      if (!ctx.candidate_path) throw new Error('无 candidate/source 根')
      return ctx.candidate_path
    case ZONE.EVIDENCE:
      return ctx.evidence_path
    case ZONE.TEST_OVERLAY:
      if (!ctx.test_overlay_path) throw new Error('无 test_overlay 根')
      return ctx.test_overlay_path
    default:
      throw new Error(`未知 zone: ${zone}`)
  }
}

// 受控发布探针：无授权拒绝；授权通道仅允许指定目标（不使用真实凭据）。
export function publishProbe(spec) {
  const authorized = spec.authorized === true
  const target = String(spec.target || 'probe://local/publish')
  const action = String(spec.action || 'publish')
  if (!authorized) {
    return { ok: false, code: 'PUBLISH_DENIED', blocked: true, detail: '无发布授权', target, action, side_effect: false }
  }
  if (!/^probe:\/\/local\//.test(target)) {
    return { ok: false, code: 'PUBLISH_TARGET_DENIED', blocked: true, detail: '授权通道仅允许 probe://local/* 目标', target, action, side_effect: false }
  }
  return { ok: true, code: 'PUBLISH_ALLOWED', target, action, remote_ref: 'probe-local-' + sha256Hex(target + '|' + action).slice(0, 12), side_effect: true }
}

// 越权探针：文件工具与 shell 写入候选/源树。
export function runPrivilegeProbes(ctx, options = {}) {
  const results = []
  const candidate = ctx.candidate_path
  if (!candidate) return results
  const canaryRel = options.canary_rel || '.ni-canary.txt'
  const canaryAbs = join(candidate, canaryRel)
  const before = existsSync(canaryAbs) ? readFileSync(canaryAbs) : null
  if (before === null && options.seed_canary !== false) {
    writeFileSync(canaryAbs, 'canary-base\n')
  }
  const base = existsSync(canaryAbs) ? readFileSync(canaryAbs) : Buffer.from('')

  const attempts = [
    { probe: 'file_write_candidate', fn: () => writeInZone(ctx, ZONE.CANDIDATE, canaryRel, 'tampered\n', dirname(candidate)) },
    { probe: 'file_write_source', fn: () => writeInZone(ctx, ZONE.SOURCE, canaryRel, 'tampered\n', dirname(candidate)) },
    { probe: 'path_traversal', fn: () => writeInZone(ctx, ZONE.EVIDENCE, '../' + canaryRel, 'tampered\n', ctx.evidence_path) },
    { probe: 'symlink_bypass', fn: () => symlinkBypass(ctx, canaryAbs) },
  ]

  for (const a of attempts) {
    let allowed = false
    let error = null
    try {
      a.fn()
      allowed = true
    } catch (e) {
      error = String((e && e.message) || e)
    }
    const after = existsSync(canaryAbs) ? readFileSync(canaryAbs) : base
    const unchanged = Buffer.compare(before || base, after) === 0
    results.push({
      probe: a.probe,
      allowed,
      detail: allowed ? '写入未被拒绝' : (error || '拒绝'),
      error: allowed ? '应当拒绝但成功写入' : null,
      candidate_unchanged: unchanged,
    })
  }
  return results
}

function symlinkBypass(ctx, canaryAbs) {
  const linkRel = 'evil-link'
  const link = join(ctx.evidence_path, linkRel)
  if (existsSync(link)) rmSync(link)
  symlinkSync(canaryAbs, link)
  writeInZone(ctx, ZONE.EVIDENCE, linkRel, 'via-symlink\n', ctx.evidence_path)
}

export function verifyCandidateUnchanged(ctx, beforeDigest) {
  if (!ctx.candidate_path) return { ok: false, reason: '无 candidate_path' }
  const now = digestTree(ctx.candidate_path)
  return { ok: now === beforeDigest, before: beforeDigest, after: now }
}

function digestTree(root) {
  const files = []
  walk(root, '', (rel, st) => {
    if (st.isFile()) files.push({ rel, sha: sha256Hex(readFileSync(join(root, ...rel.split('/')))) })
  })
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  return sha256Hex(JSON.stringify(files))
}

function walk(root, prefix, visit) {
  const dir = prefix ? join(root, ...prefix.split('/')) : root
  for (const name of readdirSync(dir).sort()) {
    const rel = prefix ? `${prefix}/${name}` : name
    const st = lstatSync(join(root, ...rel.split('/')))
    visit(rel, st)
    if (st.isDirectory() && !st.isSymbolicLink()) walk(root, rel, visit)
  }
}

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex')
}

function isUnder(child, parent) {
  const c = resolve(child)
  const p = resolve(parent)
  return c === p || c.startsWith(p + sep)
}

function realpathSafe(p) {
  if (!existsSync(p)) return resolve(p)
  return realpathSync(p)
}

function resolveInside(root, rel, ancestor) {
  if (typeof rel !== 'string' || !rel.trim() || rel.includes('\0')) throw new Error('非法相对路径')
  if (isAbsolute(rel)) throw new Error('禁止绝对路径')
  const rootReal = existsSync(root) ? realpathSync(root) : resolve(root)
  const parts = rel.split(/[/\\]/)
  let cur = rootReal
  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') throw new Error('路径逃出允许根目录')
    const next = join(cur, part)
    if (!existsSync(next)) {
      const rest = parts.slice(parts.indexOf(part)).filter((p) => p && p !== '.')
      const candidate = rest.length ? join(cur, ...rest) : cur
      if (!isUnder(candidate, rootReal)) throw new Error('路径逃出允许根目录')
      return candidate
    }
    const st = lstatSync(next)
    if (st.isSymbolicLink()) {
      const real = realpathSync(next)
      if (!isUnder(real, rootReal)) throw new Error('路径逃出允许根目录')
      cur = real
    } else {
      cur = next
    }
  }
  return cur
}

function requireText(v, label) {
  if (typeof v !== 'string' || !/\S/.test(v)) throw new Error(`${label} 必须是非空字符串`)
  return v
}

function clone(v) {
  return structuredClone(v)
}
