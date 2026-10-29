// WFM-67：真实 AgentRegistry API + 假引擎/文件边界；不将夹具当作产品 E2E。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { loadHost } from './helpers/load-host.mjs'
import { REPO, DSH_HOME, USER_DIR, SKILL_ROOT, makeFs, makeIsolatedSubprocess, sandboxPolicy } from './helpers/fake-services.mjs'

const require = createRequire(new URL('../package.json', import.meta.url))
const { AgentRegistry } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-agent')))
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')))
const BLUEPRINT = {
  id: 'ui-resume-spec', displayName: '界面续跑规格图', entry: 'review', control: { maxRounds: 2 },
  bindings: { models: { review: { provider: 'p', model: 'm1' }, closeout: { provider: 'p', model: 'm1' } } },
  nodes: [
    { id: 'review', profile: 'review', goal: 'review', output: { schema: { type: 'object', properties: { verdict: { type: 'string', enum: ['CONFIRM'] } }, required: ['verdict'] }, outcomePath: '$.verdict' } },
    { id: 'closeout', profile: 'closeout', goal: 'closeout', output: { schema: { type: 'object', properties: { completion_type: { type: 'string' } }, required: ['completion_type'] }, completionPath: '$.completion_type' } },
  ],
  edges: [{ from: 'review', to: 'closeout', outcome: 'CONFIRM' }, { from: 'closeout', to: '$end', on: 'success' }],
}
const waitValue = { status: 'WAITING_HUMAN', node: 'review', reason: 'ESCALATED_DECISION', decision_id: 'd1', decision_package: { why: '请确认', options: [{ id: 'USER_ACCEPTED' }, { id: 'STOP' }], subsequent_effects: {} }, results: { review: { verdict: 'CONFIRM' } } }
const doneValue = { status: 'DONE', results: { review: { verdict: 'CONFIRM' }, closeout: { completion_type: 'USER_ACCEPTED' } }, completion: { type: 'USER_ACCEPTED', node: 'closeout', path: '$.completion_type' } }
const drain = async () => { for (let i = 0; i < 4; i++) await new Promise(r => setImmediate(r)) }
async function until(fn) { for (let i = 0; i < 800; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 5)) } throw Error('未收到启动回执') }

