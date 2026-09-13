// LOC-014 模型覆盖层单元测试：合成单点 / $default 兜底 / 无效键忽略 / 坏 JSON 容错 /
// userDir 整份覆盖优先 / RPC save / clear / 非内置拒绝
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

import { loadHost } from './helpers/load-host.mjs'
import { REPO, DSH_HOME, USER_DIR, makeFs, makeSubprocess, sandboxPolicy } from './helpers/fake-services.mjs'

const call = async (handlers, method, args) => handlers.get(method)(args)

// 统一校验内核：宿主经 fs 读源码求值——假 fs 需种入真实内核
const validatorCoreSrc = readFileSync(join(here, '..', '..', '..', 'scripts', 'validate-core.cjs'), 'utf8')

// 内置生成物：bindings.models 只绑 a，b 留空（供 $default 兜底验证）
const BUILTIN_ID = 'override-target'
const BUILTIN_DSL = JSON.stringify({
  id: BUILTIN_ID,
  name: '覆盖目标模板',
  description: 'LOC-014 测试内置',
  entry: 'a',
  control: { maxRounds: 3 },
  nodes: [
    { id: 'a', profile: 'dispatcher', label: 'A', goal: 'g', model: { provider: 'p1', model: 'm1' } },
    { id: 'b', profile: 'dev', label: 'B', goal: 'g', model: { provider: 'p1', model: 'm1' } },
  ],
  edges: [
    { from: 'a', to: 'b', on: 'success' },
    { from: 'b', to: '$end', on: 'success' },
  ],
}, null, 2) + '\n'

const OV_DIR = DSH_HOME + '/visual-workflow/model-overrides'

function env(seedExtra = {}) {
  const seed = {
    [REPO + '/.generated/' + BUILTIN_ID + '/vwf-dsl.json']: BUILTIN_DSL,
    [REPO + '/scripts/validate-core.cjs']: validatorCoreSrc,
  }
  Object.assign(seed, seedExtra)
  const fs = makeFs(seed)
  const sub = makeSubprocess({ fs, compileScript: '//MOCK-SCRIPT' })
  const { handlers, definedTools, events, ctx } = loadHost({ fs, subprocess: sub, sandboxPolicy })
  return { handlers, definedTools, events, ctx, fs, sub }
}

// 权威断言：node.model 内联（.generated 生成物无 bindings，运行时读内联）
const nodeModelOf = (entry, nodeId) => {
  const n = ((entry.dsl && entry.dsl.nodes) || []).find((x) => x.id === nodeId)
  return (n && n.model) || null
}
const modelsOf = (entry) => (entry.dsl && entry.dsl.bindings && entry.dsl.bindings.models) || null

test('LOC-014 合成：显式节点覆盖 + $default 兜底（builtin 条目所见即所跑）', async () => {
  const { handlers } = env({
    [OV_DIR + '/' + BUILTIN_ID + '.json']: JSON.stringify({ a: { provider: 'p2', model: 'm2' }, '$default': { provider: 'p3', model: 'm3' } }),
  })
  const list = await call(handlers, 'vwf.workflows.list', {})
  const entry = list.find((w) => w.id === BUILTIN_ID)
  assert.ok(entry, '内置条目存在')
  assert.equal(entry.modelOverridden, true, '携带已覆盖标记')
  assert.equal(nodeModelOf(entry, 'a').provider, 'p2', '精确覆盖写节点内联模型')
  assert.equal(nodeModelOf(entry, 'a').model, 'm2')
  assert.equal(nodeModelOf(entry, 'b').provider, 'p3', '$default 兜底未被精确覆盖的节点 b（与 #79 运行时语义对齐）')
  assert.equal(nodeModelOf(entry, 'b').model, 'm3')
  const bm = modelsOf(entry)
  assert.equal(bm.b.model, 'm3', '蓝图形态 bindings.models 双写一致（如存在）')
})

test('LOC-014 合成：引用不存在节点的键被忽略', async () => {
  const { handlers } = env({
    [OV_DIR + '/' + BUILTIN_ID + '.json']: JSON.stringify({ a: { provider: 'p2', model: 'm2' }, ghost: { provider: 'px', model: 'mx' } }),
  })
  const list = await call(handlers, 'vwf.workflows.list', {})
  const entry = list.find((w) => w.id === BUILTIN_ID)
  assert.equal(nodeModelOf(entry, 'a').model, 'm2')
  assert.equal(nodeModelOf(entry, 'ghost'), null, '无效节点键不产生任何效果')
})

