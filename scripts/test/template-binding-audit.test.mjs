// FIX-234 内置模板默认绑定核对：审计内核（注入目录）正负路径 + CLI 显式跳过/实况核对
// 真机层闸门核心可单测；仓库层锚点 = builtin-template-model-defaults.test.mjs 映射表。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, '..', 'template-binding-audit.mjs')
// 四套正式内置绑定节点总数：construction 6 + diagnose 5 + optimize 4 + explore 4 = 19
const EXPECTED_NODES = 19

const BINDINGS = {
  'wf-construction-full-feature': {
    preflight: { provider: 'deepseek-official', model: 'deepseek-flash' },
    review: { provider: 'deepseek-official', model: 'deepseek-v4.1-flash' },
    test: { provider: 'deepseek-official', model: 'deepseek-v4.1-flash' },
  },
  'wf-explore': {
    orchestrate: { provider: 'deepseek-official', model: 'deepseek-flash' },
    evaluate: { provider: 'deepseek-official', model: 'deepseek-v4.1-flash' },
  },
}

const FULL_CATALOG = { 'deepseek-official': ['deepseek-flash', 'deepseek-v4.1-flash'] }
const STALE_CATALOG = { 'deepseek-official': ['deepseek-flash'] } // 模拟 v4.1-flash 被删除后的漂移

function toSets(catalog) {
  const out = {}
  for (const [provider, models] of Object.entries(catalog)) out[provider] = new Set(models)
  return out
}

test('FIX-234 审计内核：目录全含 → 全绿（AC-04 正路径）', async () => {
  const { auditBindings } = await import('../template-binding-audit.mjs')
  const r = auditBindings(BINDINGS, toSets(FULL_CATALOG))
  assert.equal(r.ok, true)
  assert.equal(r.missing.length, 0)
  assert.equal(r.results.length, 5) // BINDINGS 共 5 个节点（3 + 2）
  assert.ok(r.results.every((x) => x.present))
})

test('FIX-234 审计内核：目录缺模型 → 失败并逐节点指认（AC-04 负路径）', async () => {
  const { auditBindings } = await import('../template-binding-audit.mjs')
  const r = auditBindings(BINDINGS, toSets(STALE_CATALOG))
  assert.equal(r.ok, false)
  assert.deepEqual(r.missing.map((m) => `${m.template}/${m.node}`).sort(), [
    'wf-construction-full-feature/review',
    'wf-construction-full-feature/test',
    'wf-explore/evaluate',
  ])
  assert.ok(r.missing.every((m) => m.provider === 'deepseek-official' && m.model === 'deepseek-v4.1-flash'))
})

test('FIX-234 审计内核：未知 provider 的绑定按缺失处理（不静默放行）', async () => {
  const { auditBindings } = await import('../template-binding-audit.mjs')
  const r = auditBindings({ 'wf-explore': { evaluate: { provider: 'ghost-provider', model: 'm1' } } }, toSets(FULL_CATALOG))
  assert.equal(r.ok, false)
  assert.equal(r.missing[0].template, 'wf-explore')
})

test('FIX-234 CLI：未提供目录 → 显式跳过且退出码 0（AC-03，不静默绿不误报红）', () => {
  const stdout = execFileSync(process.execPath, [script, '--format', 'json'], {
    cwd: join(here, '..'),
    encoding: 'utf-8',
    env: { ...process.env, TEMPLATE_BINDING_CATALOG: '' },
  })
  const out = JSON.parse(stdout)
  assert.equal(out.skipped, true)
  assert.ok(out.skipReason.includes('未提供模型目录'))
})

test('FIX-234 CLI：提供目录且当前 templates/ 实况全命中 → 退出码 0', () => {
  const catalogFile = join(here, 'fixtures', 'template-binding-catalog-ok.json')
  const stdout = execFileSync(process.execPath, [script, '--catalog', catalogFile, '--format', 'json'], {
    cwd: join(here, '..'),
    encoding: 'utf-8',
  })
  const out = JSON.parse(stdout)
  assert.equal(out.skipped, false)
  assert.equal(out.ok, true, JSON.stringify(out.missing))
  const templates = new Set(out.results.map((r) => r.template))
  assert.deepEqual([...templates].sort(), ['wf-construction-full-feature', 'wf-diagnose', 'wf-explore', 'wf-optimize'])
  assert.equal(out.results.length, EXPECTED_NODES)
})
