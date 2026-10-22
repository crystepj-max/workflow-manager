import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const workerPath = require.resolve('../../packages/dsh-visual-workflow/src/node-provider-worker.mjs')
const {
  validateNodeProviderPayload,
  mapStopReason,
  encodeProtocolLine,
  sanitizeWorkerDiagnostic,
  resolveDshRuntimeRoots,
  buildIsolatedNodeProfilePatch,
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

test('隔离节点让工具继承启动垫片的沙箱，不再请求 macOS 嵌套沙箱', () => {
  assert.equal(typeof buildIsolatedNodeProfilePatch, 'function')
  const patch = buildIsolatedNodeProfilePatch(payload, '/opt/vwf/dist/structured-output.mjs')
  assert.match(patch, /- id: sandbox-policy\n  config:\n    mode: danger-full-access/)
  assert.doesNotMatch(patch, /disabled: true/)
  assert.doesNotMatch(patch, /vwf-structured-output/)
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }
  const structured = buildIsolatedNodeProfilePatch({ ...payload, outputSchema: schema }, '/opt/vwf/dist/structured-output.mjs')
  assert.match(structured, /id: vwf-structured-output/)
  assert.ok(structured.includes('schema: ' + JSON.stringify(schema)))
  assert.throws(() => buildIsolatedNodeProfilePatch({ ...payload, context: { ...payload.context, isolation_guarantee: 'unavailable' } }), /context does not match route/)
})

test('DSH runtime roots include hoisted package directories without exposing the workspace node_modules root', () => {
  const dist = join(pluginRoot, 'dist')
  const localNodeModules = join(pluginRoot, 'node_modules')
  const nodeModules = existsSync(localNodeModules) ? realpathSync(localNodeModules) : null
  const repoNodeModules = join(realpathSync(join(pluginRoot, '..', '..')), 'node_modules')
  const roots = resolveDshRuntimeRoots(dist)
  const isWithin = (root, target) => {
    const rel = relative(root, target)
    return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep))
  }

  if (nodeModules) assert.ok(roots.includes(nodeModules))
  assert.ok(roots.includes(realpathSync(dist)))
  assert.equal(roots.includes(repoNodeModules), false)

  for (const packageName of [
    '@deepseek-ai/cordis',
    '@deepseek-ai/cordis-plugin-group',
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

async function assertRuntimePackageRoots(localModulesPresent) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vwf-peer-roots-')))
  try {
    const fixturePlugin = join(root, 'packages', 'plugin')
    const dist = join(fixturePlugin, 'dist')
    const localNodeModules = join(fixturePlugin, 'node_modules')
    const hoistedNodeModules = join(root, 'node_modules')
    mkdirSync(dist, { recursive: true })
    if (localModulesPresent) mkdirSync(localNodeModules, { recursive: true })
    copyFileSync(workerPath, join(dist, 'node-provider-worker.mjs'))
    // 这里只调用目录收集器；SDK 与执行辅助入口均不启动。
    writeFileSync(join(dist, 'node-provider-loopback-proxy.mjs'), 'export const createDeepSeekApiLoopbackProxy = () => {}\n')
    writeFileSync(join(dist, 'structured-output.mjs'), 'export const buildStructuredOutputPatch = () => {}; export const extractStructuredOutput = () => {}\n')
    const install = (modules, name, manifest, entry = '') => {
      const packageRoot = join(modules, name)
      mkdirSync(packageRoot, { recursive: true })
      writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...manifest }))
      writeFileSync(join(packageRoot, 'index.js'), entry)
      return packageRoot
    }
    install(hoistedNodeModules, '@deepseek-ai/dsh-sdk-client', { type: 'module', main: 'index.js' }, 'export class DeepSeekHarness {}\n')
    const dsh = install(hoistedNodeModules, '@deepseek-ai/dsh', { dependencies: { '@fixture/boot': '*' } })
    const tools = install(hoistedNodeModules, '@deepseek-ai/dsh-tools', {})
    const boot = install(hoistedNodeModules, '@fixture/boot', {
      peerDependencies: { '@fixture/peer': '*', '@fixture/missing-peer': '*' },
      peerDependenciesMeta: { '@fixture/missing-peer': { optional: true } },
      devDependencies: { '@fixture/dev-only': '*' },
    })
    const peer = install(hoistedNodeModules, '@fixture/peer', {
      dependencies: { '@fixture/transitive': '*' },
      optionalDependencies: { '@fixture/optional': '*' },
      peerDependencies: { '@fixture/boot': '*' },
    })
    const transitive = install(hoistedNodeModules, '@fixture/transitive', {
      peerDependencies: { '@fixture/nested-peer': '*' },
    })
    const optional = install(hoistedNodeModules, '@fixture/optional', {})
    const nestedPeer = install(hoistedNodeModules, '@fixture/nested-peer', { dependencies: { '@fixture/peer': '*' } })
    const undeclared = install(hoistedNodeModules, '@fixture/undeclared', {})
    const devOnly = install(hoistedNodeModules, '@fixture/dev-only', {})
    const worker = await import(pathToFileURL(join(dist, 'node-provider-worker.mjs')).href)
    const roots = worker.resolveDshRuntimeRoots(dist)

    assert.ok(roots.includes(peer), '已声明并提升的 peer 包必须可读')
    assert.ok(roots.includes(transitive), 'peer 的运行时依赖必须可读')
    assert.ok(roots.includes(optional), 'peer 实际安装的可选依赖必须可读')
    assert.ok(roots.includes(nestedPeer), '传递运行时包的 peer 也必须可读')
    assert.equal(roots.includes(hoistedNodeModules), false, '不得授权整个提升目录')
    assert.equal(roots.includes(undeclared), false, '未声明的已安装包不得进入闭包')
    assert.equal(roots.includes(devOnly), false, 'devDependencies 不属于运行时闭包')
    assert.equal(roots.some((path) => path.endsWith('/@fixture/missing-peer')), false, '未安装的可选 peer 不得生成授权')
    assert.equal(roots.length, new Set(roots).size, '循环和重复依赖只收集一次')
    assert.deepEqual(roots, [...(localModulesPresent ? [localNodeModules] : []), dist, dsh, tools, boot, peer, transitive, optional, nestedPeer].sort())
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

