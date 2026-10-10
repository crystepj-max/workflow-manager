#!/usr/bin/env node
// LOC-041 节点隔离内核：node_capabilities、isolation_guarantee 探测与执行适配。
// 候选位于节点可写根之外；证据/测试覆盖层/缓存有独立写区；发布走受控通道。
// 强制边界依赖宿主文件/进程沙箱（macOS sandbox-exec 参考配置），chmod/提示词不算证据。

import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync,
  realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateRecord } from './cwf-validate.mjs'

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
const BUNDLED_SCHEMA_PATH = join(MODULE_DIR, 'node-isolation-schema.json')
const SOURCE_SCHEMA_PATH = join(MODULE_DIR, '..', 'docs', 'design', 'node-isolation', 'schema.json')
const SCHEMA_PATH = existsSync(BUNDLED_SCHEMA_PATH) ? BUNDLED_SCHEMA_PATH : SOURCE_SCHEMA_PATH

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

// FIX-235 的旧探针只限制写入，不能证明节点文件工具或 shell 的完整边界。
// 该入口现与正式节点共用默认拒绝策略，确保机器能力判定覆盖读、写和进程启动。
export function buildProbeProfile(insideRealPath) {
  const ctx = {
    profile: 'review',
    isolation_guarantee: ISOLATION_GUARANTEE.ENFORCED,
    candidate_path: '',
    evidence_path: insideRealPath,
    scratch_path: insideRealPath,
    test_overlay_path: '',
    capabilities: {
      candidate: { read: true, write: false },
      source: { read: true, write: false },
      evidence: { read: true, write: true },
      test_overlay: { read: false, write: false },
    },
    writable_roots: [insideRealPath],
  }
  return buildNodeExecutionProfile(ctx, { executable_paths: [process.execPath] })
}

