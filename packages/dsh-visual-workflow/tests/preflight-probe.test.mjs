// #74 Runtime Preflight Probe 测试（fake fs/llm 服务）：
// 静态失败不发起探针 / 全可用 / 单模型失败分类与错误清洗 / 绑定去重 /
// 短时缓存与强制重新验证 / wf_run 新启探针失败 BLOCKED / BLOCKED 恢复
// （model_overrides → 新 Revision → 重探 → 同一 logical_run_id）/ 恢复缺
// model_overrides 提示 / 探针降级不阻断启动
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { loadHost } from './helpers/load-host.mjs'
import { REPO, DSH_HOME, makeFs, makeSubprocess, sandboxPolicy, USER_DIR, SKILL_ROOT } from './helpers/fake-services.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const LOGICAL_DIR = DSH_HOME + '/visual-workflow/logical-runs'
const validatorCoreSrc = readFileSync(join(here, '..', '..', '..', 'scripts', 'validate-core.cjs'), 'utf8')

// 两 provider 绑定的规格图：explore=p1/m1、closeout=p2/m2（可注入单点失败）
const SPEC_BLUEPRINT = {
  id: 'preflight-spec', displayName: '探针规格图', description: '', entry: 'explore',
  control: { maxRounds: 9 },
  bindings: { models: { explore: { provider: 'p1', model: 'm1' }, closeout: { provider: 'p2', model: 'm2' } } },
  nodes: [
    { id: 'explore', profile: 'researcher', label: '探索', goal: 'g', output: { schema: { type: 'object', properties: { verdict: { type: 'string', enum: ['PASS'] } }, required: ['verdict'] }, outcomePath: '$.verdict' } },
    { id: 'closeout', profile: 'closeout', label: '收口', goal: 'g', output: { schema: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'] }, completionPath: '$.result' } },
  ],
  edges: [
    { from: 'explore', to: 'closeout', outcome: 'PASS' },
    { from: 'closeout', to: '$end', on: 'success' },
  ],
}

const call = async (handlers, method, args) => handlers.get(method)(args)
const drain = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r)) }
const readLogical = (fs, id) => JSON.parse(fs._files.get(LOGICAL_DIR + '/' + encodeURIComponent(id) + '.json'))

async function until(fn, label, ms = 4000) {
  const t0 = Date.now()
  while (true) {
    if (await fn()) return
    if (Date.now() - t0 > ms) throw new Error('until 超时：' + (label || '条件未满足'))
    await new Promise((r) => setTimeout(r, 5))
  }
}

function makeLlm({ providers = ['p1', 'p2'], models = { p1: ['m1'], p2: ['m2'] }, fail = {}, noStream = false } = {}) {
  const streams = []
  const llm = {
    listProviders() { return providers.map((id) => ({ id: id, name: id })) },
    async listModels(id) { return (models[id] || []).map((m) => ({ id: m, name: m })) },
    stream(opts) {
      streams.push(opts)
      if (noStream) return { not: 'iterable' }
      const f = fail[opts.provider + '\u0000' + opts.model]
      if (f) {
        const e = new Error(f.message || 'probe fail')
        e.code = f.code
        if (f.status) e.failure = { status: f.status }
        return (async function* () { throw e })()
      }
      return (async function* () { yield { type: 'text', text: 'ok' } })()
    },
    _streams: streams,
  }
  return llm
}

function env({ seed = {}, extra = {}, subprocess = null } = {}) {
  const base = {
    [REPO + '/scripts/validate-core.cjs']: validatorCoreSrc,
    [USER_DIR + '/preflight-spec.json']: JSON.stringify(SPEC_BLUEPRINT, null, 2) + '\n',
    [SKILL_ROOT + '/preflight-spec/script.mjs']: '//MOCK-SCRIPT',
  }
  Object.assign(base, seed)
  const fs = makeFs(base)
  const sub = subprocess || makeSubprocess({ fs, compileScript: '//MOCK-SCRIPT' })
  const { handlers, definedTools, events } = loadHost({ fs, subprocess: sub, sandboxPolicy, ...extra })
  return { handlers, definedTools, events, fs, sub }
}

