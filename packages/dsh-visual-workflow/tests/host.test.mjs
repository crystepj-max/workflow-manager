// host.js 单元测试：DSL 校验（Gold-Band 同构规则）/ 编译 / RPC / 角色回退
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'src', 'host.js'), 'utf8')

// ── 加载 host 半（动态包形态：return {...} 闭包体）──────────────────────────
function loadHost(overrides = {}) {
  const handlers = new Map()
  const definedTools = []
  const runs = new Map()
  const events = new Map()
  const ctx = {
    get: (name) => overrides[name] === undefined ? undefined : overrides[name],
    on: (name, fn) => { events.set(name, fn) },
  }
  const harness = {
    handle: (method, fn) => { handlers.set(method, fn) },
    defineTool: (tool) => { definedTools.push(tool); return tool },
    registerTool: () => {},
  }
  const fn = new Function('ctx', 'harness', `${src}`)
  const plugin = fn(ctx, harness)
  plugin.apply(ctx)
  return { handlers, definedTools, events, ctx }
}

const call = async (handlers, method, args) => handlers.get(method)(args)

function baseDsl(overrides = {}) {
  const dsl = {
    id: 't1',
    name: '测试工作流',
    entry: 'a',
    control: { maxRounds: 3 },
    nodes: [
      { id: 'a', profile: 'dispatcher', label: 'A', output: { schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }, successCondition: '$.ok == true' } },
      { id: 'b', profile: 'dev', label: 'B' },
    ],
    edges: [
      { from: 'a', to: 'b', on: 'success' },
      { from: 'b', to: '$end', on: 'success' },
      { from: 'b', to: 'a', on: 'failure' },
    ],
  }
  return { ...dsl, ...overrides }
}

test('内置模板 dev-workflow-2-0 校验与编译通过', async () => {
  const { handlers } = loadHost()
  const list = await call(handlers, 'vwf.workflows.list')
  const builtin = list.find(w => w.id === 'dev-workflow-2-0')
  assert.ok(builtin, '列表包含内置模板')
  const v = await call(handlers, 'vwf.validate', { dsl: builtin.dsl })
  assert.equal(v.ok, true, JSON.stringify(v.errors))
  const c = await call(handlers, 'vwf.compile', { dsl: builtin.dsl })
  assert.equal(c.ok, true)
  assert.ok(c.meta.phases.length === builtin.dsl.nodes.length)
  const s = await call(handlers, 'vwf.script', { dsl: builtin.dsl })
  assert.equal(s.ok, true)
  assert.ok(s.script.includes('AWAITING_HUMAN_'), '人工验收门禁在编译产物中')
  assert.ok(s.script.includes("const MAX_ROUNDS = 9"))
})

test('基础校验：合法 DSL 通过并返回入口归一', async () => {
  const { handlers } = loadHost()
  const dsl = baseDsl({ entry: 'WRONG' })
  const v = await call(handlers, 'vwf.validate', { dsl })
  assert.equal(v.ok, true, JSON.stringify(v.errors))
  assert.equal(v.sanitized.entry, 'a', '唯一无入边节点自动归一为入口')
})

test('多入口节点报错并携带 nodeIds', async () => {
  const { handlers } = loadHost()
  const dsl = baseDsl({
    nodes: [
      { id: 'a', profile: 'dispatcher', label: 'A' },
      { id: 'b', profile: 'dev', label: 'B' },
      { id: 'c', profile: 'dev', label: 'C' },
    ],
    edges: [{ from: 'a', to: '$end', on: 'success' }],
  })
  const v = await call(handlers, 'vwf.validate', { dsl })
  assert.equal(v.ok, false)
  const issue = v.errors.find(e2 => e2.message.indexOf('多个入口') >= 0)
  assert.ok(issue, '存在多入口错误')
  assert.deepEqual(issue.nodeIds, ['a', 'b', 'c'])
})

test('无入口（环形互指）报错', async () => {
  const { handlers } = loadHost()
  const dsl = baseDsl({
    nodes: [
      { id: 'a', profile: 'dispatcher', label: 'A' },
      { id: 'b', profile: 'dev', label: 'B' },
    ],
    edges: [
      { from: 'a', to: 'b', on: 'success' },
      { from: 'b', to: 'a', on: 'success' },
      { from: 'b', to: '$end', on: 'success' },
    ],
  })
  const v = await call(handlers, 'vwf.validate', { dsl })
  assert.equal(v.ok, false)
  assert.ok(v.errors.some(e2 => e2.message.indexOf('没有入边的入口') >= 0 || e2.message.indexOf('存在环') >= 0))
})