// 节点进程使用默认拒绝的 Seatbelt 策略；只开放节点能力对应的工作区、
// 隔离 DSH Home、运行时文件和单个 loopback 模型代理端口。
export function buildNodeExecutionProfile(ctx, options = {}) {
  if (!ctx || typeof ctx !== 'object') throw new Error('buildNodeExecutionProfile 需要节点上下文')
  if (ctx.isolation_guarantee !== ISOLATION_GUARANTEE.ENFORCED) throw new Error('节点隔离未达到 enforced，拒绝生成执行策略')
  if (process.platform !== 'darwin') throw new Error('Seatbelt 节点执行策略仅支持 macOS')
  if (typeof ctx.profile !== 'string' || !ctx.profile.trim()) throw new Error('节点上下文缺少 profile 角色')
  if (!ctx.capabilities || typeof ctx.capabilities !== 'object' || Array.isArray(ctx.capabilities)) {
    throw new Error('节点上下文缺少 capabilities 能力表')
  }
  for (const zone of [ZONE.CANDIDATE, ZONE.SOURCE, ZONE.EVIDENCE, ZONE.TEST_OVERLAY]) {
    const capability = ctx.capabilities[zone]
    if (!capability || typeof capability !== 'object'
      || typeof capability.read !== 'boolean' || typeof capability.write !== 'boolean') {
      throw new Error(`节点上下文缺少 capabilities.${zone}.read/write 布尔值`)
    }
  }
  if (!Array.isArray(ctx.writable_roots)) throw new Error('节点上下文缺少 writable_roots 写入目录清单')
  if (!ctx.scratch_path || typeof ctx.scratch_path !== 'string') throw new Error('节点上下文缺少 scratch_path')
  for (const key of ['extra_read_roots', 'extra_read_files', 'extra_write_roots', 'executable_paths']) {
    if (options[key] !== undefined && !Array.isArray(options[key])) throw new Error(`${key} 必须是数组`)
  }

  const dyldSupport = '/System/Library/Sandbox/Profiles/dyld-support.sb'
  if (!existsSync(dyldSupport)) throw new Error('macOS dyld-support.sb 不可用')

  const caps = resolveNodeCapabilities(ctx.profile, ctx.capabilities)
  const readRoots = []
  if (ctx.candidate_path && (caps.candidate?.read || caps.source?.read)) readRoots.push(ctx.candidate_path)
  if (ctx.evidence_path && caps.evidence.read) readRoots.push(ctx.evidence_path)
  if (ctx.scratch_path) readRoots.push(ctx.scratch_path)
  if (ctx.test_overlay_path && caps.test_overlay.read) readRoots.push(ctx.test_overlay_path)
  readRoots.push(...(options.extra_read_roots || []))

  const writeRoots = [
    ...ctx.writable_roots,
    ...(options.extra_write_roots || []),
  ]
  const executables = options.executable_paths || []
  const normalizedReadRoots = normalizeProfileDirectories(readRoots, 'read root')
  const normalizedReadFiles = normalizeProfileFiles(options.extra_read_files || [], 'read file')
  const normalizedWriteRoots = normalizeProfileDirectories(writeRoots, 'write root')
  const normalizedExecutables = normalizeProfileFiles(executables, 'executable')
  assertRootsRespectCapabilities(ctx, caps, normalizedReadRoots, normalizedWriteRoots)
  assertFilesRespectCapabilities(ctx, caps, normalizedReadFiles)

  const rules = [
    '(version 1)',
    '(deny default)',
    `(import ${sbplString(dyldSupport)})`,
    '(allow process-exec process-fork)',
    '(allow file-read* (subpath "/System") (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/private/etc") (subpath "/dev"))',
    ...normalizedReadRoots.map((root) => `(allow file-read* (subpath ${sbplString(root)}))`),
    ...normalizedReadFiles.map((file) => `(allow file-read* (literal ${sbplString(file)}))`),
    '(allow file-read-metadata)',
    '(allow file-map-executable (subpath "/System") (subpath "/usr/lib"))',
    ...normalizedExecutables.map((file) => `(allow file-read* file-map-executable (literal ${sbplString(file)}))`),
    '(allow sysctl-read)',
    '(allow signal (target self))',
    ...normalizedWriteRoots.map((root) => `(allow file-write* (subpath ${sbplString(root)}))`),
  ]

  if (options.loopback_port !== undefined && options.loopback_port !== null) {
    const port = Number(options.loopback_port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('loopback_port 必须是 1–65535 的整数')
    rules.push(`(allow network-outbound (remote ip "localhost:${port}"))`)
  }

  return rules.join('\n')
}

// DSH SDK 可把自定义 dshBin 指向 WFM 启动垫片。垫片用此规格在真实 DSH
// 入口外包一层默认拒绝策略，并给实际 DSH 重建无用户凭据的环境。
export function buildSandboxedDshLaunchSpec(ctx, options = {}) {
  if (process.platform !== 'darwin') throw new Error('sandboxed DSH 启动仅支持 macOS Seatbelt')
  if (!ctx || typeof ctx !== 'object') throw new Error('sandboxed DSH 启动需要节点上下文')
  const dshEntry = requireText(options.dsh_entry, 'dsh_entry')
  const runtimeRoots = options.runtime_roots
  if (!Array.isArray(runtimeRoots) || runtimeRoots.length === 0) throw new Error('runtime_roots 必须是非空目录数组')
  if (runtimeRoots.some((value) => typeof value !== 'string' || !value.trim())) {
    throw new Error('runtime_roots 只能包含非空目录路径')
  }
  const runtimeFiles = options.runtime_files === undefined ? [] : options.runtime_files
  if (!Array.isArray(runtimeFiles) || runtimeFiles.some((value) => typeof value !== 'string' || !value.trim())) {
    throw new Error('runtime_files 须为绝对路径数组')
  }
  const dshHome = requireText(options.dsh_home, 'dsh_home')
  const argv = options.argv === undefined ? [] : options.argv
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== 'string' || value.includes('\0'))) {
    throw new Error('argv 必须是无 NUL 字符的字符串数组')
  }

  const runtimeRootPaths = normalizeProfileDirectories(runtimeRoots, 'DSH runtime root')
  const runtimeFilePaths = normalizeProfileFiles(runtimeFiles, 'DSH runtime file')
  const entryPath = normalizeProfileFiles([dshEntry], 'DSH entry')[0]
  if (!runtimeRootPaths.some((root) => isUnder(entryPath, root))) {
    throw new Error('dsh_entry 必须位于声明的 runtime_roots 中')
  }

  const scratchPath = normalizeProfileDirectories([ctx.scratch_path], 'node scratch root')[0]
  if (!Array.isArray(ctx.writable_roots)) throw new Error('节点上下文缺少 writable_roots 写入目录清单')
  const nodeWritableRoots = normalizeProfileDirectories(ctx.writable_roots, 'node writable root')
  if (runtimeRootPaths.some((runtimeRoot) => nodeWritableRoots.some((writeRoot) => rootsOverlap(runtimeRoot, writeRoot)))) {
    throw new Error('DSH runtime root 不得与节点 writable_roots 重叠')
  }
  if (runtimeFilePaths.some((runtimeFile) => nodeWritableRoots.some((writeRoot) => isUnder(runtimeFile, writeRoot)))) {
    throw new Error('DSH runtime file 不得位于节点 writable_roots')
  }
  const homeInput = resolve(dshHome)
  if (!existsSync(homeInput) || lstatSync(homeInput).isSymbolicLink() || !lstatSync(homeInput).isDirectory()) {
    throw new Error('dsh_home 必须是已存在且非符号链接的空目录')
  }
  const homePath = realpathSync(homeInput)
  if (!isUnder(homePath, scratchPath) || homePath === scratchPath) {
    throw new Error('dsh_home 必须位于该节点 scratch_path 的子目录中')
  }
  if (readdirSync(homePath).length > 0) throw new Error('dsh_home 必须为空，拒绝复用可能含凭据的配置')

  const nodeExecutable = normalizeProfileFiles([process.execPath], 'Node executable')[0]
  const cwdInput = requireText(ctx.agent_cwd, 'agent_cwd')
  const cwd = normalizeProfileDirectories([cwdInput], 'node cwd')[0]
  const caps = resolveNodeCapabilities(ctx.profile, ctx.capabilities)
  const readableRoots = []
  if (ctx.candidate_path && (caps.candidate.read || caps.source.read)) readableRoots.push(ctx.candidate_path)
  if (ctx.evidence_path && caps.evidence.read) readableRoots.push(ctx.evidence_path)
  if (ctx.scratch_path) readableRoots.push(ctx.scratch_path)
  if (ctx.test_overlay_path && caps.test_overlay.read) readableRoots.push(ctx.test_overlay_path)
  const normalizedReadableRoots = normalizeProfileDirectories(readableRoots, 'node readable root')
  if (!normalizedReadableRoots.some((root) => isUnder(cwd, root))) {
    throw new Error('agent_cwd 不在该节点可读区域中')
  }

  const sandboxExec = '/usr/bin/sandbox-exec'
  if (!existsSync(sandboxExec) || !lstatSync(sandboxExec).isFile()) throw new Error('系统 sandbox-exec 不可用')
  const profile = buildNodeExecutionProfile(ctx, {
    extra_read_roots: runtimeRootPaths,
    extra_read_files: runtimeFilePaths,
    executable_paths: [nodeExecutable],
    loopback_port: options.loopback_port,
  })
  const localProxy = options.loopback_port === undefined || options.loopback_port === null
    ? null
    : `http://127.0.0.1:${Number(options.loopback_port)}`
  const proxyEnv = localProxy ? {
    HTTP_PROXY: localProxy,
    HTTPS_PROXY: localProxy,
    http_proxy: localProxy,
    https_proxy: localProxy,
    ALL_PROXY: undefined,
    all_proxy: undefined,
    NO_PROXY: 'localhost,127.0.0.1,::1',
    no_proxy: 'localhost,127.0.0.1,::1',
  } : {}

  return {
    command: sandboxExec,
    args: ['-p', profile, nodeExecutable, entryPath, ...argv],
    cwd,
    env: {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: homePath,
      DSH_HOME: homePath,
      TMPDIR: scratchPath,
      LANG: 'C',
      LC_ALL: 'C',
      ...(typeof options.api_key === 'string' && options.api_key ? { DEEPSEEK_API_KEY: options.api_key } : {}),
      ...proxyEnv,
    },
    profile,
  }
}

