import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createNodeIsolationHostClient, isolationFieldsOf, recordIsolation } = require('../node-isolation-host-client.cjs')

test('WFM-81 metadata keeps missing history unknown and mirrors node-specific proof decisions', async () => {
  assert.deepEqual(isolationFieldsOf(), { isolation_guarantee: 'unknown', isolation_probe: null, independent_proof_eligible: null, independent_proof_block_reason: null })
  const { canIssueIndependentProof, resolveNodeCapabilities } = await import('../node-isolation.mjs')
  const rec = {}
  const probe = { guarantee: 'enforced', backend: 'fixture', evidence: { outsideBlocked: true } }
  const calls = []
  const dsl = { nodes: [{ id: 'dev', profile: 'dev' }, { id: 'review', profile: 'review' }, { id: 'mechanical', mechanical: true }] }
  await recordIsolation(rec, probe, dsl, async (command, input) => {
    calls.push(command)
    return { ok: true, decision: canIssueIndependentProof(input.isolation_guarantee, resolveNodeCapabilities(input.profile, input.node_capabilities)) }
  })
  assert.deepEqual(calls, ['canIssueProof', 'canIssueProof'])
  assert.equal(rec.node_isolation.review.independent_proof_eligible, true)
  assert.equal(rec.node_isolation.dev.independent_proof_eligible, false)
  assert.match(rec.node_isolation.dev.independent_proof_block_reason, /independent_proof/)
  assert.equal(rec.node_isolation.mechanical, undefined)
  probe.evidence.outsideBlocked = false
  await recordIsolation(rec, { guarantee: 'unavailable', evidence: { reason: 'probe failed' } }, dsl, async () => { throw new Error('gate unavailable') })
  assert.equal(rec.isolation_guarantee, 'unavailable')
  assert.equal(rec.node_isolation.review.independent_proof_eligible, null, '查询失败不能猜成允许')
  assert.equal(rec.node_isolation.review.independent_proof_block_reason, 'independent_proof_eligibility_unknown')
  assert.equal(rec.isolation_history.length, 2)
  assert.equal(rec.isolation_history[0].isolation_probe.evidence.outsideBlocked, true, '后续 Probe 不改历史快照')
})

test('WFM-81 isolation preparation commits current only after an actual new segment starts', async () => {
  const rec = { segments: [] }
  const dsl = { nodes: [{ id: 'review', profile: 'review' }] }
  const hostCall = async () => ({ ok: true, decision: { ok: true } })
  const firstCommit = await recordIsolation(rec, { guarantee: 'enforced', evidence: { marker: 'first' } }, dsl, hostCall)
  assert.equal(rec.isolation_guarantee, 'enforced', '首次未执行的准备仍可观测')
  assert.equal(typeof firstCommit, 'function', '准备回执提供显式提交边界')
  firstCommit()
  rec.segments.push({ run_id: 'engine-1' })
  const previous = JSON.parse(JSON.stringify({ isolation_guarantee: rec.isolation_guarantee, isolation_probe: rec.isolation_probe, node_isolation: rec.node_isolation }))
  const nextCommit = await recordIsolation(rec, { guarantee: 'unavailable', evidence: { marker: 'failed' } }, dsl, async () => ({ ok: true, decision: { ok: false, reason: 'unavailable' } }))
  for (const key of Object.keys(previous)) assert.deepEqual(rec[key], previous[key], '尚未创建新段不能覆盖 ' + key)
  assert.equal(rec.isolation_history.length, 2)
  assert.equal(rec.isolation_history[1].isolation_guarantee, 'unavailable')
  assert.equal(rec.isolation_history[1].node_isolation.review.independent_proof_eligible, false)
  nextCommit()
  assert.equal(rec.isolation_guarantee, 'unavailable', '只在调用者确认新段建立后提交')
  assert.equal(rec.node_isolation.review.independent_proof_eligible, false)
  assert.equal(rec.isolation_history.length, 2, '提交不重复写入历史')
  assert.equal(rec.isolation_history[0].isolation_probe.evidence.marker, 'first')
})

test('WFM-81 legacy attempts without segments still prevent a failed preparation from rewriting unknown current', async () => {
  const rec = { isolation_guarantee: 'unknown', isolation_probe: null, node_isolation: {}, node_attempts: [{ node: 'review' }] }
  await recordIsolation(rec, { guarantee: 'enforced', evidence: { marker: 'new' } }, { nodes: [{ id: 'review', profile: 'review' }] }, async () => ({ ok: true, decision: { ok: true } }))
  assert.equal(rec.isolation_guarantee, 'unknown')
  assert.equal(rec.isolation_probe, null)
  assert.deepEqual(rec.node_isolation, {})
  assert.deepEqual(rec.node_attempts, [{ node: 'review' }])
  assert.equal(rec.isolation_history[0].isolation_guarantee, 'enforced')
})

function subprocessHandle() {
  const stdout = new EventEmitter()
  let resolveDone
  let rejectDone
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject })
  let terminated = false
  let waited = false
  const handle = {
    stdout,
    done,
    terminate() { terminated = true },
    async waitForExit() { waited = true; return true },
  }
  return { handle, resolveDone, rejectDone, state: () => ({ terminated, waited }) }
}

