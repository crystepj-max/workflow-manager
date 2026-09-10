// #74 Runtime Preflight Probe 测试（fake fs/llm 服务）：
// 静态失败不发起探针 / 全可用 / 单模型失败分类与错误清洗 / 绑定去重 /
// 短时缓存与强制重新验证 / wf_run 新启探针失败 BLOCKED / BLOCKED 恢复
// （model_overrides → 新 Revision → 重探 → 同一 run_id）/ 恢复缺
// model_overrides 提示 / 探针降级不阻断启动 / 请求形态契约（UAT-02 误报回归）/
// 配置判定（已删除的 Provider/Model）/ 探针内部错误不阻断
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

function makeLlm({ providers = ['p1', 'p2'], models = { p1: ['m1'], p2: ['m2'] }, fail = {}, noStream = false, emptyStop = false, closeEarly = false, internalError = false, modelsThrow = false } = {}) {
  const streams = []
  const llm = {
    listProviders() { return providers.map((id) => ({ id: id, name: id })) },
    async listModels(id) {
      if (modelsThrow) throw new Error('catalog unavailable')
      return (models[id] || []).map((m) => ({ id: m, name: m }))
    },
    stream(opts) {
      streams.push(opts)
      // 真实宿主形态约束（UAT-02 误报回归的根因）：LlmRuntime.stream() 会对
      // message.content 做文件/图片投影（contentHasFile/contentHasImage），
      // 文本模型上 content 不是内容块数组时抛 TypeError「content.some is not a
      // function」，并被归一化为终态 finish(error)。这里复刻该约束：探针一旦
      // 回退到裸字符串 content，全部"可用"用例会立刻失败，而不是继续通过。
      for (const m of opts.messages || []) {
        if (!Array.isArray(m.content)) {
          return (async function* () {
            yield { type: 'finish', reason: { kind: 'error', failure: { message: 'content.some is not a function', code: 'UNKNOWN' } } }
          })()
        }
      }
      if (noStream) return { not: 'iterable' }
      if (internalError) {
        return (async function* () {
          yield { type: 'finish', reason: { kind: 'error', failure: { message: 'content.some is not a function', code: 'UNKNOWN' } } }
        })()
      }
      const key = opts.provider + '\u0000' + opts.model
      const f = fail[key]
      if (f) {
        // 真实宿主形态：LlmRuntime.stream() 把失败归一化为终态 finish（error/aborted + failure）
        const kind = f.kind || 'error'
        const failure = { message: f.message || 'probe fail', code: f.code }
        if (f.status) failure.status = f.status
        return (async function* () { yield { type: 'finish', reason: { kind: kind, failure: failure } } })()
      }
      if (emptyStop) return (async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })()
      if (closeEarly) return (async function* () { yield { type: 'text-delta', index: 0, text: 'partial' } })()
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: 'ok' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
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
  // 请求形态契约（UAT-02）：content 必须是内容块数组，不能是裸字符串——宿主
  // LlmRuntime 会对 content 做投影，字符串会 TypeError 并被归一化为终态失败。
  assert.ok(Array.isArray(llm._streams[0].messages[0].content), 'content 必须是内容块数组')
  assert.deepEqual(llm._streams[0].messages[0].content, [{ type: 'text', text: 'ping' }], '只发最小 ping 内容块')
})

test('vwf.probe：单模型失败分类 + 凭证清洗 + 失败结果不缓存（修复后立即重探生效）', async () => {
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
  assert.equal(r2.cached, false, '失败结果不缓存：立即重探')
  assert.ok(llm._streams.length > callsAfterFirst, '第二次发起真实调用（模拟修复凭证后立即生效）')
  assert.equal(r2.results.find((x) => x.provider === 'p2').status, 'auth_failed')
})

test('vwf.probe：全可用结果 5s 去抖窗口命中缓存，force 强制真实重探', async () => {
  const llm = makeLlm()
  const { handlers } = env({ extra: { llm } })
  const r1 = await call(handlers, 'vwf.probe', { dsl: EDITOR_DSL })
  assert.equal(r1.cached, false)
  const callsAfterFirst = llm._streams.length
  const r2 = await call(handlers, 'vwf.probe', { dsl: EDITOR_DSL })
  assert.equal(r2.cached, true, '去抖窗口内命中缓存')
  assert.equal(llm._streams.length, callsAfterFirst, '缓存命中不发新调用')
  assert.deepEqual(r2.results[0].nodes.sort(), ['a', 'b'], '命中时 nodes 以当前请求回填')
  const r3 = await call(handlers, 'vwf.probe', { dsl: EDITOR_DSL, force: true })
  assert.equal(r3.cached, false, '强制重新验证')
  assert.ok(llm._streams.length > callsAfterFirst, '强刷真实重探')
})