test('缺 $end / 悬空节点 / 重复 id / 保留 id / 缺 profile 报错', async () => {
  const { handlers } = loadHost()
  const v = await call(handlers, 'vwf.validate', {
    dsl: {
      id: 't1', entry: 'a',
      nodes: [
        { id: 'a', profile: 'dispatcher' },
        { id: 'a', profile: 'dev' },
        { id: '$end', profile: 'x' },
        { id: 'c', profile: '' },
      ],
      edges: [
        { from: 'a', to: 'c', on: 'success' },
        { from: 'c', to: 'a', on: 'failure' },
      ],
    },
  })
  assert.equal(v.ok, false)
  const msg = (part) => v.errors.filter(e2 => e2.message.indexOf(part) >= 0)
  assert.ok(msg('结束节点').length, '缺 $end 报错')
  assert.ok(msg('没有出边').length, '悬空节点报错（$end 与 a 无出边）')
  assert.ok(msg('ID 重复').length, '重复 id 报错')
  assert.ok(msg('保留节点 ID').length, '保留 id 报错')
  assert.ok(msg('未关联角色').length, '缺 profile 报错')
  assert.ok(v.fieldErrors['node:a:id'] && v.fieldErrors['node:a:id'].length >= 1, 'fieldErrors 定位节点')
})

test('successCondition 路径不在 schema 内报错', async () => {
  const { handlers } = loadHost()
  const dsl = baseDsl({
    nodes: [
      { id: 'a', profile: 'dispatcher', output: { schema: { type: 'object', properties: { ok: { type: 'boolean' } } }, successCondition: '$.missing == true' } },
    ],
    edges: [{ from: 'a', to: '$end', on: 'success' }],
  })
  const v = await call(handlers, 'vwf.validate', { dsl })
  assert.equal(v.ok, false)
  assert.ok(v.errors.some(e2 => e2.message.indexOf('路径未在 JSON 输出约束中声明') >= 0))
  assert.ok(v.fieldErrors['node:a:output.successCondition'], '字段级定位')
})

test('successCondition 格式无效报错', async () => {
  const { handlers } = loadHost()
  const dsl = baseDsl({
    nodes: [{ id: 'a', profile: 'dispatcher', output: { schema: { type: 'object' }, successCondition: 'ok == 1' } }],
    edges: [{ from: 'a', to: '$end', on: 'success' }],
  })
  const v = await call(handlers, 'vwf.validate', { dsl })
  assert.ok(v.errors.some(e2 => e2.message.indexOf('格式无效') >= 0))
})

test('failure 出边最多一条；多 success 出边必须全部带 when', async () => {
  const { handlers } = loadHost()
  const v1 = await call(handlers, 'vwf.validate', {
    dsl: baseDsl({
      edges: [
        { from: 'a', to: 'b', on: 'failure' },
        { from: 'a', to: '$end', on: 'failure' },
        { from: 'b', to: '$end', on: 'success' },
      ],
    }),
  })
  assert.ok(v1.errors.some(e2 => e2.message.indexOf('failure 边') >= 0), '双 failure 报错')

  const v2 = await call(handlers, 'vwf.validate', {
    dsl: baseDsl({
      nodes: [
        { id: 'a', profile: 'dispatcher', output: { schema: { type: 'object', properties: { x: { type: 'boolean' } } } } },
        { id: 'b', profile: 'dev' },
        { id: 'c', profile: 'dev' },
      ],
      edges: [
        { from: 'a', to: 'b', on: 'success' },
        { from: 'a', to: 'c', on: 'success' },
        { from: 'b', to: '$end', on: 'success' },
        { from: 'c', to: '$end', on: 'success' },
      ],
    }),
  })
  assert.ok(v2.errors.some(e2 => e2.message.indexOf('全部带 when') >= 0), '双 success 不带 when 报错')

  const v3 = await call(handlers, 'vwf.validate', {
    dsl: baseDsl({
      nodes: [
        { id: 'a', profile: 'dispatcher', output: { schema: { type: 'object', properties: { x: { type: 'boolean' } } } } },
        { id: 'b', profile: 'dev' },
        { id: 'c', profile: 'dev' },
      ],
      edges: [
        { from: 'a', to: 'b', on: 'success', when: '$.x == true' },
        { from: 'a', to: 'c', on: 'success', when: '$.x == false' },
        { from: 'b', to: '$end', on: 'success' },
        { from: 'c', to: '$end', on: 'success' },
      ],
    }),
  })
  assert.equal(v3.ok, true, JSON.stringify(v3.errors))
})