test('node isolation host client preserves the one-shot isolation host call contract', async () => {
  let invocation
  const client = createNodeIsolationHostClient({
    scriptPath: '/repo/scripts/node-isolation-host.mjs',
    workerPath: '/plugin/dist/node-provider-worker.mjs',
    readTextIfExists: async () => 'present',
    runNode: async (args, options) => {
      invocation = { args, options }
      return { ok: true, stdout: '{"ok":true,"guarantee":"enforced"}' }
    },
  })
  const result = await client('probe', { platform: 'darwin' }, { graceMs: 1200 })
  assert.deepEqual(result, { ok: true, guarantee: 'enforced' })
  assert.deepEqual(invocation.args, ['/repo/scripts/node-isolation-host.mjs', 'probe', '{"platform":"darwin"}'])
  assert.equal(invocation.options.graceMs, 1200)
})

test('node isolation host client streams an isolated provider worker and waits for quiescence', async () => {
  const spawned = subprocessHandle()
  const signal = new AbortController().signal
  const payload = { sessionId: 'session-test', context: { agent_cwd: '/workspace/evidence' }, prompt: [{ type: 'text', text: '审查。' }] }
  let spec
  const client = createNodeIsolationHostClient({
    scriptPath: '/repo/scripts/node-isolation-host.mjs',
    workerPath: '/plugin/dist/node-provider-worker.mjs',
    resolveNode: async () => '/runtime/node',
    credentials: { resolve: async () => ({ value: 'fixture-deepseek-key', source: 'test' }) },
    subprocess: { spawn(value) { spec = value; return spawned.handle } },
  })
  const worker = await client('spawnProviderWorker', payload, { signal })
  assert.deepEqual(spec.argv, ['/runtime/node', '/plugin/dist/node-provider-worker.mjs'])
  assert.equal(spec.cwd, '/workspace/evidence')
  assert.equal(spec.signal, signal)
  assert.equal(spec.stdio.stdin.data, JSON.stringify(payload))
  assert.equal(spec.stdio.stdout, 'pipe')
  assert.equal(spec.env.NODE_OPTIONS, undefined)
  assert.equal(spec.env.DSH_HOME, undefined)
  assert.equal(spec.env.DEEPSEEK_API_KEY, 'fixture-deepseek-key', '真实 API 凭据只传给受信任 worker')
  assert.equal(spec.env.OPENAI_API_KEY, undefined, '不得转发无关 provider 凭据')

  spawned.handle.stdout.emit('data', '{"type":"accepted"}\n')
  await worker.accepted
  spawned.handle.stdout.emit('data', '{"type":"result","result":{"output":[{"type":"text","text":"完成"}],"stopReason":"completed"}}\n')
  spawned.resolveDone({ exitCode: 0, signal: null })
  assert.deepEqual(await worker.result, { output: [{ type: 'text', text: '完成' }], stopReason: 'completed' })
  await worker.dispose()
  assert.deepEqual(spawned.state(), { terminated: false, waited: true })
})

test('node isolation host client rejects a worker that exits before acceptance and reaps it', async () => {
  const spawned = subprocessHandle()
  const client = createNodeIsolationHostClient({
    scriptPath: '/repo/scripts/node-isolation-host.mjs',
    workerPath: '/plugin/dist/node-provider-worker.mjs',
    resolveNode: async () => '/runtime/node',
    credentials: { resolve: async () => ({ value: 'fixture-deepseek-key', source: 'test' }) },
    subprocess: { spawn() { return spawned.handle } },
  })
  const worker = await client('spawnProviderWorker', { sessionId: 'session-test', context: { agent_cwd: '/workspace' } })
  spawned.resolveDone({ exitCode: 78, signal: null })
  await assert.rejects(worker.accepted, /worker exited before prompt acceptance/)
  await assert.rejects(worker.result, /worker exited before prompt acceptance/)
  await worker.dispose()
  assert.deepEqual(spawned.state(), { terminated: false, waited: true })
})

test('node isolation host client reports a nonzero exit after prompt acceptance', async () => {
  const spawned = subprocessHandle()
  const client = createNodeIsolationHostClient({
    scriptPath: '/repo/scripts/node-isolation-host.mjs',
    workerPath: '/plugin/dist/node-provider-worker.mjs',
    resolveNode: async () => '/runtime/node',
    credentials: { resolve: async () => ({ value: 'fixture-deepseek-key', source: 'test' }) },
    subprocess: { spawn() { return spawned.handle } },
  })
  const worker = await client('spawnProviderWorker', { sessionId: 'session-test', context: { agent_cwd: '/workspace' } })
  spawned.handle.stdout.emit('data', '{"type":"accepted"}\n')
  await worker.accepted
  spawned.resolveDone({ exitCode: 78, signal: null })
  await assert.rejects(worker.result, /exit 78/)
  await worker.dispose()
  assert.deepEqual(spawned.state(), { terminated: false, waited: true })
})

test('node isolation host client refuses to start when the model credential is missing', async () => {
  let spawned = false
  const client = createNodeIsolationHostClient({
    workerPath: '/plugin/dist/node-provider-worker.mjs',
    resolveNode: async () => '/runtime/node',
    credentials: { resolve: async () => undefined },
    subprocess: { spawn() { spawned = true; throw new Error('must not spawn') } },
  })
  await assert.rejects(
    client('spawnProviderWorker', { sessionId: 'session-test', context: { agent_cwd: '/workspace' } }),
    /DeepSeek API 凭据不可用/,
  )
  assert.equal(spawned, false, '凭据不可用时不得启动 worker 或模型请求')
})