async function env(t, { seed = {} } = {}) {
  const ctx = new Context()
  const fiber = await ctx.plugin(AgentRegistry)
  let owner = { id: 'original-session', ctx, session: { id: 'original-session', header: { cwd: REPO } } }
  let detach = ctx.agents.enter(owner, undefined)
  const pending = new Map()
  let startError = null
  const engine = { starts: [], start(req) { if (startError) { const error = startError; startError = null; throw error }; this.starts.push(req); const id = 'ui-run-' + this.starts.length; const result = new Promise(resolve => pending.set(id, resolve)); return { id, result } } }
  const fs = makeFs({ [USER_DIR + '/ui-resume-spec.json']: JSON.stringify(BLUEPRINT), [SKILL_ROOT + '/ui-resume-spec/script.mjs']: '//FROZEN-UI-SCRIPT', ...seed })
  const streamModels = []
  let failModel = ''
  const llm = { listProviders: () => [{ id: 'p' }], listModels: () => [{ id: 'm1' }, { id: 'm2' }], stream(opts) { streamModels.push(opts.model); return (async function* () { if (opts.model === failModel) yield { type: 'finish', reason: { kind: 'error', failure: { code: 'MODEL_NOT_FOUND', message: 'model unavailable' } } }; else { yield { type: 'text-delta', index: 0, text: 'ok' }; yield { type: 'finish', reason: { kind: 'stop' } } } })() } }
  const sub = makeIsolatedSubprocess({ fs, compileScript: '//FROZEN-UI-SCRIPT' })
  let holdContext = false
  const heldContexts = []
  const spawn = sub.spawn.bind(sub)
  sub.spawn = spec => {
    const handle = spawn(spec)
    if (holdContext && spec.argv[2] === 'context') {
      const done = handle.done
      handle.done = new Promise(resolve => heldContexts.push(() => resolve(done)))
    }
    return handle
  }
  const releaseContexts = () => { holdContext = false; heldContexts.splice(0).forEach(release => release()) }
  const services = { fs, subprocess: sub, sandboxPolicy, agents: ctx.agents, agentPresets: { serviceFor(agent, name) { assert.equal(agent, owner, '只能使用服务器解析的原 Agent'); return name === 'workflowEngine' ? engine : undefined } }, llm }
  let host = loadHost(services)
  const read = (id = 'task-ui') => JSON.parse(fs._files.get(DSH_HOME + '/visual-workflow/logical-runs/' + encodeURIComponent(id) + '.json'))
  const settle = (id, value) => { const resolve = pending.get(id); if (!resolve) return; pending.delete(id); resolve({ stopReason: 'completed', value, agentsStarted: 0 }); host.events.get('workflow/end')({ id }, { stopReason: 'completed' }) }
  t.after(async () => { releaseContexts(); for (const id of [...pending.keys()]) settle(id, doneValue); await drain(); detach(); await fiber.dispose() })
  return { fs, engine, owner, registry: ctx.agents, read, settle, streamModels, setFail: m => { failModel = m }, failStartOnce: message => { startError = Error(message) },
    async start(value = waitValue) { const run = host.definedTools.find(t => t.name === 'wf_run'); const p = ctx.agents.withInitiator(owner, () => run.execute({ templateId: 'ui-resume-spec', taskId: 'task-ui', baseBranch: 'frozen-base' })); await until(() => engine.starts.length === 1); settle('ui-run-1', value); await p; await drain(); return read() },
    holdContext: () => { holdContext = true }, contextHeld: () => heldContexts.length > 0, releaseContexts,
    snapshot: async () => (await host.handlers.get('vwf.logicalRuns.get')({ logical_run_id: 'task-ui' })).record,
    list: () => host.handlers.get('vwf.runs.list')({}),
    call: a => host.handlers.get('vwf.run.control')({ logical_run_id: 'task-ui', run_id: 'ui-run-1', snapshot_revision: 1, ...a }),
    tool: (a, context) => ctx.agents.withInitiator(owner, () => host.definedTools.find(t => t.name === 'wf_run').execute(a, context)),
    coldOwner() { detach(); owner = { ...owner, session: { ...owner.session, header: { ...owner.session.header } } }; detach = ctx.agents.enter(owner, undefined); return owner },
    detachOwner() { detach(); detach = () => {} }, restoreOwner() { detach = ctx.agents.enter(owner, undefined) },
    restart() { host = loadHost(services) },
  }
}

test('WFM-67 界面决定：无 ambient Agent，解析真实原会话；启动回执后同 Run 追加段并保存理由来源', async t => {
  const h = await env(t); const before = await h.start()
  assert.equal(h.registry.currentInitiator(), undefined)
  const out = await h.call({ action: 'decision', decision_id: 'd1', user_choice: 'USER_ACCEPTED', reason: '材料清楚，接受' })
  assert.equal(out.ok, true, JSON.stringify(out)); assert.equal(out.logical_run_id, 'task-ui'); assert.equal(out.run_id, 'ui-run-2')
  assert.equal(h.engine.starts.length, 2); const req = h.engine.starts[1]
  assert.equal(req.parent, h.owner); assert.equal(req.script, '//FROZEN-UI-SCRIPT'); assert.equal(req.args.baseBranch, 'frozen-base')
  assert.equal(req.args.decision_id, 'd1'); assert.equal(req.args.feedback, '材料清楚，接受'); assert.equal(req.args.requireIsolatedNodes, true)
  assert.ok(req.args.routes); assert.equal(req.args.results.review.verdict, 'CONFIRM')
  await drain(); const running = h.read(); assert.equal(running.logical_run_id, before.logical_run_id); assert.equal(running.segments.length, 2)
  assert.equal(running.segments[1].initiator.source, 'ui'); assert.equal(running.segments[1].initiator.execution_session_id, 'original-session')
  assert.deepEqual((await h.snapshot()).segments[1].initiator, running.segments[1].initiator, 'WFM-81 RPC 投影须保留 WFM-67 UI 来源')
  assert.equal(running.human_decisions.at(-1).reason, '材料清楚，接受'); assert.equal(running.human_decisions.at(-1).initiator.source, 'ui')
  h.settle('ui-run-2', doneValue); await drain(); assert.equal(h.read().lifecycle.state, 'COMPLETED'); assert.equal(h.read().business_outcomes.review.outcome, 'CONFIRM')
})