test('when 只允许 success 边', async () => {
  const { handlers } = loadHost()
  const v = await call(handlers, 'vwf.validate', {
    dsl: baseDsl({
      edges: [
        { from: 'a', to: 'b', on: 'success' },
        { from: 'b', to: '$end', on: 'success' },
        { from: 'b', to: 'a', on: 'failure', when: '$.x == true' },
      ],
    }),
  })
  assert.ok(v.errors.some(e2 => e2.message.indexOf('when 条件只允许用于 success 边') >= 0))
  // sanitize 会剔除 failure 边的 when
  const clean = await call(handlers, 'vwf.validate', {
    dsl: baseDsl({ edges: [{ from: 'a', to: 'b', on: 'success' }, { from: 'b', to: '$end', on: 'success' }, { from: 'b', to: 'a', on: 'failure' }] }),
  })
  assert.equal(clean.sanitized.edges[2].when, undefined)
})

test('maxRounds 非正报错', async () => {
  const { handlers } = loadHost()
  const v = await call(handlers, 'vwf.validate', { dsl: baseDsl({ control: { maxRounds: 0 } }) })
  assert.equal(v.ok, false)
  assert.ok(v.fieldErrors['control:maxRounds'])
})

test('工作流 id 为空 / nodes 为空报错', async () => {
  const { handlers } = loadHost()
  const v1 = await call(handlers, 'vwf.validate', { dsl: baseDsl({ id: '  ' }) })
  assert.ok(v1.errors.some(e2 => e2.message.indexOf('工作流 ID') >= 0))
  const v2 = await call(handlers, 'vwf.validate', { dsl: { id: 'x', nodes: [], edges: [] } })
  assert.ok(v2.errors.some(e2 => e2.message.indexOf('至少需要') >= 0))
})

test('保存/列表/删除 RPC 全链路', async () => {
  const { handlers } = loadHost()
  const dsl = baseDsl()
  const bad = await call(handlers, 'vwf.workflows.save', { dsl: baseDsl({ id: '' }) })
  assert.equal(bad.ok, false)
  const good = await call(handlers, 'vwf.workflows.save', { dsl })
  assert.equal(good.ok, true)
  assert.equal(good.id, 't1')
  const list = await call(handlers, 'vwf.workflows.list')
  assert.ok(list.some(w => w.id === 't1' && !w.builtin))
  await call(handlers, 'vwf.workflows.remove', { id: 't1' })
  const list2 = await call(handlers, 'vwf.workflows.list')
  assert.ok(!list2.some(w => w.id === 't1'))
})

test('vwf.roles 无 fs 服务时回退内置六角色', async () => {
  const { handlers } = loadHost()
  const r = await call(handlers, 'vwf.roles')
  assert.ok(Array.isArray(r.roles))
  assert.ok(r.roles.some(x => x.id === 'dispatcher'))
  assert.ok(r.roles.some(x => x.id === 'closeout'))
})

test('vwf.models 无 llm 服务时返回空 providers', async () => {
  const { handlers } = loadHost()
  const r = await call(handlers, 'vwf.models')
  assert.deepEqual(r, { providers: [] })
})

test('wf_run 工具在 workflowEngine+agents 齐备时注册，执行报未知模板', async () => {
  const { handlers, definedTools, ctx } = loadHost({
    workflowEngine: { start: () => { throw new Error('不应执行') } },
    agents: { requireInitiator: () => ({}) },
  })
  assert.equal(definedTools.length, 1)
  assert.equal(definedTools[0].name, 'wf_run')
  const out = await definedTools[0].execute({ templateId: 'nope', taskId: 't' })
  assert.ok(out.includes('未知工作流'))
  assert.ok(ctx)
})

test('vwf.state 未找到返回 found:false', async () => {
  const { handlers } = loadHost()
  const r = await call(handlers, 'vwf.state', { runId: 'nope' })
  assert.deepEqual(r, { found: false, state: null })
})
