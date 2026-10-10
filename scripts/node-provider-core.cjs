'use strict'

const ROUTE_PREFIX = 'vwf-node-isolated:'
const TOKEN_PATTERN = /^[a-f0-9]{64}$/
const MAX_FANOUT_ITEMS = 1000

function createRouteRegistry(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now
  const runs = new Map()
  const routes = new Map()
  const runtimes = new Map()

  function pruneExpired() {
    const at = now()
    for (const [runId, run] of runs) {
      if (run.expiresAt > at) continue
      for (const token of run.tokens) routes.delete(token)
      runs.delete(runId)
    }
  }

  function registerRun(runId, issued, runtime) {
    if (typeof runId !== 'string' || !runId.trim()) throw new Error('node routes require a logical run id')
    if (!issued || issued.ok !== true || !Array.isArray(issued.routes) || !issued.tokens) {
      throw new Error('node routes could not be registered')
    }
    const expiresAt = Number(issued.expiresAt)
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now()) throw new Error('node routes have invalid expiry')
    if (issued.routes.length > MAX_FANOUT_ITEMS) throw new Error('node route count exceeds the runtime limit')

    const nextRoutes = new Map()
    for (const route of issued.routes) {
      if (!route || route.logicalRunId !== runId || route.isolationGuarantee !== 'enforced') {
        throw new Error('node routes are not bound to this isolated run')
      }
      if (typeof route.token !== 'string' || !TOKEN_PATTERN.test(route.token) || nextRoutes.has(route.token)) {
        throw new Error('node routes contain an invalid token')
      }
      if (typeof route.nodeId !== 'string' || !route.nodeId || typeof route.profile !== 'string' || !route.profile) {
        throw new Error('node routes contain incomplete node metadata')
      }
      nextRoutes.set(route.token, route)
    }

    const tokenSet = new Set(nextRoutes.keys())
    const tokenTables = [issued.tokens.nodes, issued.tokens.attribution]
    for (const table of tokenTables) {
      if (!table || typeof table !== 'object' || Array.isArray(table)) throw new Error('node route token table is invalid')
      for (const token of Object.values(table)) {
        if (typeof token !== 'string' || !tokenSet.has(token)) throw new Error('node route token table is inconsistent')
      }
    }

    clearRun(runId)
    for (const [token, route] of nextRoutes) routes.set(token, route)
    runs.set(runId, { expiresAt, tokens: tokenSet })
    if (runtime && typeof runtime === 'object') runtimes.set(runId, runtime)
    return issued.tokens
  }

  function clearRun(runId) {
    const run = runs.get(runId)
    if (!run) return false
    for (const token of run.tokens) routes.delete(token)
    runs.delete(runId)
    runtimes.delete(runId)
    return true
  }

  function runtimeFor(route) {
    return route && runtimes.get(route.logicalRunId)
  }

  function startWorkflow(engine, request, runId) {
    try {
      const run = engine.start(request)
      if (run && run.result && typeof run.result.finally === 'function') {
        run.result.finally(() => clearRun(runId)).catch(() => {})
      }
      return run
    } catch (error) {
      clearRun(runId)
      throw error
    }
  }

  function resolve(provider, model) {
    pruneExpired()
    if (typeof provider !== 'string' || !provider.startsWith(ROUTE_PREFIX)) throw new Error('isolated node route rejected')
    const match = provider.slice(ROUTE_PREFIX.length).match(/^([a-f0-9]{64})(?::item:([1-9][0-9]{0,2}|1000)|:attribution)?$/)
    if (!match) throw new Error('isolated node route rejected')
    const token = match[1]
    const itemNo = provider.endsWith(':attribution') ? null : (match[2] ? Number(match[2]) : null)
    if (itemNo !== null && (!Number.isSafeInteger(itemNo) || itemNo > MAX_FANOUT_ITEMS)) {
      throw new Error('isolated node route rejected')
    }
    const route = routes.get(token)
    if (!route || route.isolationGuarantee !== 'enforced' || typeof route.provider !== 'string' || !route.provider
      || typeof route.model !== 'string' || !route.model || model !== route.model) {
      throw new Error('isolated node route rejected')
    }
    const kind = provider.endsWith(':attribution') ? 'attribution' : (itemNo === null ? 'node' : 'item')
    const folderId = kind === 'attribution'
      ? route.attributionFolderId
      : (kind === 'item' ? route.nodeFolderId + '-item-' + itemNo : route.nodeFolderId)
    if (typeof folderId !== 'string' || !/^route-[a-z0-9-]+$/.test(folderId)) throw new Error('isolated node route rejected')
    const { token: _token, ...safeRoute } = route
    return { route: safeRoute, kind, itemNo, folderId }
  }

  return { registerRun, clearRun, resolve, runtimeFor, pruneExpired, startWorkflow }
}