function normalizeProfileDirectories(paths, label) {
  if (!Array.isArray(paths)) throw new Error(`${label} 必须是路径数组`)
  const normalized = []
  for (const value of paths) {
    if (typeof value !== 'string' || !value.trim()) continue
    if (!isAbsolute(value)) throw new Error(`${label} 必须是绝对路径: ${value}`)
    if (!existsSync(value)) throw new Error(`${label} 不存在: ${value}`)
    const real = realpathSync(value)
    if (!lstatSync(real).isDirectory()) throw new Error(`${label} 必须是目录: ${value}`)
    if (real === sep) throw new Error(`${label} 不得是文件系统根目录`)
    if (!normalized.includes(real)) normalized.push(real)
  }
  return normalized
}

function normalizeProfileFiles(paths, label) {
  if (!Array.isArray(paths)) throw new Error(`${label} 必须是路径数组`)
  const normalized = []
  for (const value of paths) {
    if (typeof value !== 'string' || !value.trim()) continue
    if (!isAbsolute(value)) throw new Error(`${label} 必须是绝对路径: ${value}`)
    if (!existsSync(value)) throw new Error(`${label} 不存在: ${value}`)
    const real = realpathSync(value)
    if (!lstatSync(real).isFile()) throw new Error(`${label} 必须是文件: ${value}`)
    if (!normalized.includes(real)) normalized.push(real)
  }
  return normalized
}

