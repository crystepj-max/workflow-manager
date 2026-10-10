import { test } from 'node:test'
import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, sep } from 'node:path'

const require = createRequire(import.meta.url)
const workerPath = require.resolve('../../packages/dsh-visual-workflow/src/node-provider-worker.mjs')
const {
  validateNodeProviderPayload,
  mapStopReason,
  encodeProtocolLine,
  sanitizeWorkerDiagnostic,
  resolveDshRuntimeRoots,
} = await import(workerPath)
const pluginRoot = dirname(dirname(workerPath))
const pluginRequire = createRequire(join(pluginRoot, 'package.json'))

const payload = {
  sessionId: 'vwf-node-test-1',
  route: { logicalRunId: 'run-1', nodeId: 'worker', profile: 'researcher', provider: 'deepseek-official', model: 'deepseek-v4-pro', isolationGuarantee: 'enforced' },
  context: {
    node_id: 'worker', profile: 'researcher', isolation_guarantee: 'enforced',
    agent_cwd: '/tmp/evidence', scratch_path: '/tmp/scratch',
    writable_roots: ['/tmp/evidence', '/tmp/scratch'],
    capabilities: { candidate: { read: true, write: false } },
  },
  prompt: [{ type: 'text', text: '审查。' }],
}

test('node provider worker requires a matching enforced context; the worker owns its loopback proxy', () => {
  assert.deepEqual(validateNodeProviderPayload(payload), payload)
  assert.throws(() => validateNodeProviderPayload({ ...payload, context: { ...payload.context, node_id: 'other' } }), /context does not match route/)
  assert.throws(() => validateNodeProviderPayload({ ...payload, route: { ...payload.route, token: 'secret' } }), /route token must not enter worker/)
})

test('node provider worker maps DSH turn-end reasons without treating unknown values as success', () => {
  const event = (kind) => ({ type: 'turn/end', data: { reason: { kind } } })
  assert.equal(mapStopReason([event('completed')]), 'completed')
  assert.equal(mapStopReason([event('aborted')]), 'aborted')
  assert.equal(mapStopReason([event('max-tokens')]), 'max-tokens')
  assert.equal(mapStopReason([event('blocked')]), 'refusal')
  assert.equal(mapStopReason([event('interrupted')]), 'error')
  assert.equal(mapStopReason([]), 'error')
})

test('node provider worker writes an ASCII-safe line protocol for Unicode output', () => {
  const line = encodeProtocolLine({ type: 'result', result: { output: [{ type: 'text', text: '完成 ✓' }] } })
  assert.equal(/[\u007f-\uffff]/.test(line), false)
  assert.deepEqual(JSON.parse(line), { type: 'result', result: { output: [{ type: 'text', text: '完成 ✓' }] } })
})

test('node provider worker redacts the resolved API credential from diagnostics', () => {
  const diagnostic = sanitizeWorkerDiagnostic(new Error('request failed with key fixture-secret'), 'fixture-secret')
  assert.equal(diagnostic, 'request failed with key [redacted]')
  assert.equal(sanitizeWorkerDiagnostic('x'.repeat(2200), 'fixture-secret').length, 2000)
})

test('DSH runtime roots include hoisted package directories without exposing the workspace node_modules root', () => {
  const dist = join(pluginRoot, 'dist')
  const nodeModules = realpathSync(join(pluginRoot, 'node_modules'))
  const repoNodeModules = realpathSync(join(pluginRoot, '..', '..', 'node_modules'))
  const roots = resolveDshRuntimeRoots(dist)
  const isWithin = (root, target) => {
    const rel = relative(root, target)
    return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep))
  }

  assert.ok(roots.includes(nodeModules))
  assert.ok(roots.includes(realpathSync(dist)))
  assert.equal(roots.includes(repoNodeModules), false)

  for (const packageName of [
    '@deepseek-ai/cordis',
    '@deepseek-ai/cosmokit',
    '@deepseek-ai/schemastery',
    '@standard-schema/spec',
  ]) {
    const entry = pluginRequire.resolve(packageName)
    let directory = dirname(realpathSync(entry))
    let packageRoot
    while (true) {
      try {
        const manifest = require(join(directory, 'package.json'))
        if (manifest.name === packageName) {
          packageRoot = realpathSync(directory)
          break
        }
      } catch {}
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }
    assert.ok(packageRoot, `${packageName} should resolve to an installed package directory`)
    assert.ok(roots.some((root) => isWithin(root, packageRoot)), `${packageName} must be readable by the isolated DSH process`)
  }
})