const activeRoutes = createRouteRegistry()
let nextRunId = 0

async function issueRun(runId, dsl, modelOverrides, workspace, isolation, homeDirs, hostCall) {
  const nodes = dsl && Array.isArray(dsl.nodes) ? dsl.nodes.filter((node) => node && !node.mechanical) : []
  if (!nodes.length) return null
  if (!workspace || !isolation || isolation.guarantee !== 'enforced') {
    throw new Error('隔离节点路由签发失败：workspace isolation 不可用')
  }
  try {
    const dirs = await homeDirs()
    if (!dirs || typeof dirs.workspaces !== 'string' || !dirs.workspaces.startsWith('/')) throw new Error('workspace root unavailable')
    const issued = await hostCall('createProviderRoutes', {
      logical_run_id: runId, work_root: dirs.workspaces, isolation_guarantee: 'enforced', dsl, model_overrides: modelOverrides,
    })
    if (!issued || issued.ok !== true) throw new Error('route issue failed')
    const nodeTokens = issued.tokens && issued.tokens.nodes
    const attributionTokens = issued.tokens && issued.tokens.attribution
    if (!nodeTokens || !attributionTokens || nodes.some((node) => (
      typeof nodeTokens[node.id] !== 'string' || !nodeTokens[node.id]
      || typeof attributionTokens[node.id] !== 'string' || !attributionTokens[node.id]
    ))) throw new Error('route issue incomplete')
    const runtime = {
      async prepareNode(route) {
        const result = await hostCall('prepareNode', {
          work_root: route.workRoot,
          logical_run_id: route.logicalRunId,
          node_id: route.nodeId,
          profile: route.profile,
          node_capabilities: route.nodeCapabilities,
          isolation_guarantee: route.isolationGuarantee,
        })
        if (!result || result.ok !== true || !result.context) throw new Error('节点隔离上下文准备失败')
        return result.context
      },
      startWorker(payload, options) { return hostCall('spawnProviderWorker', payload, options) },
    }
    return activeRoutes.registerRun(runId, issued, runtime)
  } catch (error) {
    const detail = safeDiagnostic(error && error.message ? error.message : error)
    throw new Error('隔离节点路由签发失败：' + detail)
  }
}

function cloneJson(value, label) {
  try {
    const encoded = JSON.stringify(value)
    if (encoded === undefined) throw new Error('unsupported value')
    return JSON.parse(encoded)
  } catch {
    throw new Error(`节点 ${label} 不能安全传给隔离 worker`)
  }
}

function safeDiagnostic(value) {
  return String(value || '节点 worker 运行失败')
    .replace(/[a-f0-9]{64}/gi, '[redacted]')
    .replace(/(authorization|api[_-]?key|token)(\s*[:=]\s*)[^\s,;}]+/gi, '$1$2[redacted]')
    .slice(0, 2000)
}

function errorResult(diagnostic) {
  return { output: [], diagnostic: safeDiagnostic(diagnostic), stopReason: 'error' }
}

