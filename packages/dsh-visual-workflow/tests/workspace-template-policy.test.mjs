// LOC-009：模板策略注册表权威化 —— host 侧模板映射（mapTemplateId 猜测退役）、
// optimize resource_kind 正式传参、蓝图 workspace 声明字段（投影双向同步 + 校验）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')

// Core 注册表权威（语义与声明对齐断言直接对实物断言，不复制规则）
const core = await import('file://' + join(repoRoot, 'scripts', 'workspace-isolation.mjs'))
const validateCore = require(join(repoRoot, 'scripts', 'validate-core.cjs'))
const projectionCore = require(join(repoRoot, 'scripts', 'projection-core.cjs'))

import { loadHost } from './helpers/load-host.mjs'
import { REPO, makeFs } from './helpers/fake-services.mjs'

const WRAPPER = REPO + '/scripts/workspace-isolation-host.mjs'

const DECL = {
  construction: { mode: 'ISOLATED_WRITE', shared_source: false, per_worker_scratch: false },
  'wf-optimize': {
    resource_kinds: { git: 'ISOLATED_WRITE', files: 'ISOLATED_WRITE', document: 'SANDBOX', config: 'SANDBOX', other: 'SANDBOX' },
    shared_source: false, per_worker_scratch: false,
  },
  'wf-diagnose': { mode: 'ISOLATED_WRITE', freeze_from: 'diagnose', shared_source: false, per_worker_scratch: false },
  'wf-explore': { mode: 'ISOLATED_READ', shared_source: true, per_worker_scratch: true },
}

// ── Core：TEMPLATE_REGISTRY 是策略声明的唯一权威 ─────────────────────────
test('LOC-009：TEMPLATE_REGISTRY 键即四类正式模板身份，resolveWorkspacePolicy 只按注册表解析', () => {
  assert.deepEqual(Object.keys(core.TEMPLATE_REGISTRY).sort(), ['construction', 'wf-diagnose', 'wf-explore', 'wf-optimize'])
  assert.equal(core.resolveWorkspacePolicy('construction').mode, 'ISOLATED_WRITE')
  assert.equal(core.resolveWorkspacePolicy('wf-diagnose').freeze_from, 'diagnose')
  assert.equal(core.resolveWorkspacePolicy('wf-explore').mode, 'ISOLATED_READ')
  assert.equal(core.resolveWorkspacePolicy('wf-optimize', { resource_kind: 'git' }).mode, 'ISOLATED_WRITE')
  assert.equal(core.resolveWorkspacePolicy('wf-optimize', { resource_kind: 'document' }).mode, 'SANDBOX')
  assert.throws(() => core.resolveWorkspacePolicy('wf-optimize', {}), /resource_kind/)
  assert.throws(() => core.resolveWorkspacePolicy('not-a-template'), /template_id/)
})

// ── 投影双向同步：蓝图 ↔ vwf DSL 的 workspace 字段不丢失 ─────────────────
test('LOC-009：workspace 声明经 validate-core / projection-core 双向投影保真', () => {
  const ws = { template_id: 'wf-optimize', resource_kind: 'files' }
  const bp = { id: 'x', displayName: 'X', entry: 'a', nodes: [{ id: 'a', profile: 'p', goal: 'g' }], edges: [{ from: 'a', to: '$end', on: 'success' }], workspace: ws }
  for (const coreMod of [validateCore, projectionCore]) {
    const dsl = coreMod.projectToVwf(bp)
    assert.deepEqual(dsl.workspace, ws, coreMod === validateCore ? 'validate-core bp→dsl' : 'projection-core bp→dsl')
    const bp2 = coreMod.projectToBlueprint(dsl)
    assert.deepEqual(bp2.workspace, ws, coreMod === validateCore ? 'validate-core dsl→bp' : 'projection-core dsl→bp')
  }
})

test('LOC-009：workspace 声明校验 —— 非法 template_id / resource_kind 拒绝且带 fieldKey', () => {
  const base = { id: 'x', displayName: 'X', entry: 'a', nodes: [{ id: 'a', profile: 'p', goal: 'g' }], edges: [{ from: 'a', to: '$end', on: 'success' }] }
  assert.ok(validateCore.validateBlueprint({ ...base, workspace: { template_id: 'wf-optimize' } }).ok)
  const badKind = validateCore.validateBlueprint({ ...base, workspace: { template_id: 'wf-optimize', resource_kind: 'video' } })
  assert.ok(!badKind.ok)
  assert.ok(badKind.errors.some((e) => e.at === '$.workspace.resource_kind' && e.fieldKey === 'workspace:resource_kind'))
  const badId = validateCore.validateBlueprint({ ...base, workspace: { template_id: 'nope' } })
  assert.ok(!badId.ok)
  assert.ok(badId.errors.some((e) => e.at === '$.workspace.template_id' && e.fieldKey === 'workspace:template_id'))
  const notObject = validateCore.validateBlueprint({ ...base, workspace: 'optimize' })
  assert.ok(!notObject.ok)
})

// ── host 侧：模板映射与 resource_kind 传参（stub 包装脚本子进程）─────────
const MINI_DSL = (extra = {}) => ({
  id: 'my-flow', name: '自定义流', entry: 'a',
  nodes: [{ id: 'a', profile: 'dispatcher', label: 'a', goal: 'g', model: { provider: 'p1', model: 'm1' } }],
  edges: [{ from: 'a', to: '$end', on: 'success' }],
  ...extra,
})