function makeEngine(idPrefix = 'run-') {
  const pending = []
  return {
    starts: [],
    start(req) {
      this.starts.push(req)
      const id = idPrefix + this.starts.length
      let release = () => {}
      const result = new Promise((r) => { release = r })
      pending.push({ id, release })
      return { id, result }
    },
    end(id, stopReason, value) {
      const p = pending.find((x) => x.id === id)
      if (p) p.release({ stopReason, value: value === undefined ? null : value, agentsStarted: 0 })
    },
  }
}

function engineEnv(eng, opts = {}) {
  return env({
    extra: { workflowEngine: eng, agents: { requireInitiator: () => ({}), currentInitiator: () => null }, ...(opts.extra || {}) },
    seed: opts.seed,
    subprocess: opts.subprocess,
  })
}

const EDITOR_DSL = {
  id: 't1', name: '编辑器图', entry: 'a', control: { maxRounds: 3 },
  nodes: [
    { id: 'a', profile: 'dispatcher', label: 'A', goal: '目标A', model: { provider: 'p1', model: 'm1' }, output: { schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }, successCondition: '$.ok == true' } },
    { id: 'b', profile: 'dev', label: 'B', goal: '目标B', model: { provider: 'p1', model: 'm1' } },
  ],
  edges: [
    { from: 'a', to: 'b', on: 'success' },
    { from: 'a', to: '$end', on: 'failure' },
    { from: 'b', to: '$end', on: 'success' },
    { from: 'b', to: 'a', on: 'failure' },
  ],
}

test('vwf.probe：静态失败不发起探针（llm.stream 零调用）', async () => {
  const llm = makeLlm()
  const { handlers } = env({ extra: { llm } })
  const r = await call(handlers, 'vwf.probe', { dsl: { id: 'bad', name: 'bad', nodes: [], edges: [] } })
  assert.equal(r.ok, false)
  assert.equal(r.stage, 'static')
  assert.equal(llm._streams.length, 0, '静态失败必须不发起任何真实调用')
})

test('vwf.probe：全可用 + 同绑定去重（两节点只探一次）', async () => {
  const llm = makeLlm()
  const { handlers } = env({ extra: { llm } })
  const r = await call(handlers, 'vwf.probe', { dsl: EDITOR_DSL })
  assert.equal(r.ok, true, JSON.stringify(r.results))
  assert.equal(r.stage, 'probe')
  assert.equal(r.results.length, 1, 'p1/m1 相同绑定只探一次')
  assert.equal(r.results[0].status, 'available')
  assert.deepEqual(r.results[0].nodes.sort(), ['a', 'b'], '受影响节点回填')
  assert.equal(llm._streams.length, 1)
  assert.equal(llm._streams[0].maxTokens, 1, '最小真实调用')
  assert.equal(llm._streams[0].messages.length, 1)
  assert.equal(llm._streams[0].messages[0].content, 'ping', '不携带业务正文')
})

test('vwf.probe：单模型失败分类 + 凭证清洗 + 缓存与强制重新验证', async () => {
  const llm = makeLlm({ fail: { 'p2\u0000m2': { code: 'AUTH', message: 'invalid api key: sk-secret-abc123456789', status: 401 } } })
  const { handlers } = env({ extra: { llm } })
  const dsl = JSON.parse(JSON.stringify(SPEC_BLUEPRINT))
  dsl.nodes[0].model = { provider: 'p1', model: 'm1' }
  dsl.nodes[1].model = { provider: 'p2', model: 'm2' }
  const r1 = await call(handlers, 'vwf.probe', { dsl: dsl })
  assert.equal(r1.ok, false)
  assert.equal(r1.results.length, 2)
  const bad = r1.results.find((x) => x.provider === 'p2')
  assert.equal(bad.status, 'auth_failed')
  assert.equal(bad.code, 'AUTH')
  assert.equal(bad.nodes.sort().join(','), 'closeout', '受影响节点')
  assert.ok(!bad.message.includes('sk-secret-abc123456789'), '凭证必须清洗')
  assert.equal(r1.results.find((x) => x.provider === 'p1').status, 'available')
  const callsAfterFirst = llm._streams.length
  const r2 = await call(handlers, 'vwf.probe', { dsl: dsl })
  assert.equal(r2.cached, true, '短时缓存命中')
  assert.equal(llm._streams.length, callsAfterFirst, '缓存命中不发新调用')
  const r3 = await call(handlers, 'vwf.probe', { dsl: dsl, force: true })
  assert.equal(r3.cached, false, '强制重新验证')
  assert.ok(llm._streams.length > callsAfterFirst, '强刷真实重探')
})