test('WFM-67/70 公开工具第二参数不能伪造 UI 来源或启动回执', async t => {
  const h = await env(t)
  let started = 0
  const pending = h.tool({ templateId: 'ui-resume-spec', taskId: 'task-ui' }, {
    initiator: { source: 'ui', execution_session_id: 'invented' }, onStarted() { started++ },
  })
  await until(() => h.engine.starts.length === 1)
  h.settle('ui-run-1', doneValue); await pending; await drain()
  assert.equal(started, 0)
  assert.equal(h.read().segments[0].initiator, undefined)
  assert.equal(h.read().snapshots[0].config.execution_session_id, 'original-session')
})

test('WFM-67 BLOCKED 改模型：追加修订 → 真探针 → 原 Logical Run 执行', async t => {
  const h = await env(t); h.setFail('m1')
  const run = h.tool({ templateId: 'ui-resume-spec', taskId: 'task-ui' }); await run; await drain()
  assert.equal(h.read().lifecycle.state, 'BLOCKED'); assert.equal(h.engine.starts.length, 0)
  const rows = (await h.list()).runs; assert.equal(rows.length, 1); assert.equal(rows[0].id, 'logical:task-ui'); assert.equal(rows[0].execution_not_started, true); assert.equal(rows[0].segment_count, 0)
  h.setFail(''); const out = await h.call({ action: 'recover', run_id: '', model_overrides: { $default: { provider: 'p', model: 'm2' } } })
  assert.equal(out.ok, true, JSON.stringify(out)); assert.equal(h.engine.starts.length, 1)
  assert.equal((await h.list()).runs.length, 1, '新段出现后不再重复展示尚未启动行')
  assert.ok(h.streamModels.includes('m2')); const req = h.engine.starts[0]
  assert.equal(req.args.model_overrides.review.model, 'm2'); assert.equal(req.parent, h.owner)
  await drain(); assert.equal(h.read().snapshots.length, 2); assert.equal(h.read().snapshots[0].provider_model.review.model, 'm1')
  assert.equal(h.read().segments[0].trigger, 'model_recovery'); assert.equal(h.read().segments[0].initiator.source, 'ui')
  h.settle('ui-run-1', doneValue); await drain()
})

test('WFM-67 失败：精确原 Agent 退出保持现场；原 Agent 返回后可重试', async t => {
  const h = await env(t); await h.start(); h.detachOwner(); const before = h.read()
  const bad = await h.call({ action: 'decision', decision_id: 'd1', user_choice: 'STOP', initiator: { source: 'session', agent_id: 'invented' } })
  assert.equal(bad.ok, false); assert.equal(h.engine.starts.length, 1); assert.deepEqual(h.read(), before)
  h.restoreOwner(); const out = await h.call({ action: 'decision', decision_id: 'd1', user_choice: 'STOP' }); assert.equal(out.ok, true, JSON.stringify(out)); assert.equal(h.engine.starts.length, 2)
  h.settle('ui-run-2', { status: 'STOPPED' }); await drain()
})