function wsSubprocessStub({ registry = DECL, captured = [] } = {}) {
  const reader = (text) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })
  const okJson = (obj) => ({ pid: 7, done: Promise.resolve({ exitCode: 0, signal: null }), collected: { stdout: reader(JSON.stringify(obj)), stderr: reader('') }, terminate() {}, waitForExit: async () => true })
  return {
    async resolveExecutable() { return '/usr/bin/node' },
    spawn(spec) {
      const [, script, cmd, payloadJson] = spec.argv
      if (String(script).endsWith('workspace-isolation-host.mjs')) {
        const payload = JSON.parse(payloadJson || '{}')
        captured.push({ cmd, payload })
        if (cmd === 'templateRegistry') return registry === null ? okJson({ ok: false, error: 'unavailable' }) : okJson({ ok: true, registry })
        if (cmd === 'allocate') {
          return okJson({ ok: true, workspace: { workspace_id: 'ws-' + payload.logical_run_id, logical_run_id: payload.logical_run_id, workspace_mode: 'ISOLATED_WRITE', workspace_path: '/ws/path', source_path: '/ws/path/source', records_path: '/ws/records', work_branch: 'vwf/run/x', source_revision: 'r', current_head: 'r', base_commit: 'b', lifecycle: 'READY', created_at: '2026-09-11T00:00:00.000Z' } })
        }
        return okJson({ ok: true })
      }
      if (String(spec.argv.join(' ')).includes('generate.mjs')) {
        return okJson({ ok: true, script: '//MOCK-SCRIPT', meta: { name: 'mock', description: 'mock', phases: [] } })
      }
      return okJson({ ok: true })
    },
  }
}

function loadWithWs(subprocess) {
  const fs = makeFs({ [WRAPPER]: '// stub wrapper（存在性即可，spawn 由 stub 承接）\n' })
  return loadHost({ fs, subprocess, sandboxPolicy: { workspaceRoot: '/repo', resolve: () => ({ mode: 'danger-full-access', workspaceRoot: '/' }) } })
}

test('LOC-009：vwf.workspace.allocate 按注册表权威解析模板，resource_kind 正式入载荷', async () => {
  const captured = []
  const { handlers } = loadWithWs(wsSubprocessStub({ captured }))
  const allocate = handlers.get('vwf.workspace.allocate')
  assert.ok(allocate, 'vwf.workspace.allocate RPC 已注册')

  // ① templateId 精确等于注册表键 → 原样权威解析
  const r1 = await allocate({ taskId: 't1', templateId: 'wf-optimize', resource_kind: 'files' })
  assert.ok(r1.ok)
  // ② 非规范 id + 模板声明 → 取声明 template_id
  const r2 = await allocate({ taskId: 't2', templateId: 'my-optimize-flow', declared_workspace: { template_id: 'wf-diagnose' } })
  assert.ok(r2.ok)
  // ③ 非规范 id、无声明 → 保守默认 construction（不做名字猜测）
  const r3 = await allocate({ taskId: 't3', templateId: 'totally-custom' })
  assert.ok(r3.ok)

  const allocs = captured.filter((c) => c.cmd === 'allocate')
  assert.equal(allocs.length, 3)
  assert.equal(allocs[0].payload.template_id, 'wf-optimize')
  assert.equal(allocs[0].payload.resource_kind, 'files')
  assert.equal(allocs[1].payload.template_id, 'wf-diagnose')
  assert.equal(allocs[2].payload.template_id, 'construction')
  assert.equal(allocs[2].payload.resource_kind, undefined)
})

test('LOC-009：vwf.script allocate 路径透传模板声明与运行参数 resource_kind（参数优先）', async () => {
  const captured = []
  const { handlers } = loadWithWs(wsSubprocessStub({ captured }))
  const vwfScript = handlers.get('vwf.script')
  assert.ok(vwfScript, 'vwf.script RPC 已注册')

  // 模板声明携带 optimize + document → 载荷取声明
  const r1 = await vwfScript({ taskId: 't-decl', allocate: true, dsl: MINI_DSL({ workspace: { template_id: 'wf-optimize', resource_kind: 'document' } }) })
  assert.ok(r1.ok, 'vwf.script（声明路径）应成功：' + JSON.stringify(r1))

  // 显式运行参数 resource_kind 优先于声明
  const r2 = await vwfScript({ taskId: 't-param', allocate: true, resource_kind: 'config', dsl: MINI_DSL({ workspace: { template_id: 'wf-optimize', resource_kind: 'document' } }) })
  assert.ok(r2.ok, 'vwf.script（参数路径）应成功：' + JSON.stringify(r2))

  const allocs = captured.filter((c) => c.cmd === 'allocate')
  assert.equal(allocs.length, 2)
  assert.equal(allocs[0].payload.template_id, 'wf-optimize')
  assert.equal(allocs[0].payload.resource_kind, 'document')
  assert.equal(allocs[1].payload.resource_kind, 'config')

  // 注册表查询进程内缓存：多次 RPC 只取一次 templateRegistry
  assert.equal(captured.filter((c) => c.cmd === 'templateRegistry').length, 1)
})

test('LOC-009：optimize 缺 resource_kind 时载荷不伪造缺省，由 Core 策略解析 fail closed', async () => {
  const captured = []
  const { handlers } = loadWithWs(wsSubprocessStub({ captured }))
  const allocate = handlers.get('vwf.workspace.allocate')
  const r = await allocate({ taskId: 't-no-kind', templateId: 'wf-optimize' })
  // host 不代填 resource_kind；载荷缺省交给包装脚本 → Core 抛「optimize 必须提供 resource_kind」
  const alloc = captured.find((c) => c.cmd === 'allocate')
  assert.equal(alloc.payload.template_id, 'wf-optimize')
  assert.equal(alloc.payload.resource_kind, undefined)
  assert.ok(r.ok, 'host 层放行缺省，最终由 Core fail closed')
})