test('vwf.probe：错误分类映射（quota/rate_limit/timeout/model_unavailable/permission_denied/unreachable）', async () => {
  const llm = makeLlm({
    fail: {
      'p1\u0000quota': { code: 'QUOTA', message: 'insufficient balance' },
      'p1\u0000rl': { code: 'RATE_LIMIT', message: 'too many requests' },
      'p1\u0000to': { code: 'TIMEOUT', message: 'read timeout' },
      'p1\u0000mu': { code: 'UNKNOWN_MODEL', message: 'model not found' },
      'p1\u0000pd': { code: 'AUTH', message: 'forbidden', status: 403 },
      'p1\u0000un': { code: 'TRANSPORT', message: 'fetch failed' },
    },
    providers: ['p1'],
    models: { p1: ['quota', 'rl', 'to', 'mu', 'pd', 'un'] },
  })
  const { handlers } = env({ extra: { llm } })
  const mk = (model) => ({ ...EDITOR_DSL, nodes: [{ id: 'a', profile: 'dispatcher', label: 'A', goal: 'g', model: { provider: 'p1', model: model } }], edges: [{ from: 'a', to: '$end', on: 'success' }] })
  const cases = { quota: 'quota', rl: 'rate_limit', to: 'timeout', mu: 'model_unavailable', pd: 'permission_denied', un: 'provider_unreachable' }
  for (const [model, want] of Object.entries(cases)) {
    const r = await call(handlers, 'vwf.probe', { dsl: mk(model), force: true })
    assert.equal(r.results[0].status, want, model + ' → ' + want)
  }
})

test('wf_run 新启：探针失败 → BLOCKED + 引擎不启动 + reason 结构化', async () => {
  const llm = makeLlm({ fail: { 'p2\u0000m2': { code: 'AUTH', message: 'invalid api key sk-zz9988776655', status: 401 } } })
  const eng = makeEngine()
  const { events, definedTools, fs } = engineEnv(eng, { extra: { llm } })
  const wfRun = definedTools.find((t) => t.name === 'wf_run')
  const out = await wfRun.execute({ templateId: 'preflight-spec', taskId: 'issue-pb' })
  const payload = JSON.parse(out)
  assert.equal(payload.blocked, true)
  assert.equal(payload.stage, 'preflight_probe')
  assert.equal(payload.logical_run_id, 'issue-pb')
  assert.equal(payload.failures.length, 1)
  assert.equal(payload.failures[0].status, 'auth_failed')
  assert.ok(!out.includes('sk-zz9988776655'), '回执不含凭证明文')
  assert.equal(eng.starts.length, 0, '探针失败不得启动引擎')
  await drain()
  const rec = readLogical(fs, 'issue-pb')
  assert.equal(rec.lifecycle.state, 'BLOCKED')
  assert.equal(rec.lifecycle.reason.code, 'PROBE_FAILED')
  assert.ok(!rec.terminal, 'BLOCKED 非终态')
  await drain()
})

