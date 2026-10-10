#!/usr/bin/env node
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDeepSeekApiLoopbackProxy } from './node-provider-loopback-proxy.mjs'
import { buildStructuredOutputPatch, extractStructuredOutput } from './structured-output.mjs'

const MAX_INPUT_BYTES = 4 * 1024 * 1024
const require = createRequire(import.meta.url)
let workerInterrupted = false

export function validateNodeProviderPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('node provider request must be an object')
  const route = payload.route
  const context = payload.context
  if (typeof payload.sessionId !== 'string' || !/^vwf-node-[a-z0-9-]+$/i.test(payload.sessionId)) throw new Error('node provider session id is invalid')
  if (!route || typeof route !== 'object' || Array.isArray(route)) throw new Error('node provider route is missing')
  if (Object.hasOwn(route, 'token')) throw new Error('route token must not enter worker')
  if (route.isolationGuarantee !== 'enforced' || typeof route.logicalRunId !== 'string'
    || typeof route.nodeId !== 'string' || !route.nodeId || typeof route.profile !== 'string' || !route.profile
    || typeof route.provider !== 'string' || !route.provider || route.provider.startsWith('vwf-node-isolated:')
    || typeof route.model !== 'string' || !route.model) {
    throw new Error('node provider route is incomplete or not isolated')
  }
  if (!context || typeof context !== 'object' || Array.isArray(context)
    || context.isolation_guarantee !== 'enforced' || context.node_id !== route.nodeId || context.profile !== route.profile
    || typeof context.agent_cwd !== 'string' || !context.agent_cwd.startsWith('/')
    || typeof context.scratch_path !== 'string' || !context.scratch_path.startsWith('/')
    || !Array.isArray(context.writable_roots) || !context.capabilities || typeof context.capabilities !== 'object') {
    throw new Error('node provider context does not match route')
  }
  if (!Array.isArray(payload.prompt) || !payload.prompt.length) throw new Error('node provider prompt is missing')
  return payload
}

export function mapStopReason(events) {
  const end = Array.isArray(events) ? [...events].reverse().find((event) => event && event.type === 'turn/end') : null
  const kind = end && end.data && end.data.reason && end.data.reason.kind
  if (kind === 'completed' || kind === 'aborted' || kind === 'error' || kind === 'max-tokens') return kind
  if (kind === 'blocked') return 'refusal'
  return 'error'
}

export function encodeProtocolLine(value) {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (character) =>
    '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0')) + '\n'
}

function send(value) {
  process.stdout.write(encodeProtocolLine(value))
}

