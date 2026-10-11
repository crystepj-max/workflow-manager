import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, '..', 'node-provider-host.mjs')

function call(command, input) {
  return JSON.parse(execFileSync(process.execPath, [script, command, JSON.stringify(input)], { encoding: 'utf8' }))
}

test('R10 route issuer creates per-node opaque routes shared with attribution', () => {
  const result = call('createRoutes', {
    logical_run_id: 'logical-r10', work_root: '/tmp/wfm-workspaces', isolation_guarantee: 'enforced',
    model_overrides: { work: { provider: 'p2', model: 'm2' }, $default: { provider: 'pd', model: 'md' } },
    dsl: { nodes: [
      { id: 'work', profile: 'dev', model: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } },
      { id: 'fan:node', profile: 'researcher', model: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } },
    ] },
  })
  assert.equal(result.ok, true)
  assert.ok(Number.isSafeInteger(result.expiresAt) && result.expiresAt > Date.now(), '签发路由必须带到期时间')
  assert.equal(result.routes.length, 2)
  assert.equal(Object.keys(result.tokens.nodes).length, 2)
  assert.equal(Object.keys(result.tokens.attribution).length, 2)
  assert.equal(new Set(result.routes.map((route) => route.token)).size, 2)
  assert.ok(result.routes.every((route) => /^[a-f0-9]{64}$/.test(route.token)))
  assert.ok(result.routes.every((route) => route.nodeFolderId === 'route-' + route.token.slice(0, 24)))
  assert.equal(result.tokens.attribution.work, result.tokens.nodes.work)
  assert.equal(result.routes.find((route) => route.nodeId === 'work').attributionFolderId, 'route-' + result.tokens.nodes.work.slice(0, 24) + '-attribution')
  assert.equal(result.routes.find((route) => route.nodeId === 'fan:node').nodeId, 'fan:node')
  assert.deepEqual(
    { provider: result.routes.find((route) => route.nodeId === 'work').provider, model: result.routes.find((route) => route.nodeId === 'work').model },
    { provider: 'p2', model: 'm2' },
    '显式节点模型覆盖仍由宿主解析到隔离路由',
  )
  assert.deepEqual(
    { provider: result.routes.find((route) => route.nodeId === 'fan:node').provider, model: result.routes.find((route) => route.nodeId === 'fan:node').model },
    { provider: 'pd', model: 'md' },
    '$default 覆盖未显式指定节点的实际 Provider/Model',
  )
})

test('R10 route issuer fails closed for missing isolation and duplicate node ids', () => {
  const base = { logical_run_id: 'logical-r10', work_root: '/tmp/wfm-workspaces', dsl: { nodes: [{ id: 'work', profile: 'dev' }] } }
  assert.match(call('createRoutes', { ...base, isolation_guarantee: 'unavailable' }).error, /enforced isolation/)
  assert.match(call('createRoutes', { ...base, isolation_guarantee: 'enforced', dsl: { nodes: [{ id: 'work', profile: 'dev' }, { id: 'work', profile: 'review' }] } }).error, /unique/)
  assert.match(call('createRoutes', { ...base, isolation_guarantee: 'enforced', ttl_ms: 86400001 }).error, /ttl_ms/)
})