test('vwf.probe：错误分类映射（quota/rate_limit/timeout/model_unavailable/permission_denied/unreachable/真实适配器码）', async () => {
  const llm = makeLlm({
    fail: {
      'p1\u0000quota': { code: 'QUOTA', message: 'insufficient balance' },
      'p1\u0000rl': { code: 'RATE_LIMIT', message: 'too many requests' },
      'p1\u0000to': { code: 'TIMEOUT', message: 'read timeout' },
      'p1\u0000mu': { code: 'UNKNOWN_MODEL', message: 'model not found' },
      'p1\u0000pd': { code: 'AUTH', message: 'forbidden', status: 403 },
      'p1\u0000un': { code: 'TRANSPORT', message: 'fetch failed' },
      'p1\u0000nw': { code: 'NETWORK', message: 'socket hang up' },
      'p1\u0000pv': { code: 'PROVIDER', message: 'provider refused' },
      'p1\u0000q2': { code: 'PROVIDER', message: 'payment required', status: 402 },
      'p1\u0000n4': { code: 'PROVIDER', message: 'no such model', status: 404 },
    },
    providers: ['p1'],
    models: { p1: ['quota', 'rl', 'to', 'mu', 'pd', 'un', 'nw', 'pv', 'q2', 'n4'] },
  })
  const { handlers } = env({ extra: { llm } })
  const mk = (model) => ({ ...EDITOR_DSL, nodes: [{ id: 'a', profile: 'dispatcher', label: 'A', goal: 'g', model: { provider: 'p1', model: model } }], edges: [{ from: 'a', to: '$end', on: 'success' }] })
  const cases = {
    quota: 'quota', rl: 'rate_limit', to: 'timeout', mu: 'model_unavailable', pd: 'permission_denied', un: 'provider_unreachable',
    nw: 'provider_unreachable', pv: 'provider_error', q2: 'quota', n4: 'model_unavailable',
  }
  for (const [model, want] of Object.entries(cases)) {
    const r = await call(handlers, 'vwf.probe', { dsl: mk(model), force: true })
    assert.equal(r.results[0].status, want, model + ' → ' + want)
  }
})

test('vwf.probe：终态 finish 误报回归（UAT-01 实测）——zai 余额不足 / codex 撞额度必须报 quota 而非 available', async () => {
  const llm = makeLlm({
    fail: {
      'p1\u0000zai': { code: 'RATE_LIMIT', message: '429: {"code":"1113","message":"余额不足或无可用资源包,请充值。"}' },
      'p1\u0000zai2': { code: 'RATE_LIMIT', message: '余额不足或无可用资源包,请充值。' },
      'p1\u0000codex': { code: 'PROVIDER', message: 'Codex error: The usage limit has been reached' },
    },
    providers: ['p1'],
    models: { p1: ['zai', 'zai2', 'codex'] },
  })
  const { handlers } = env({ extra: { llm } })
  const mk = (model) => ({ ...EDITOR_DSL, nodes: [{ id: 'a', profile: 'dispatcher', label: 'A', goal: 'g', model: { provider: 'p1', model: model } }], edges: [{ from: 'a', to: '$end', on: 'success' }] })
  for (const model of ['zai', 'zai2', 'codex']) {
    const r = await call(handlers, 'vwf.probe', { dsl: mk(model), force: true })
    assert.equal(r.ok, false, model + ' 不得判可用')
    assert.equal(r.results[0].status, 'quota', model + ' → quota（余额/额度耗尽）')
  }
})