function normalizeResult(value, requiresStructured) {
  const stopReasons = ['completed', 'aborted', 'error', 'max-tokens', 'refusal']
  if (!value || typeof value !== 'object' || !Array.isArray(value.output) || !stopReasons.includes(value.stopReason)) {
    return errorResult('节点 worker 返回了无效结果')
  }
  if (requiresStructured && value.stopReason === 'completed' && value.structured === undefined) {
    return errorResult('节点没有提交有效的结构化结果')
  }
  try {
    return {
      output: cloneJson(value.output, '输出'),
      ...(value.structured === undefined ? {} : { structured: cloneJson(value.structured, '结构化结果') }),
      ...(typeof value.diagnostic === 'string' ? { diagnostic: safeDiagnostic(value.diagnostic) } : {}),
      stopReason: value.stopReason,
    }
  } catch (error) {
    return errorResult(error.message)
  }
}

async function start(request, dependencies = {}) {
  const options = request && request.agentOptions || {}
  const registry = dependencies.routes || activeRoutes
  const resolved = registry.resolve(options.provider, options.model)
  const runtime = dependencies.runtime || (typeof dependencies.startWorker === 'function' ? dependencies : registry.runtimeFor(resolved.route))
  if (!runtime || typeof runtime.prepareNode !== 'function' || typeof runtime.startWorker !== 'function') {
    throw new Error('节点 worker 启动能力未配置；已拒绝子进程启动和模型请求')
  }
  if (typeof request.prompt === 'undefined') throw new Error('节点请求缺少 prompt')
  if (request.signal && request.signal.aborted) throw new Error('节点请求已取消；worker 未启动')

  const context = await runtime.prepareNode(resolved.route)
  if (!context || context.isolation_guarantee !== 'enforced'
    || context.node_id !== resolved.route.nodeId || context.profile !== resolved.route.profile) {
    throw new Error('节点执行上下文与签发路由不匹配；worker 未启动')
  }
  const agentOptions = {}
  if (typeof options.reasoningEffort === 'string') agentOptions.reasoningEffort = options.reasoningEffort
  if (Number.isSafeInteger(options.maxTokens) && options.maxTokens > 0) agentOptions.maxTokens = options.maxTokens
  const sessionId = 'vwf-node-' + Date.now().toString(36) + '-' + (++nextRunId).toString(36)
  const payload = {
    sessionId,
    route: resolved.route,
    kind: resolved.kind,
    itemNo: resolved.itemNo,
    folderId: resolved.folderId,
    context: cloneJson(context, '上下文'),
    prompt: cloneJson(request.prompt, 'prompt'),
    outputSchema: request.outputSchema === undefined ? undefined : cloneJson(request.outputSchema, '输出 schema'),
    agentOptions,
  }
  const worker = await runtime.startWorker(payload, { signal: request.signal })
  if (!worker || !worker.accepted || !worker.result || typeof worker.dispose !== 'function') {
    try { await worker?.dispose?.() } catch { /* preserve startup error */ }
    throw new Error('节点 worker 没有提供完整的接受/结果/回收句柄')
  }
  const workerResult = Promise.resolve(worker.result)
  workerResult.catch(() => {})
  try {
    await worker.accepted
  } catch (error) {
    try { await worker.dispose() } catch { /* preserve startup error */ }
    throw new Error('节点 worker 未能确认 prompt 入队：' + safeDiagnostic(error?.message || error).slice(0, 500))
  }

  let disposed = false
  const dispose = async () => {
    if (disposed) return
    disposed = true
    await worker.dispose()
  }
  const result = workerResult
    .then((value) => normalizeResult(value, payload.outputSchema !== undefined))
    .catch((error) => errorResult(String(error?.message || error)))
  result.catch(() => {})
  return { id: sessionId, localAgent: undefined, result, dispose }
}

function bindRun(run, runId) {
  if (run && run.result && typeof run.result.finally === 'function') {
    run.result.finally(() => activeRoutes.clearRun(runId)).catch(() => {})
  }
  return run
}

module.exports = {
  createRouteRegistry,
  issueRun,
  start,
  bindRun,
  startWorkflow: activeRoutes.startWorkflow,
  clearRun: activeRoutes.clearRun,
  resolveRoute: activeRoutes.resolve,
}