function assertRootsRespectCapabilities(ctx, caps, readRoots, writeRoots) {
  const zones = [
    {
      name: '候选/源',
      path: ctx.candidate_path,
      read: caps.candidate.read || caps.source.read,
      write: caps.candidate.write || caps.source.write,
    },
    { name: '证据', path: ctx.evidence_path, read: caps.evidence.read, write: caps.evidence.write },
    { name: '测试覆盖层', path: ctx.test_overlay_path, read: caps.test_overlay.read, write: caps.test_overlay.write },
  ].filter((zone) => typeof zone.path === 'string' && zone.path.trim())

  for (const zone of zones) {
    const zoneRoot = existsSync(zone.path) ? realpathSync(zone.path) : resolve(zone.path)
    if (!zone.read && readRoots.some((root) => rootsOverlap(root, zoneRoot))) {
      throw new Error(`read root 绕过 ${zone.name}只读能力`)
    }
    if (!zone.write && writeRoots.some((root) => rootsOverlap(root, zoneRoot))) {
      throw new Error(`writable root 绕过 ${zone.name}只读能力`)
    }
  }
}

function assertFilesRespectCapabilities(ctx, caps, readFiles) {
  const zones = [
    { name: '候选/源', path: ctx.candidate_path, read: caps.candidate.read || caps.source.read },
    { name: '证据', path: ctx.evidence_path, read: caps.evidence.read },
    { name: '测试覆盖层', path: ctx.test_overlay_path, read: caps.test_overlay.read },
  ].filter((zone) => typeof zone.path === 'string' && zone.path.trim())

  for (const zone of zones) {
    const zoneRoot = existsSync(zone.path) ? realpathSync(zone.path) : resolve(zone.path)
    if (!zone.read && readFiles.some((file) => isUnder(file, zoneRoot))) {
      throw new Error(`read file 绕过 ${zone.name}只读能力`)
    }
  }
}

function rootsOverlap(left, right) {
  return isUnder(left, right) || isUnder(right, left)
}