test('WFM-67 状态/decision_id/选项/快照过期拒绝，不产生修订或执行段', async t => {
  const h = await env(t); await h.start(); const before = h.read()
  for (const input of [
    { decision_id: 'old', user_choice: 'STOP' }, { decision_id: 'd1', user_choice: 'invented' },
    { decision_id: 'd1', user_choice: 'STOP', snapshot_revision: 99 }, { decision_id: 'd1', user_choice: 'STOP', run_id: 'old' },
    { action: 'recover', model_overrides: { $default: { model: 'm2' } } },
  ]) { const out = await h.call({ action: 'decision', ...input }); assert.equal(out.ok, false, JSON.stringify(out)) }
  assert.equal(h.engine.starts.length, 1); assert.deepEqual(h.read(), before)
})

test('WFM-67 并发/重复提交：同一次 UI 决定仅新建一个段；推进后再次提交明确拒绝', async t => {
  const h = await env(t); await h.start()
  const args = { action: 'decision', decision_id: 'd1', user_choice: 'STOP' }
  const out = await Promise.all([h.call(args), h.call(args)])
  assert.equal(out.filter(r => r.ok).length, 1, JSON.stringify(out)); assert.equal(h.engine.starts.length, 2)
  assert.equal((await h.call(args)).ok, false); h.settle('ui-run-2', { status: 'STOPPED' }); await drain()
  assert.equal((await h.call(args)).ok, false); assert.equal(h.engine.starts.length, 2)
})

test('WFM-67 宿主重载：保留冻结执行会话 ID，重新解析真实 live Agent', async t => {
  const h = await env(t); await h.start(); h.restart()
  const out = await h.call({ action: 'decision', decision_id: 'd1', user_choice: 'STOP' }); assert.equal(out.ok, true, JSON.stringify(out))
  h.settle('ui-run-2', { status: 'STOPPED' }); await drain()
})


test('WFM-67 引擎未启动失败：保留人工等待与失败事实，解除锁后原 Run 可重试', async t => {
  const h = await env(t); await h.start(); h.failStartOnce('模拟启动通道失败')
  const input = { action: 'decision', decision_id: 'd1', user_choice: 'STOP' }
  const failed = await h.call(input); assert.equal(failed.ok, false); assert.match(failed.errors[0].message, /模拟启动通道失败/)
  await drain(); const record = h.read(); assert.equal(record.lifecycle.state, 'WAITING_HUMAN'); assert.equal(record.segments.length, 1)
  assert.ok(record.control_events.some(e => e.type === 'ui_resume_failed' && /模拟启动通道失败/.test(e.message)))
  assert.equal(Object.keys(record.consumed_decisions).length, 0)
  const retry = await h.call(input); assert.equal(retry.ok, true, JSON.stringify(retry)); assert.equal(h.engine.starts.length, 2)
  h.settle('ui-run-2', { status: 'STOPPED' }); await drain()
})

test('WFM-67 旧记录缺会话归属：不猜测、无修订、不派生；仅返回明确兼容限制', async t => {
  const h = await env(t); await h.start(); const path = DSH_HOME + '/visual-workflow/logical-runs/task-ui.json'
  const old = h.read(); delete old.snapshots[0].config.execution_session_id; h.fs._files.set(path, JSON.stringify(old)); h.restart()
  const before = JSON.stringify(old)
  const result = await h.call({ action: 'decision', decision_id: 'd1', user_choice: 'STOP', execution_session_id: 'original-session' })
  assert.equal(result.ok, false); assert.match(result.errors[0].message, /缺少.*会话归属/); assert.equal(h.engine.starts.length, 1)
  assert.equal(JSON.stringify(h.read()), before)
})

test('WFM-67 UI 决定续跑探针失败：不消费决定，改模型恢复保留真实选择和理由', async t => {
  const h = await env(t); await h.start(); h.setFail('m1')
  const failed = await h.call({ action: 'decision', decision_id: 'd1', user_choice: 'USER_ACCEPTED', reason: '接受当前成果' })
  assert.equal(failed.ok, false); assert.match(failed.errors[0].message, /model unavailable/); await drain()
  assert.equal(h.read().lifecycle.state, 'BLOCKED'); assert.equal(h.read().segments.length, 1); assert.equal(h.engine.starts.length, 1)
  h.setFail('')
  const result = await h.call({ action: 'recover', model_overrides: { $default: { provider: 'p', model: 'm2' } } })
  assert.equal(result.ok, true, JSON.stringify(result)); const req = h.engine.starts[1]
  assert.equal(req.args.decision_id, 'd1'); assert.equal(req.args.user_choice, 'USER_ACCEPTED'); assert.equal(req.args.feedback, '接受当前成果')
  assert.equal(req.args.model_overrides.review.model, 'm2'); h.settle('ui-run-2', doneValue); await drain()
})


