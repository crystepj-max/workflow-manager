import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createRouteRegistry, issueRun, start, clearRun } = require('../node-provider-core.cjs')
const tokenA = 'a'.repeat(64)
const tokenB = 'b'.repeat(64)

function issued(expiresAt = 5000) {
  const common = {
    logicalRunId: 'run-1', workRoot: '/tmp/workspaces', profile: 'researcher',
    nodeCapabilities: null, provider: 'deepseek-official', model: 'deepseek-v4-pro',
    isolationGuarantee: 'enforced',
  }
  return {
    ok: true,
    expiresAt,
    tokens: { nodes: { worker: tokenA }, attribution: { worker: tokenA } },
    routes: [
      { ...common, token: tokenA, nodeId: 'worker', nodeFolderId: 'route-' + tokenA.slice(0, 24), attributionFolderId: 'route-' + tokenA.slice(0, 24) + '-attribution' },
    ],
  }
}

test('node-provider core resolves signed route metadata without exposing the token', () => {
  const registry = createRouteRegistry({ now: () => 1000 })
  registry.registerRun('run-1', issued())
  const base = registry.resolve('vwf-node-isolated:' + tokenA, 'deepseek-v4-pro')
  assert.equal(base.route.nodeId, 'worker')
  assert.equal(base.route.model, 'deepseek-v4-pro')
  assert.equal(Object.hasOwn(base.route, 'token'), false)
  assert.equal(base.kind, 'node')

  const item = registry.resolve('vwf-node-isolated:' + tokenA + ':item:1000', 'deepseek-v4-pro')
  assert.equal(item.kind, 'item')
  assert.equal(item.itemNo, 1000)
  assert.equal(item.folderId, 'route-' + tokenA.slice(0, 24) + '-item-1000')

  const attribution = registry.resolve('vwf-node-isolated:' + tokenA + ':attribution', 'deepseek-v4-pro')
  assert.equal(attribution.kind, 'attribution')
  assert.equal(attribution.folderId, 'route-' + tokenA.slice(0, 24) + '-attribution')
})

test('node-provider core rejects unknown, malformed, wrong-model, and non-isolated routes', () => {
  const registry = createRouteRegistry({ now: () => 1000 })
  registry.registerRun('run-1', issued())
  for (const provider of [
    'deepseek-official',
    'vwf-node-isolated:' + tokenB,
    'vwf-node-isolated:' + tokenA + ':item:1001',
    'vwf-node-isolated:' + tokenA + ':unexpected',
  ]) assert.throws(() => registry.resolve(provider, 'deepseek-v4-pro'), /route rejected/)
  assert.throws(() => registry.resolve('vwf-node-isolated:' + tokenA, 'deepseek-flash'), /route rejected/)
  assert.throws(() => registry.registerRun('other-run', issued()), /not bound to this isolated run/)
})

test('node-provider core expires and clears routes at the run lease boundary', () => {
  let now = 1000
  const registry = createRouteRegistry({ now: () => now })
  registry.registerRun('run-1', issued(2000))
  assert.equal(registry.resolve('vwf-node-isolated:' + tokenA, 'deepseek-v4-pro').kind, 'node')
  now = 2000
  assert.throws(() => registry.resolve('vwf-node-isolated:' + tokenA, 'deepseek-v4-pro'), /route rejected/)
})

test('node-provider core explicitly clears run routes', () => {
  const registry = createRouteRegistry({ now: () => 1000 })
  registry.registerRun('run-1', issued())
  assert.equal(registry.clearRun('run-1'), true)
  assert.equal(registry.clearRun('run-1'), false)
  assert.throws(() => registry.resolve('vwf-node-isolated:' + tokenA, 'deepseek-v4-pro'), /route rejected/)
})

test('node-provider core clears run routes when the workflow engine rejects synchronously', () => {
  const registry = createRouteRegistry({ now: () => 1000 })
  const routes = issued(5000)
  registry.registerRun('run-1', routes)
  assert.throws(() => registry.startWorkflow({ start() { throw new Error('engine unavailable') } }, {}, 'run-1'), /engine unavailable/)
  assert.throws(() => registry.resolve('vwf-node-isolated:' + tokenA, 'deepseek-v4-pro'), /isolated node route rejected/)
})

test('node-provider core refuses non-mechanical nodes when workspace isolation is unavailable', async () => {
  let called = false
  const dsl = { nodes: [{ id: 'worker', profile: 'researcher' }] }
  await assert.rejects(
    issueRun('run-1', dsl, undefined, null, null, async () => ({}), async () => { called = true }),
    /隔离.*不可用|workspace.*isolation/i,
  )
  await assert.rejects(
    issueRun('run-1', dsl, undefined, { workspace_id: 'ws' }, { guarantee: 'unavailable' }, async () => ({}), async () => { called = true }),
    /隔离.*不可用|workspace.*isolation/i,
  )
  assert.equal(called, false)

  assert.equal(await issueRun('run-mechanical', { nodes: [{ id: 'gate', mechanical: 'preflight' }] }, undefined, null, null, async () => ({}), async () => { called = true }), null)
  assert.equal(called, false, '机械节点不需要模型路由')

  const tokens = await issueRun(
    'run-1', dsl, undefined, { workspace_id: 'ws' }, { guarantee: 'enforced' },
    async () => ({ workspaces: '/tmp/workspaces' }),
    async (command, input) => {
      called = command === 'createProviderRoutes' && input.logical_run_id === 'run-1'
      return issued(Date.now() + 10_000)
    },
  )
  assert.equal(called, true)
  assert.equal(tokens.nodes.worker, tokenA)
  clearRun('run-1')
})

