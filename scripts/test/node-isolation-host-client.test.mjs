import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createNodeIsolationHostClient } = require('../node-isolation-host-client.cjs')

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