for (const localModulesPresent of [true, false]) {
  test(`DSH runtime roots follow installed declared peers with ${localModulesPresent ? 'local' : 'fully hoisted'} dependencies`, () =>
    assertRuntimePackageRoots(localModulesPresent))
}

test('SDK agent-loop and mounted tools use the same scheduler contract', async () => {
  const dshRequire = createRequire(pluginRequire.resolve('@deepseek-ai/dsh/package.json'))
  const baseRequire = createRequire(dshRequire.resolve('@deepseek-ai/dsh-base/package.json'))
  const loopRequire = createRequire(baseRequire.resolve('@deepseek-ai/dsh-agent-loop'))
  const entries = [dshRequire, loopRequire, pluginRequire].map((from) =>
    realpathSync(from.resolve('@deepseek-ai/dsh-tools')))
  const guidance = 'SDK 安装、agent-loop 与结构化插件必须共享同一 tools 调度器；在仓库根执行 npm dedupe --ignore-scripts 后重跑本检查。解析路径：' + entries.join(', ')
  assert.equal(new Set(entries).size, 1, guidance)
  const modules = await Promise.all(entries.map((entry) => import(pathToFileURL(entry).href)))
  assert.equal(typeof modules[0].TOOL_RUNTIME_SCHEDULER, 'symbol', guidance)
  for (const tools of modules) {
    assert.equal(tools.TOOL_RUNTIME_SCHEDULER, modules[0].TOOL_RUNTIME_SCHEDULER, guidance)
  }
})