async function readRequest() {
  const chunks = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    bytes += chunk.length
    if (bytes > MAX_INPUT_BYTES) throw new Error('node provider request exceeded the input limit')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function resolveDshEntry() {
  const manifestPath = require.resolve('@deepseek-ai/dsh/package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin && manifest.bin.dsh
  if (typeof bin !== 'string' || !bin) throw new Error('@deepseek-ai/dsh manifest has no dsh CLI entry')
  return resolve(dirname(manifestPath), bin)
}

function isPathWithin(root, target) {
  const rel = relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}

function findInstalledPackageManifest(packageName, fromManifestPath) {
  const parts = packageName.split('/')
  if (parts.length > 2 || parts.some((part) => !part || part === '.' || part === '..')) return null
  if (parts.length === 2 && !parts[0].startsWith('@')) return null

  let directory = dirname(fromManifestPath)
  while (true) {
    const candidate = join(directory, 'node_modules', packageName, 'package.json')
    if (existsSync(candidate)) return realpathSync(candidate)
    const parent = dirname(directory)
    if (parent === directory) return null
    directory = parent
  }
}

// npm workspaces may hoist shared DSH dependencies to the repository-level
// node_modules. The isolated DSH process must be able to read those packages,
// but it should not gain access to the entire repository dependency tree.
export function resolveDshRuntimeRoots(dist) {
  const distRoot = realpathSync(dist)
  const nodeModules = realpathSync(join(dirname(distRoot), 'node_modules'))
  const roots = new Set([nodeModules, distRoot])
  const queue = [
    require.resolve('@deepseek-ai/dsh/package.json'),
    require.resolve('@deepseek-ai/dsh-tools/package.json'),
  ]
  const visited = new Set()

  while (queue.length) {
    const manifestPath = realpathSync(queue.shift())
    if (visited.has(manifestPath)) continue
    visited.add(manifestPath)

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const packageRoot = dirname(manifestPath)
    if (!isPathWithin(nodeModules, packageRoot)) roots.add(packageRoot)

    for (const dependencyName of [
      ...Object.keys(manifest.dependencies || {}),
      ...Object.keys(manifest.optionalDependencies || {}),
    ]) {
      const dependencyManifest = findInstalledPackageManifest(dependencyName, manifestPath)
      if (dependencyManifest) queue.push(dependencyManifest)
    }
  }

  return [...roots].sort()
}

function createSdkOptions(payload, files, loopbackPort) {
  const dist = dirname(fileURLToPath(import.meta.url))
  const runtimeRoots = resolveDshRuntimeRoots(dist)
  const launchSpec = {
    context: payload.context,
    dsh_entry: resolveDshEntry(),
    runtime_roots: runtimeRoots,
    runtime_files: files.patchPath ? [realpathSync(join(dirname(dist), 'package.json'))] : [],
    dsh_home: files.dshHome,
    loopback_port: loopbackPort,
  }
  const sdkOptions = {
    dshBin: join(dist, 'node-isolation-launcher.mjs'),
    profile: 'sdk',
    patches: files.patchPath ? [files.patchPath] : [],
    dshHome: files.dshHome,
    processCwd: payload.context.agent_cwd,
    cwd: payload.context.agent_cwd,
    provider: payload.route.provider,
    model: payload.route.model,
    env: {
      WFM_NODE_ISOLATION_LAUNCH_SPEC: JSON.stringify(launchSpec),
      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    },
  }
  if (typeof payload.agentOptions?.reasoningEffort === 'string') sdkOptions.reasoningEffort = payload.agentOptions.reasoningEffort
  if (Number.isSafeInteger(payload.agentOptions?.maxTokens) && payload.agentOptions.maxTokens > 0) {
    sdkOptions.maxTokens = payload.agentOptions.maxTokens
  }
  return sdkOptions
}

export function sanitizeWorkerDiagnostic(error, secret = process.env.DEEPSEEK_API_KEY) {
  let diagnostic = String(error && error.message || error || 'node provider worker failed')
  if (typeof secret === 'string' && secret) diagnostic = diagnostic.split(secret).join('[redacted]')
  return diagnostic.slice(0, 2000)
}

function errorResult(error, stopReason = 'error') {
  return {
    output: [],
    diagnostic: sanitizeWorkerDiagnostic(error),
    stopReason,
  }
}

async function execute(payload, onAccepted) {
  validateNodeProviderPayload(payload)
  if (process.platform !== 'darwin') throw new Error('node provider worker requires macOS Seatbelt')
  if (typeof process.env.DEEPSEEK_API_KEY !== 'string' || !process.env.DEEPSEEK_API_KEY.trim()) {
    throw new Error('DeepSeek API credential is unavailable; isolated DSH was not started')
  }
  const dist = dirname(fileURLToPath(import.meta.url))
  const launcher = join(dist, 'node-isolation-launcher.mjs')
  const outputPlugin = join(dist, 'structured-output.mjs')
  if (!existsSync(launcher)) throw new Error('packaged node isolation launcher is missing')
  if (payload.outputSchema !== undefined && !existsSync(outputPlugin)) throw new Error('packaged structured-output plugin is missing')

  const proxy = await createDeepSeekApiLoopbackProxy()
  const suffix = randomUUID().replaceAll('-', '')
  let dshHome = null
  let patchPath = null
  let harness
  let closeTask
  let interrupted = false
  const close = () => {
    if (!harness) return Promise.resolve()
    if (!closeTask) closeTask = harness.close()
    return closeTask
  }
  const onSignal = () => {
    interrupted = true
    workerInterrupted = true
    void close().catch(() => {})
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  try {
    dshHome = mkdtempSync(join(payload.context.scratch_path, 'vwf-dsh-home-'))
    if (payload.outputSchema !== undefined) {
      patchPath = join(payload.context.scratch_path, '.vwf-node-profile-' + suffix + '.yml')
      writeFileSync(patchPath, buildStructuredOutputPatch(outputPlugin, payload.outputSchema), { flag: 'wx', mode: 0o600 })
    }
    if (interrupted) throw new Error('node provider worker was interrupted before DSH startup')
    harness = new DeepSeekHarness(createSdkOptions(payload, { dshHome, patchPath }, proxy.port))
    const session = harness.session(payload.sessionId)
    const result = await session.run(payload.prompt, {
      onNotification() {
        onAccepted()
      },
    })
    const stopReason = mapStopReason(result.events)
    const structured = payload.outputSchema === undefined
      ? undefined
      : extractStructuredOutput(result.events, payload.outputSchema)
    if (payload.outputSchema !== undefined && stopReason === 'completed' && structured === undefined) {
      return errorResult('DSH turn completed without a validated structured_output result')
    }
    if (interrupted) return errorResult('node provider worker was interrupted', 'aborted')
    const output = typeof result.finalResponse === 'string' && result.finalResponse.length
      ? [{ type: 'text', text: result.finalResponse }]
      : []
    return {
      output,
      ...(structured === undefined ? {} : { structured }),
      ...(stopReason === 'error' ? { diagnostic: 'DSH node turn ended with an error' } : {}),
      stopReason,
    }
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    try { await close() } finally {
      try { await proxy.close() } finally {
        if (patchPath) rmSync(patchPath, { force: true })
        if (dshHome) rmSync(dshHome, { recursive: true, force: true })
      }
    }
  }
}

async function main() {
  let accepted = false
  workerInterrupted = false
  try {
    const payload = validateNodeProviderPayload(await readRequest())
    const result = await execute(payload, () => {
      if (accepted) return
      accepted = true
      send({ type: 'accepted' })
    })
    if (!accepted) throw new Error('DSH SDK run completed without confirming prompt acceptance')
    send({ type: 'result', result })
  } catch (error) {
    if (accepted) send({ type: 'result', result: errorResult(error, workerInterrupted ? 'aborted' : 'error') })
    else {
      send({ type: 'error', message: sanitizeWorkerDiagnostic(error) })
      process.exitCode = 78
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main()