test('wf_run BLOCKED 恢复：model_overrides → 新 Revision → 重探通过 → 同一 logical_run_id', async () => {
  const llm = makeLlm({ fail: { 'p2\u0000m2': { code: 'AUTH', message: 'invalid api key', status: 401 } } })
  const eng = makeEngine()
  const { events, definedTools, fs } = engineEnv(eng, { extra: { llm } })
  const wfRun = definedTools.find((t) => t.name === 'wf_run')
  await wfRun.execute({ templateId: 'preflight-spec', taskId: 'issue-pr' })
  assert.equal(eng.starts.length, 0)
  const p = wfRun.execute({ templateId: 'preflight-spec', taskId: 'issue-pr', model_overrides: { $default: { provider: 'p1', model: 'm1' } } })
  await until(() => eng.starts.length >= 1, '恢复后启动')
  events.get('workflow/start')({ id: 'run-1', meta: { name: '探针规格图' } })
  eng.end('run-1', 'completed', { status: 'DONE', results: { explore: { verdict: 'PASS' }, closeout: { result: 'ok' } } })
  events.get('workflow/end')({ id: 'run-1' }, { stopReason: 'completed' })
  await p
  await drain()
  const rec = readLogical(fs, 'issue-pr')
  assert.equal(rec.logical_run_id, 'issue-pr', '恢复保持同一 logical_run_id')
  assert.equal(rec.lifecycle.state, 'COMPLETED')
  assert.equal(rec.snapshots.length, 2, '恢复产生新 Revision')
  assert.equal(rec.snapshots[1].revision, 2)
  assert.equal(rec.snapshots[1].active, true)
  assert.equal(rec.snapshots[1].provider_model.closeout.provider, 'p1', '覆盖生效')
  assert.equal(rec.snapshots[0].active, false, 'Rev 1 保留不覆盖')
  assert.equal(rec.segments[0].trigger, 'model_recovery', '恢复段标记')
  assert.equal(eng.starts[0].args.model_overrides.closeout.provider, 'p1', '执行使用合并后的绑定')
})

test('wf_run BLOCKED 恢复缺 model_overrides：提示且不启动', async () => {
  const llm = makeLlm({ fail: { 'p2\u0000m2': { code: 'AUTH', message: 'invalid api key', status: 401 } } })
  const eng = makeEngine()
  const { definedTools, fs } = engineEnv(eng, { extra: { llm } })
  const wfRun = definedTools.find((t) => t.name === 'wf_run')
  await wfRun.execute({ templateId: 'preflight-spec', taskId: 'issue-pm' })
  const out = await wfRun.execute({ templateId: 'preflight-spec', taskId: 'issue-pm' })
  assert.ok(out.includes('BLOCKED') && out.includes('model_overrides'), '指引修改 Provider/Model')
  assert.equal(eng.starts.length, 0)
  await drain()
  const rec = readLogical(fs, 'issue-pm')
  assert.equal(rec.lifecycle.state, 'BLOCKED', '保持 BLOCKED 不误标 FAILED')
  assert.equal(rec.snapshots.length, 1, '未产生新 Revision')
})

test('wf_run：探针降级（llm 无生成流能力）不阻断启动', async () => {
  const llm = makeLlm({ noStream: true })
  const eng = makeEngine()
  const { events, definedTools } = engineEnv(eng, { extra: { llm } })
  const wfRun = definedTools.find((t) => t.name === 'wf_run')
  const p = wfRun.execute({ templateId: 'preflight-spec', taskId: 'issue-dg' })
  await until(() => eng.starts.length >= 1, '降级不阻断启动')
  events.get('workflow/start')({ id: 'run-1', meta: { name: '探针规格图' } })
  eng.end('run-1', 'completed', { status: 'DONE', results: { explore: { verdict: 'PASS' }, closeout: { result: 'ok' } } })
  events.get('workflow/end')({ id: 'run-1' }, { stopReason: 'completed' })
  await p
})

test('wf_run 新启全可用：探针通过后正常启动', async () => {
  const llm = makeLlm()
  const eng = makeEngine()
  const { events, definedTools, fs } = engineEnv(eng, { extra: { llm } })
  const wfRun = definedTools.find((t) => t.name === 'wf_run')
  const p = wfRun.execute({ templateId: 'preflight-spec', taskId: 'issue-ok' })
  await until(() => eng.starts.length >= 1, '启动')
  events.get('workflow/start')({ id: 'run-1', meta: { name: '探针规格图' } })
  eng.end('run-1', 'completed', { status: 'DONE', results: { explore: { verdict: 'PASS' }, closeout: { result: 'ok' } } })
  events.get('workflow/end')({ id: 'run-1' }, { stopReason: 'completed' })
  await p
  await drain()
  const rec = readLogical(fs, 'issue-ok')
  assert.equal(rec.lifecycle.state, 'COMPLETED')
  assert.equal(rec.snapshots.length, 1)
  assert.equal(llm._streams.length, 2, '两个不同绑定各探一次')
})