test('WFM-67 原会话冷恢复后的新 Agent 实例：按冻结 ID 精确解析，不复用已退出 parent', async t => {
  const h = await env(t); await h.start(); const original = h.owner; const reloaded = h.coldOwner(); h.restart()
  assert.notEqual(reloaded, original); assert.equal(reloaded.session.id, original.session.id)
  const result = await h.call({ action: 'decision', decision_id: 'd1', user_choice: 'STOP' }); assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(h.engine.starts[1].parent, reloaded); assert.notEqual(h.engine.starts[1].parent, original)
  h.settle('ui-run-2', { status: 'STOPPED' }); await drain()
})

test('WFM-67 工具调用不能通过入参伪装为界面来源', async t => {
  const h = await env(t); await h.start()
  const p = h.tool({ templateId: 'ui-resume-spec', taskId: 'task-ui', decision_id: 'd1', user_choice: 'STOP', initiator: { source: 'ui' }, ui: { source: 'ui' } })
  await until(() => h.engine.starts.length === 2)
  await drain(); assert.equal(h.read().segments[1].initiator, undefined)
  assert.ok(!h.read().control_events.some(e => e.type === 'ui_resume_requested'))
  h.settle('ui-run-2', { status: 'STOPPED' }); await p; await drain()
})


test('WFM-67 原任务的派生 Run 仍保留业务 taskId；引擎拿到真实 Logical Run 身份', async t => {
  const h = await env(t); await h.start(doneValue)
  const p = h.tool({ templateId: 'ui-resume-spec', taskId: 'task-ui' })
  await until(() => h.engine.starts.length === 2); h.settle('ui-run-2', waitValue); await p; await drain()
  const rec = h.read('task-ui#2'); assert.equal(rec.derived_from, 'task-ui')
  const out = await h.call({ logical_run_id: 'task-ui#2', run_id: 'ui-run-2', action: 'decision', decision_id: 'd1', user_choice: 'STOP' })
  assert.equal(out.ok, true, JSON.stringify(out)); assert.equal(out.logical_run_id, 'task-ui#2')
  assert.equal(h.engine.starts[2].args.taskId, 'task-ui'); assert.equal(h.engine.starts[2].args.logical_run_id, 'task-ui#2')
  assert.equal(h.engine.starts[2].args.decision_ref.logical_run_id, 'task-ui#2')
  h.settle('ui-run-3', { status: 'STOPPED' }); await drain()
})


test('WFM-67 原段后处理未收束：即使暂见 WAITING_HUMAN，也不能从 UI 抢先续跑', async t => {
  const h = await env(t)
  const p = h.tool({ templateId: 'ui-resume-spec', taskId: 'task-ui' })
  await until(() => h.engine.starts.length === 1)
  h.holdContext(); h.settle('ui-run-1', waitValue)
  await until(() => h.contextHeld())
  assert.equal((await h.snapshot()).lifecycle.state, 'WAITING_HUMAN')
  const input = { action: 'decision', decision_id: 'd1', user_choice: 'STOP' }
  const premature = await h.call(input)
  assert.equal(premature.ok, false, '必须等原段完整后处理，而非只看过早的等待状态')
  assert.equal(h.engine.starts.length, 1)
  h.releaseContexts(); await p; await drain()
  const retry = await h.call(input); assert.equal(retry.ok, true, JSON.stringify(retry)); assert.equal(h.engine.starts.length, 2)
  h.settle('ui-run-2', { status: 'STOPPED' }); await drain()
})