test('LOC-014 无覆盖：内置条目原样且不携带覆盖标记', async () => {
  const { handlers } = env()
  const list = await call(handlers, 'vwf.workflows.list', {})
  const entry = list.find((w) => w.id === BUILTIN_ID)
  assert.equal(entry.modelOverridden, undefined)
  assert.equal(nodeModelOf(entry, 'a').provider, 'p1', '内置内联模型原样')
})

test('LOC-014 容错：坏 JSON 覆盖文件忽略留痕，不阻断模板加载', async () => {
  const { handlers } = env({
    [OV_DIR + '/' + BUILTIN_ID + '.json']: '{broken json!!',
    [OV_DIR + '/other.json']: JSON.stringify([1, 2, 3]),
  })
  const list = await call(handlers, 'vwf.workflows.list', {})
  const entry = list.find((w) => w.id === BUILTIN_ID)
  assert.ok(entry, '模板仍可加载')
  assert.equal(entry.modelOverridden, undefined, '坏覆盖未生效')
  assert.equal(nodeModelOf(entry, 'a').provider, 'p1')
})

test('LOC-014 优先级：用户整份覆盖优先于历史生成物，且覆盖层仅对正式内置生效', async () => {
  const userBp = JSON.stringify({
    id: 'dev-workflow-2-0',
    displayName: '用户整份覆盖版',
    description: 'user full copy',
    entry: 'a',
    control: { maxRounds: 3 },
    nodes: [
      { id: 'a', profile: 'dispatcher', label: 'A', goal: 'g', model: { provider: 'pu', model: 'mu' } },
      { id: 'b', profile: 'dev', label: 'B', goal: 'g', model: { provider: 'pu', model: 'mu' } },
    ],
    edges: [
      { from: 'a', to: 'b', on: 'success' },
      { from: 'b', to: '$end', on: 'success' },
    ],
    bindings: { models: { a: { provider: 'pu', model: 'mu' } } },
  })
  const { handlers } = env({
    [REPO + '/.generated/dev-workflow-2-0/vwf-dsl.json']: BUILTIN_DSL.replace(BUILTIN_ID, 'dev-workflow-2-0'),
    [USER_DIR + '/dev-workflow-2-0.json']: userBp,
    [OV_DIR + '/dev-workflow-2-0.json']: JSON.stringify({ a: { provider: 'p2', model: 'm2' } }),
  })
  const list = await call(handlers, 'vwf.workflows.list', {})
  const entry = list.find((w) => w.id === 'dev-workflow-2-0')
  assert.equal(entry.builtin, false, '同 id 用户整份覆盖在清单中优先于历史生成物')
  assert.equal(entry.modelOverridden, undefined, '覆盖层不作用于用户自定义资产')
  assert.equal(entry.name, '用户整份覆盖版', '清单展示用户整份内容而非历史生成物')
  const save = await call(handlers, 'vwf.workflows.modelOverride.save', { id: 'dev-workflow-2-0', overrides: { a: { provider: 'p2', model: 'm2' } } })
  assert.equal(save.ok, false, '模型覆盖仅对正式内置开放：历史自定义/用户资产直接编辑')
})

test('LOC-014 RPC save：合法覆盖落盘并可读回', async () => {
  const { handlers, fs } = env()
  const r = await call(handlers, 'vwf.workflows.modelOverride.save', { id: BUILTIN_ID, overrides: { a: { provider: 'p2', model: 'm2' }, ghost: { provider: 'px', model: 'mx' } } })
  assert.equal(r.ok, true)
  const saved = JSON.parse(fs._files.get(OV_DIR + '/' + BUILTIN_ID + '.json'))
  assert.equal(saved.a.model, 'm2')
  const g = await call(handlers, 'vwf.workflows.modelOverride.get', { id: BUILTIN_ID })
  assert.equal(g.ok, true)
  assert.equal(g.overrides.a.provider, 'p2')
})

test('LOC-014 RPC save：空覆盖与非内置模板均拒绝', async () => {
  const { handlers } = env()
  const empty = await call(handlers, 'vwf.workflows.modelOverride.save', { id: BUILTIN_ID, overrides: { a: { provider: '  ', model: 'm2' } } })
  assert.equal(empty.ok, false, '清洗后为空 → 拒绝')
  const nonBuiltin = await call(handlers, 'vwf.workflows.modelOverride.save', { id: 'user-custom', overrides: { a: { provider: 'p', model: 'm' } } })
  assert.equal(nonBuiltin.ok, false, '非内置模板不支持模型覆盖')
})