test('vwf.probe：空响应（finish stop 无输出）与流提前关闭不得判可用', async () => {
  const { handlers } = env({ extra: { llm: makeLlm({ emptyStop: true }) } })
  const r1 = await call(handlers, 'vwf.probe', { dsl: EDITOR_DSL })
  assert.equal(r1.ok, false)
  assert.equal(r1.results[0].status, 'provider_error')
  assert.equal(r1.results[0].code, 'EMPTY_RESPONSE')
  const { handlers: h2 } = env({ extra: { llm: makeLlm({ closeEarly: true }) } })
  const r2 = await call(h2, 'vwf.probe', { dsl: EDITOR_DSL, force: true })
  assert.equal(r2.ok, false)
  assert.equal(r2.results[0].status, 'provider_error')
  assert.equal(r2.results[0].code, 'STREAM_CLOSED')
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

test('wf_run 恢复后再失败：新 Revision 保留 + 再次 BLOCKED + 引擎零启动', async () => {
  const llm = makeLlm({ fail: {
    'p2\u0000m2': { code: 'AUTH', message: 'invalid api key', status: 401 },
    'p3\u0000m3': { code: 'QUOTA', message: 'insufficient balance' },
  }, providers: ['p1', 'p2', 'p3'], models: { p1: ['m1'], p2: ['m2'], p3: ['m3'] } })
  const eng = makeEngine()
  const { definedTools, fs } = engineEnv(eng, { extra: { llm } })
  const wfRun = definedTools.find((t) => t.name === 'wf_run')
  await wfRun.execute({ templateId: 'preflight-spec', taskId: 'issue-p2' })
  const out = await wfRun.execute({ templateId: 'preflight-spec', taskId: 'issue-p2', model_overrides: { $default: { provider: 'p3', model: 'm3' } } })
  const payload = JSON.parse(out)
  assert.equal(payload.blocked, true, '恢复后探针仍失败 → 再次 BLOCKED')
  assert.equal(payload.failures[0].status, 'quota')
  assert.equal(eng.starts.length, 0)
  await drain()
  const rec = readLogical(fs, 'issue-p2')
  assert.equal(rec.lifecycle.state, 'BLOCKED')
  assert.equal(rec.snapshots.length, 2, 'Rev 2 保留不被回滚')
  assert.equal(rec.snapshots[1].provider_model.closeout.provider, 'p3')
  assert.equal(rec.snapshots[1].active, true)
})

test('wf_run 无 llm 服务：跳过探针不阻断启动', async () => {
  const eng = makeEngine()
  const { events, definedTools } = engineEnv(eng)
  const wfRun = definedTools.find((t) => t.name === 'wf_run')
  const p = wfRun.execute({ templateId: 'preflight-spec', taskId: 'issue-nl' })
  await until(() => eng.starts.length >= 1, '无 llm 服务不阻断启动')
  events.get('workflow/start')({ id: 'run-1', meta: { name: '探针规格图' } })
  eng.end('run-1', 'completed', { status: 'DONE', results: { explore: { verdict: 'PASS' }, closeout: { result: 'ok' } } })
  events.get('workflow/end')({ id: 'run-1' }, { stopReason: 'completed' })
  await p
})

// ── UAT-02 误报回归（可用模型被判不可用）────────────────────────────────────
// 根因：探针用裸字符串 content 发起请求，宿主 LlmRuntime 对 content 做图片投影
// （contentHasImage → content.some）时抛 TypeError，被归一化为终态 finish(error)，
// 于是所有绑定一律报"其他 Provider 错误"。三层护栏：
//   ① fake llm 复刻宿主形态约束（回退字符串 content 时全部用例立即失败）；
//   ② 断言探针发出的 content 是内容块数组；
//   ③ 配置判定与可用性判定分开，已删除配置的模型报"未配置"而不是"可用"或"其他错误"。

test('vwf.probe：请求形态护栏——fake 按宿主形态拒绝裸字符串 content（回归护栏自证有效）', async () => {
  const llm = makeLlm()
  const { handlers } = env({ extra: { llm } })
  const r = await call(handlers, 'vwf.probe', { dsl: EDITOR_DSL, force: true })
  assert.equal(r.ok, true, '内容块数组形态必须判可用')
  const sent = llm._streams[0].messages[0].content
  assert.ok(Array.isArray(sent) && sent[0] && sent[0].type === 'text', 'content 必须是 [{type:"text"}]')
  // 形态护栏自证：沿同一 fake 直接发字符串 content，必须复现宿主 TypeError 形态
  const iter = llm.stream({ provider: 'p1', model: 'm1', messages: [{ role: 'user', content: 'ping' }], maxTokens: 1 })
  const chunks = []
  for await (const c of iter) chunks.push(c)
  assert.equal(chunks[0].reason.kind, 'error')
  assert.equal(chunks[0].reason.failure.message, 'content.some is not a function')
})

test('vwf.probe：配置判定——已删除的 Provider/Model 报未配置且不发真实调用', async () => {
  const llm = makeLlm({ providers: ['deepseek-official'], models: { 'deepseek-official': ['deepseek-v4.1-flash'] } })
  const { handlers } = env({ extra: { llm } })
  const mk = (provider, model) => ({ ...EDITOR_DSL, nodes: [{ id: 'a', profile: 'dispatcher', label: 'A', goal: 'g', model: { provider: provider, model: model } }], edges: [{ from: 'a', to: '$end', on: 'success' }] })
  // 已删除配置的模型：上游也许仍能应答，但配置已失效 → 必须报未配置（用户口径）
  const goneModel = await call(handlers, 'vwf.probe', { dsl: mk('deepseek-official', 'deepseek-v4-pro') })
  assert.equal(goneModel.ok, false)
  assert.equal(goneModel.results[0].status, 'model_not_configured')
  assert.equal(goneModel.results[0].code, 'MODEL_NOT_CONFIGURED')
  assert.ok(goneModel.results[0].message.includes('deepseek-v4-pro'), '消息点明具体模型')
  assert.deepEqual(goneModel.results[0].nodes, ['a'], '受影响节点回填')
  const goneProvider = await call(handlers, 'vwf.probe', { dsl: mk('kimi-coding', 'k3') })
  assert.equal(goneProvider.results[0].status, 'provider_not_configured')
  assert.equal(goneProvider.results[0].code, 'PROVIDER_NOT_CONFIGURED')
  assert.equal(llm._streams.length, 0, '配置判定不发真实调用')
  // 已配置的绑定仍走真实探针并判可用
  const live = await call(handlers, 'vwf.probe', { dsl: mk('deepseek-official', 'deepseek-v4.1-flash') })
  assert.equal(live.ok, true)
  assert.equal(live.results[0].status, 'available')
  assert.equal(llm._streams.length, 1)
})

test('vwf.probe：模型目录不可读（listModels 抛错）不做配置判定——退回真实探针', async () => {
  const llm = makeLlm({ modelsThrow: true })
  const { handlers } = env({ extra: { llm } })
  const r = await call(handlers, 'vwf.probe', { dsl: EDITOR_DSL })
  assert.equal(r.ok, true, '目录不可读不得据此判不可用')
  assert.equal(r.results[0].status, 'available')
  assert.equal(llm._streams.length, 1, '目录不可读时退回真实探针')
})

test('vwf.probe：探针内部错误单独成类，不伪装成"其他 Provider 错误"', async () => {
  const llm = makeLlm({ internalError: true })
  const { handlers } = env({ extra: { llm } })
  const r = await call(handlers, 'vwf.probe', { dsl: EDITOR_DSL, force: true })
  assert.equal(r.ok, false)
  assert.equal(r.results[0].status, 'probe_internal_error')
  assert.ok(r.results[0].message.includes('content.some is not a function'), '保留宿主原始信息供定位')
})

test('wf_run：探针内部错误（疑似探针缺陷）不阻断启动', async () => {
  const llm = makeLlm({ internalError: true })
  const eng = makeEngine()
  const { events, definedTools } = engineEnv(eng, { extra: { llm } })
  const wfRun = definedTools.find((t) => t.name === 'wf_run')
  const p = wfRun.execute({ templateId: 'preflight-spec', taskId: 'issue-ie' })
  await until(() => eng.starts.length >= 1, '探针内部错误不阻断启动')
  events.get('workflow/start')({ id: 'run-1', meta: { name: '探针规格图' } })
  eng.end('run-1', 'completed', { status: 'DONE', results: { explore: { verdict: 'PASS' }, closeout: { result: 'ok' } } })
  events.get('workflow/end')({ id: 'run-1' }, { stopReason: 'completed' })
  await p
})

test('wf_run：绑定模型已从配置删除 → BLOCKED 且原因为模型未配置', async () => {
  const llm = makeLlm({ providers: ['p1', 'p2'], models: { p1: ['m1'], p2: ['m9'] } })
  const eng = makeEngine()
  const { definedTools, fs } = engineEnv(eng, { extra: { llm } })
  const wfRun = definedTools.find((t) => t.name === 'wf_run')
  const out = await wfRun.execute({ templateId: 'preflight-spec', taskId: 'issue-nc' })
  const payload = JSON.parse(out)
  assert.equal(payload.blocked, true)
  assert.equal(payload.stage, 'preflight_probe')
  assert.equal(payload.failures[0].status, 'model_not_configured')
  assert.equal(eng.starts.length, 0, '配置失效不得启动引擎')
  await drain()
  const rec = readLogical(fs, 'issue-nc')
  assert.equal(rec.lifecycle.state, 'BLOCKED')
  assert.equal(rec.lifecycle.reason.code, 'PROBE_FAILED')
})