test('WFM-67 模型恢复参数与不可原样恢复状态拒绝；不通过字段夹带更改归属或入口', async t => {
  const h = await env(t)
  await h.start({ status: 'BLOCKED', node: 'review', results: { review: { verdict: 'CONFIRM' } }, termination: { business_outcome: 'CONFIRM', lifecycle: 'BLOCKED', reason_code: 'NEEDS_REDEFINE', resume_node: 'review', resumable: false } })
  const before = h.read()
  for (const model_overrides of [{}, { unknown: { model: 'm2' } }, { review: { model: 123 } }, { review: { model: 'm2', script: 'invented' } }, { review: { model: 'm2' } }]) {
    const result = await h.call({ action: 'recover', model_overrides, entry: 'closeout', execution_session_id: 'another' })
    assert.equal(result.ok, false, JSON.stringify(result))
  }
  assert.equal(h.engine.starts.length, 1); assert.deepEqual(h.read(), before)
})

test('WFM-67 运行创建后的模板删除不改变冻结续跑；UI 正在执行时工具不能插入另一段', async t => {
  const h = await env(t); await h.start()
  h.fs._files.delete(USER_DIR + '/ui-resume-spec.json')
  const result = await h.call({ action: 'decision', decision_id: 'd1', user_choice: 'STOP' })
  assert.equal(result.ok, true, JSON.stringify(result))
  const concurrent = await h.tool({ dsl: BLUEPRINT, taskId: 'task-ui', decision_id: 'd1', user_choice: 'STOP' })
  assert.match(concurrent, /界面续跑正在处理/); assert.equal(h.engine.starts.length, 2)
  assert.equal(h.engine.starts[1].script, '//FROZEN-UI-SCRIPT')
  h.settle('ui-run-2', { status: 'STOPPED' }); await drain()
})

test('WFM-67 未起段模型受阻投影与 WFM-81 unavailable 投影互斥，不伪造段', () => {
  const { unstartedRuns } = require('../../scripts/ui-resume.cjs')
  const base = { logical_run_id: 'model-only', task_id: 'task', template_id: 't', title: '模型受阻', created_at: 10, segments: [], lifecycle: { state: 'BLOCKED', reason: { code: 'PROBE_FAILED' } } }
  const rows = unstartedRuns([base, { ...base, logical_run_id: 'isolation', isolation_guarantee: 'unavailable' }, { ...base, logical_run_id: 'started', segments: [{ run_id: 'r1' }] }])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, 'logical:model-only'); assert.equal(rows[0].segment_count, 0); assert.equal(rows[0].execution_not_started, true)
  assert.equal(base.segments.length, 0)
})

test('WFM-67/81 同时展示模型受阻与隔离不可用的未起段运行，各一行且无伪造段', async t => {
  const isolation = { logical_run_id: 'other-isolation', task_id: 'other', title: '隔离不可用', isolation_guarantee: 'unavailable', lifecycle: { state: 'BLOCKED', reason: { code: 'PROBE_FAILED' } }, segments: [], snapshots: [], node_attempts: [] }
  const raw = JSON.stringify(isolation)
  const path = DSH_HOME + '/visual-workflow/logical-runs/other-isolation.json'
  const h = await env(t, { seed: { [path]: raw } }); h.setFail('m1')
  await h.tool({ templateId: 'ui-resume-spec', taskId: 'task-ui' }); await drain()
  const rows = (await h.list()).runs
  assert.deepEqual(rows.map(r => r.id).sort(), ['logical:other-isolation', 'logical:task-ui'])
  assert.equal(rows.find(r => r.id === 'logical:other-isolation').isolation_guarantee, 'unavailable')
  for (const row of rows) { assert.equal(row.segment, null); assert.equal(row.segment_count, 0); assert.equal(row.execution_not_started, true) }
  assert.equal(h.engine.starts.length, 0)
  assert.deepEqual(h.read().segments, [])
  assert.equal(h.fs._files.get(path), raw, '只读投影不得改写旧记录')
})