test('node-provider core refuses incomplete route tables instead of allowing direct-provider fallback', async () => {
  const dsl = { nodes: [{ id: 'worker', profile: 'researcher' }] }
  await assert.rejects(
    issueRun(
      'run-incomplete', dsl, undefined, { workspace_id: 'ws' }, { guarantee: 'enforced' },
      async () => ({ workspaces: '/tmp/workspaces' }),
      async () => ({ ok: true, tokens: { nodes: {}, attribution: {} }, routes: [], expiresAt: Date.now() + 10_000 }),
    ),
    /隔离节点路由签发失败/,
  )
})

test('node-provider core starts a configured isolated worker without forwarding the route token', async () => {
  const registry = createRouteRegistry({ now: () => 1000 })
  registry.registerRun('run-1', issued())
  const context = {
    node_id: 'worker', profile: 'researcher', isolation_guarantee: 'enforced',
    candidate_path: '/tmp/candidate', evidence_path: '/tmp/evidence', scratch_path: '/tmp/scratch',
    test_overlay_path: '', agent_cwd: '/tmp/evidence', writable_roots: ['/tmp/evidence', '/tmp/scratch'],
    capabilities: { candidate: { read: true, write: false }, source: { read: true, write: false },
      evidence: { read: true, write: true }, test_overlay: { read: false, write: false } },
  }
  const prompt = [{ type: 'text', text: 'Review the candidate.' }]
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }
  const workerResult = { output: [{ type: 'text', text: 'done' }], structured: { ok: true }, stopReason: 'completed' }
  let workerPayload
  let disposed = false

  const run = await start({
    prompt,
    signal: new AbortController().signal,
    outputSchema: schema,
    agentOptions: {
      provider: 'vwf-node-isolated:' + tokenA,
      model: 'deepseek-v4-pro',
      reasoningEffort: 'high',
      apiKey: 'must-not-cross-the-worker-boundary',
    },
  }, {
    routes: registry,
    prepareNode: async (route) => {
      assert.equal(route.nodeId, 'worker')
      return context
    },
    startWorker: async (payload) => {
      workerPayload = payload
      return {
        accepted: Promise.resolve(),
        result: Promise.resolve(workerResult),
        dispose: async () => { disposed = true },
      }
    },
  })

  assert.equal(run.localAgent, undefined)
  assert.equal(run.result instanceof Promise, true)
  assert.equal(run.id, workerPayload.sessionId)
  assert.deepEqual(await run.result, workerResult)
  assert.equal(workerPayload.route.provider, 'deepseek-official')
  assert.equal(workerPayload.route.model, 'deepseek-v4-pro')
  assert.equal(Object.hasOwn(workerPayload, 'loopbackPort'), false)
  assert.deepEqual(workerPayload.prompt, prompt)
  assert.deepEqual(workerPayload.outputSchema, schema)
  assert.equal(workerPayload.agentOptions.reasoningEffort, 'high')
  assert.equal(Object.hasOwn(workerPayload.agentOptions, 'apiKey'), false)
  assert.equal(JSON.stringify(workerPayload).includes(tokenA), false)
  assert.deepEqual(workerPayload.context, context)
  await run.dispose()
  assert.equal(disposed, true)
})

test('node-provider core rejects mismatched node context before starting a worker', async () => {
  const registry = createRouteRegistry({ now: () => 1000 })
  registry.registerRun('run-1', issued())
  let started = false
  await assert.rejects(start({
    prompt: [{ type: 'text', text: 'Review.' }],
    agentOptions: { provider: 'vwf-node-isolated:' + tokenA, model: 'deepseek-v4-pro' },
  }, {
    routes: registry,
    prepareNode: async () => ({ node_id: 'other-node', profile: 'researcher', isolation_guarantee: 'enforced' }),
    startWorker: async () => { started = true },
  }), /上下文与签发路由不匹配/)
  assert.equal(started, false)
})

test('node-provider core reaps a worker that fails before prompt acceptance', async () => {
  const registry = createRouteRegistry({ now: () => 1000 })
  registry.registerRun('run-1', issued())
  let disposed = false
  await assert.rejects(start({
    prompt: [{ type: 'text', text: 'Review.' }],
    agentOptions: { provider: 'vwf-node-isolated:' + tokenA, model: 'deepseek-v4-pro' },
  }, {
    routes: registry,
    prepareNode: async () => ({ node_id: 'worker', profile: 'researcher', isolation_guarantee: 'enforced' }),
    startWorker: async () => ({
      accepted: Promise.reject(new Error('handshake failed')),
      result: new Promise(() => {}),
      dispose: async () => { disposed = true },
    }),
  }), /未能确认 prompt 入队/)
  assert.equal(disposed, true)
})

test('node-provider core maps post-acceptance worker failure to an error result', async () => {
  const registry = createRouteRegistry({ now: () => 1000 })
  registry.registerRun('run-1', issued())
  const run = await start({
    prompt: [{ type: 'text', text: 'Review.' }],
    signal: new AbortController().signal,
    agentOptions: { provider: 'vwf-node-isolated:' + tokenA, model: 'deepseek-v4-pro' },
  }, {
    routes: registry,
    prepareNode: async () => ({ node_id: 'worker', profile: 'researcher', isolation_guarantee: 'enforced' }),
    startWorker: async () => ({
      accepted: Promise.resolve(),
      result: Promise.reject(new Error('transport token=secret-' + tokenA)),
      dispose: async () => {},
    }),
  })
  assert.deepEqual(await run.result, { output: [], diagnostic: 'transport token=[redacted]', stopReason: 'error' })
})