test('LOC-014 RPC clear：删除覆盖文件即恢复默认（幂等）', async () => {
  const { handlers } = env({
    [OV_DIR + '/' + BUILTIN_ID + '.json']: JSON.stringify({ a: { provider: 'p2', model: 'm2' } }),
  })
  const r1 = await call(handlers, 'vwf.workflows.modelOverride.clear', { id: BUILTIN_ID })
  assert.equal(r1.ok, true)
  const g = await call(handlers, 'vwf.workflows.modelOverride.get', { id: BUILTIN_ID })
  assert.deepEqual(g.overrides, {})
  const r2 = await call(handlers, 'vwf.workflows.modelOverride.clear', { id: BUILTIN_ID })
  assert.equal(r2.ok, true, '清除不存在的覆盖幂等成功')
  const list = await call(handlers, 'vwf.workflows.list', {})
  const entry = list.find((w) => w.id === BUILTIN_ID)
  assert.equal(entry.modelOverridden, undefined, '清除后回到内置默认绑定')
  assert.equal(nodeModelOf(entry, 'a').provider, 'p1', '内联模型恢复内置值')
})

test('LOC-014 安全：路径穿越 / 非法字符 id 三端点拒绝，clear 非内置幂等成功', async () => {
  const { handlers } = env()
  const badIds = ['../../evil', 'a/b', '..\\x', '..', 'x..y']
  for (const id of badIds) {
    for (const method of ['vwf.workflows.modelOverride.get', 'vwf.workflows.modelOverride.save', 'vwf.workflows.modelOverride.clear']) {
      const args = method.endsWith('save') ? { id, overrides: { a: { provider: 'p', model: 'm' } } } : { id }
      const r = await call(handlers, method, args)
      assert.equal(r.ok, false, method + ' 应拒绝非法 id：' + id)
    }
  }
  // clear 对非内置合法 id 幂等成功（本机制不会为其写文件，不触碰文件系统）
  const legacy = await call(handlers, 'vwf.workflows.modelOverride.clear', { id: 'dev-workflow-2-0' })
  assert.equal(legacy.ok, true)
})

test('LOC-014 安全：save 清洗怪键（含路径分隔符）不入盘', async () => {
  const { handlers, fs } = env()
  const r = await call(handlers, 'vwf.workflows.modelOverride.save', { id: BUILTIN_ID, overrides: { a: { provider: 'p2', model: 'm2' }, 'x/y': { provider: 'p', model: 'm' }, '..': { provider: 'p', model: 'm' } } })
  assert.equal(r.ok, true)
  const saved = JSON.parse(fs._files.get(OV_DIR + '/' + BUILTIN_ID + '.json'))
  assert.deepEqual(Object.keys(saved).sort(), ['a'], '怪键被清洗，仅合法键落盘')
})

test('LOC-014 集成：RPC save 落盘后 workflowEntries 经文件回读合成（写读闭环）', async () => {
  const { handlers } = env()
  const save = await call(handlers, 'vwf.workflows.modelOverride.save', { id: BUILTIN_ID, overrides: { a: { provider: 'p2', model: 'm2' } } })
  assert.equal(save.ok, true)
  const list = await call(handlers, 'vwf.workflows.list', {})
  const entry = list.find((w) => w.id === BUILTIN_ID)
  assert.equal(entry.modelOverridden, true)
  assert.equal(nodeModelOf(entry, 'a').model, 'm2', '清单节点内联模型来自落盘覆盖文件回读（运行时权威形态）')
})

test('LOC-014 双写兼容：蓝图形态 DSL（含 bindings.models）合成时双写一致', async () => {
  const dualDsl = BUILTIN_DSL.replace('}, null, 2)', ",  bindings: { models: { b: { provider: 'p1', model: 'm1' } } } }, null, 2)")
  const { handlers } = env({
    [REPO + '/.generated/' + BUILTIN_ID + '/vwf-dsl.json']: dualDsl,
    [OV_DIR + '/' + BUILTIN_ID + '.json']: JSON.stringify({ b: { provider: 'p9', model: 'm9' } }),
  })
  const list = await call(handlers, 'vwf.workflows.list', {})
  const entry = list.find((w) => w.id === BUILTIN_ID)
  assert.equal(nodeModelOf(entry, 'b').model, 'm9', '内联模型已合成')
  assert.equal(modelsOf(entry).b.model, 'm9', 'bindings.models 双写一致')
})