function sbplString(value) {
  if (/[\0\r\n]/.test(value)) throw new Error('Seatbelt 路径不能含控制字符')
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

function shellQuote(value) {
  return "'" + value.replace(/'/g, "'\\''") + "'"
}

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
  try {
    mkdirSync(probeDir, { recursive: true })
    // 策略按真实路径匹配；先创建探针目录，再解析软链路径。
    const probeDirReal = realpathSync(probeDir)
    const candidate = join(probeDirReal, 'candidate')
    const evidence = join(probeDirReal, 'evidence')
    const outside = join(probeDirReal, 'outside')
    mkdirSync(candidate, { recursive: true })
    mkdirSync(evidence, { recursive: true })
    mkdirSync(outside, { recursive: true })
    const sourceFile = join(candidate, 'source.txt')
    const evidenceFile = join(evidence, 'node-proof.txt')
    const shellEvidenceFile = join(evidence, 'shell-proof.txt')
    const outsideReadFile = join(outside, 'read-canary.txt')
    const outsideWriteFile = join(outside, 'write-canary.txt')
    const symlinkFile = join(evidence, 'source-link.txt')
    writeFileSync(sourceFile, 'source-base\n')
    writeFileSync(outsideReadFile, 'outside-base\n')
    symlinkSync(sourceFile, symlinkFile)
    const ctx = {
      profile: 'review',
      isolation_guarantee: ISOLATION_GUARANTEE.ENFORCED,
      candidate_path: candidate,
      evidence_path: evidence,
      scratch_path: evidence,
      test_overlay_path: '',
      capabilities: {
        candidate: { read: true, write: false },
        source: { read: true, write: false },
        evidence: { read: true, write: true },
        test_overlay: { read: false, write: false },
      },
      writable_roots: [evidence],
    }
    let insideAllowed = false
    let insideWrite = false
    let outsideReadBlocked = false
    let outsideBlocked = false
    let shellWriteEnforced = false
    let symlinkWriteBlocked = false
    try {
      const profile = buildNodeExecutionProfile(ctx, { executable_paths: [process.execPath] })
      const nodeScript = `const fs=require('node:fs'); const read=p=>{try{return fs.readFileSync(p,'utf8').trim()}catch(e){return e.code}}; const write=p=>{try{fs.writeFileSync(p,'tampered\\n');return 'written'}catch(e){return e.code}}; console.log(JSON.stringify({source:read(${JSON.stringify(sourceFile)}),outsideRead:read(${JSON.stringify(outsideReadFile)}),insideWrite:write(${JSON.stringify(evidenceFile)}),sourceWrite:write(${JSON.stringify(sourceFile)}),outsideWrite:write(${JSON.stringify(outsideWriteFile)}),symlinkWrite:write(${JSON.stringify(symlinkFile)})}))`
      const nodeRun = spawnSync('sandbox-exec', ['-p', profile, process.execPath, '-e', nodeScript], { encoding: 'utf-8', timeout: 5000 })
      let nodeResult = null
      if (nodeRun.status === 0 && nodeRun.stdout) {
        try { nodeResult = JSON.parse(nodeRun.stdout.trim()) } catch { /* 探针输出不合法，判 unavailable */ }
      }
      insideAllowed = !!nodeResult
      insideWrite = !!nodeResult && nodeResult.insideWrite === 'written' && existsSync(evidenceFile)
      outsideReadBlocked = !!nodeResult && nodeResult.outsideRead === 'EPERM'
      outsideBlocked = !!nodeResult && nodeResult.outsideWrite === 'EPERM' && !existsSync(outsideWriteFile)
      symlinkWriteBlocked = !!nodeResult && nodeResult.symlinkWrite === 'EPERM'

      const shellScript = [
        `printf 'tampered\\n' > ${shellQuote(sourceFile)}`,
        `printf 'shell-proof\\n' > ${shellQuote(shellEvidenceFile)}`,
        `printf 'tampered\\n' > ${shellQuote(outsideWriteFile)}`,
        `printf 'tampered\\n' > ${shellQuote(symlinkFile)}`,
      ].join('; ')
      const shellRun = spawnSync('sandbox-exec', ['-p', profile, '/bin/sh', '-c', shellScript], { encoding: 'utf-8', timeout: 5000 })
      const sourceUnchanged = readFileSync(sourceFile, 'utf-8') === 'source-base\n'
      shellWriteEnforced = !shellRun.error && shellRun.signal === null && sourceUnchanged
        && existsSync(shellEvidenceFile) && !existsSync(outsideWriteFile)
      symlinkWriteBlocked = symlinkWriteBlocked && sourceUnchanged
    } finally {
      if (!options.keep_probe_root) {
        try { rmSync(probeDir, { recursive: true, force: true }) } catch { /* ignore */ }
      }
    }
    const probeEvidence = { insideAllowed, insideWrite, outsideReadBlocked, outsideBlocked, shellWriteEnforced, symlinkWriteBlocked }
    if (Object.values(probeEvidence).every((value) => value === true)) {
      return {
        guarantee: ISOLATION_GUARANTEE.ENFORCED,
        platform,
        backend: 'sandbox-exec',
        evidence: probeEvidence,
      }
    }
    return {
      guarantee: ISOLATION_GUARANTEE.UNAVAILABLE,
      platform,
      backend: 'sandbox-exec',
      evidence: { ...probeEvidence, reason: '探针未同时满足：区内进程/合法写入成功，区外读取/写入、shell 与符号链接写入均被拒' },
    }
  } catch (error) {
    if (!options.keep_probe_root) {
      try { rmSync(probeDir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
    return {
      guarantee: ISOLATION_GUARANTEE.UNAVAILABLE,
      platform,
      backend: 'sandbox-exec',
      evidence: { reason: `探针目录或隔离策略执行失败：${error?.code || error?.message || '未知错误'}` },
    }
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
