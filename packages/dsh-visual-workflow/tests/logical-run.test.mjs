// Logical Run 逻辑运行摘要（#79）单元测试（fake fs 服务）：
// 创建 + 快照 Rev1 冻结 / 八态 Lifecycle 映射与结构化 reason / 跨人工决策同 Run 分段 /
// model_overrides 追加修订与节点实际修订/模型记录 / 额度耗尽保留业务结果 /
// 终态后拒绝续跑 + 派生新运行 / 崩溃残留派生 / 旧记录只读兼容 / 重启回载 /
// 平台直起退化摘要 / #93 工作区上下文入档
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { loadHost } from './helpers/load-host.mjs'
import { REPO, DSH_HOME, makeFs, makeSubprocess, sandboxPolicy, USER_DIR, SKILL_ROOT } from './helpers/fake-services.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const RUNS_DIR = DSH_HOME + '/visual-workflow/runs'
const LOGICAL_DIR = DSH_HOME + '/visual-workflow/logical-runs'
const validatorCoreSrc = readFileSync(join(here, '..', '..', '..', 'scripts', 'validate-core.cjs'), 'utf8')

// 规格图：新模式探索节点（可穷举业务结果，outcomePath 指向 $.verdict）+ 旧模式
// 收口节点。宿主层测试用假引擎注入脚本终态，业务结果提取与图路由解耦。
const SPEC_BLUEPRINT = {
  id: 'logical-run-spec', displayName: '逻辑运行规格图', description: '', entry: 'explore',
  control: { maxRounds: 9 },
  bindings: { models: { explore: { provider: 'p1', model: 'm1' }, closeout: { provider: 'p1', model: 'm1' } } },
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
const readLogical = (fs, id) => {
  const key = LOGICAL_DIR + '/' + encodeURIComponent(id) + '.json'
  const raw = fs._files.get(key)
  assert.ok(raw, '逻辑运行摘要应已落盘：' + key)
  return JSON.parse(raw)
}
const logicalFiles = (fs) => [...fs._files.keys()].filter((k) => k.startsWith(LOGICAL_DIR + '/'))

function env({ seed = {}, extra = {}, subprocess = null } = {}) {
  const base = {
    [REPO + '/scripts/validate-core.cjs']: validatorCoreSrc,
    [USER_DIR + '/logical-run-spec.json']: JSON.stringify(SPEC_BLUEPRINT, null, 2) + '\n',
    [SKILL_ROOT + '/logical-run-spec/script.mjs']: '//MOCK-SCRIPT',
  }
  Object.assign(base, seed)
  const fs = makeFs(base)
  const sub = subprocess || makeSubprocess({ fs, compileScript: '//MOCK-SCRIPT' })
  const { handlers, definedTools, events, ctx } = loadHost({ fs, subprocess: sub, sandboxPolicy, ...extra })
  return { handlers, definedTools, events, ctx, fs, sub }
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

// 结束一次运行：resolve 引擎 result + 投递 start/end 事件（真实引擎事件语义）
async function runOnce(eng, events, wfRun, args) {
  const p = wfRun.execute({ templateId: 'logical-run-spec', ...args })
  await until(() => eng.starts.length >= 1, '启动')
  const runId = 'run-' + eng.starts.length
  events.get('workflow/start')({ id: runId, meta: { name: '逻辑运行规格图' } })
  return { promise: p, runId }
}

function settleRun(eng, events, runId, scriptStatus, extra = {}) {
  eng.end(runId, 'completed', { status: scriptStatus, ...extra })
  events.get('workflow/end')({ id: runId }, { stopReason: 'completed' })
}

function engineEnv(eng, opts = {}) {
  return env({
    extra: { workflowEngine: eng, agents: { requireInitiator: () => ({}), currentInitiator: () => null }, ...(opts.extra || {}) },
    seed: opts.seed,
    subprocess: opts.subprocess,
  })
}

async function until(fn, label, ms = 4000) {
  const t0 = Date.now()
  while (true) {
    if (await fn()) return
    if (Date.now() - t0 > ms) throw new Error('until 超时：' + (label || '条件未满足'))
    await new Promise((r) => setTimeout(r, 5))
  }
}

test('#79 创建逻辑运行：稳定 logical_run_id + 快照 Rev1 冻结 + 第 1 段', async () => {
  const eng = makeEngine()
  const { events, definedTools, fs } = engineEnv(eng)
  const wfRun = definedTools.find((t) => t.name === 'wf_run')
  const p = wfRun.execute({ templateId: 'logical-run-spec', taskId: 'issue-lr' })
  await until(() => eng.starts.length >= 1, '启动')
  events.get('workflow/start')({ id: 'run-1', meta: { name: '逻辑运行规格图' } })
  settleRun(eng, events, 'run-1', 'DONE', { results: { explore: { verdict: 'PASS' }, closeout: { result: 'ok' } } })
  await p
  await drain()

  const rec = readLogical(fs, 'issue-lr')
  assert.equal(rec.logical_run_id, 'issue-lr', '首次运行 logical_run_id = taskId')
  assert.equal(rec.task_id, 'issue-lr')
  assert.equal(rec.template_id, 'logical-run-spec')
  assert.equal(rec.lifecycle.state, 'COMPLETED', 'DONE → COMPLETED 终态')
  assert.equal(rec.terminal, true)
  assert.equal(rec.derived_from, null)
  // 快照 Rev1 冻结
  assert.equal(rec.snapshots.length, 1)
  const rev1 = rec.snapshots[0]
  assert.equal(rev1.revision, 1)
  assert.equal(rev1.active, true)
  assert.equal(rev1.workflow.dsl.id, 'logical-run-spec', '工作流定义冻结进快照')
  assert.equal(typeof rev1.script, 'string', '编译产物（内联角色与路由）冻结进 Rev1')
  assert.deepEqual(rev1.provider_model, { explore: { provider: 'p1', model: 'm1' }, closeout: { provider: 'p1', model: 'm1' } })
  // 第 1 段
  assert.equal(rec.segments.length, 1)
  assert.equal(rec.segments[0].index, 1)
  assert.equal(rec.segments[0].run_id, 'run-1')
  assert.equal(rec.segments[0].trigger, 'start')
  assert.equal(rec.segments[0].status, 'DONE')
  // 节点实际记录（Rev1 / p1/m1）+ 业务结果（outcomePath 提取）
  const exp = rec.node_attempts.find((a) => a.node === 'explore')
  assert.equal(exp.snapshot_revision, 1)
  assert.equal(exp.provider, 'p1')
  assert.equal(exp.model, 'm1')
  assert.equal(rec.business_outcomes.explore.outcome, 'PASS', '业务结果按 outcomePath 提取并与 Lifecycle 分别持久化')
  // 完成类型镜像（#77 形状）
  assert.deepEqual(rec.completion, null, '脚本未报 completion 时镜像为 null')
})

test('#79 跨人工决策同一逻辑运行：WAITING_HUMAN 结构化 reason → 续跑第 2 段 → COMPLETED', async () => {
  const eng = makeEngine()
  const { events, definedTools, fs } = engineEnv(eng)
  const wfRun = definedTools.find((t) => t.name === 'wf_run')
  // 段 1：停在人工决策
  const p1 = wfRun.execute({ templateId: 'logical-run-spec', taskId: 'issue-hd' })
  await until(() => eng.starts.length >= 1, '启动1')
  events.get('workflow/start')({ id: 'run-1', meta: { name: 'x' } })
  settleRun(eng, events, 'run-1', 'WAITING_HUMAN', {
    reason: 'ESCALATED_DECISION', decision_id: 'd1', node: 'explore',
    decision_package: { why: 'w' }, results: { explore: { verdict: 'PASS' } },
  })
  await p1
  await drain()
  let rec = readLogical(fs, 'issue-hd')
  assert.equal(rec.lifecycle.state, 'WAITING_HUMAN')
  assert.deepEqual(rec.lifecycle.reason, { code: 'ESCALATED_DECISION' }, '结构化 reason，非 AWAITING_HUMAN_x 字符串状态')
  assert.equal(rec.terminal, false)
  assert.equal(rec.segments.length, 1)
  assert.equal(rec.segments[0].status, 'WAITING_HUMAN')

  // 段 2：决策续跑，同一 logical_run_id
  const p2 = wfRun.execute({ templateId: 'logical-run-spec', taskId: 'issue-hd', decision_id: 'd1', user_choice: 'USER_ACCEPTED' })
  await until(() => eng.starts.length >= 2, '启动2')
  assert.equal(eng.starts[1].args.decision_id, 'd1')
  events.get('workflow/start')({ id: 'run-2', meta: { name: 'x' } })
  settleRun(eng, events, 'run-2', 'DONE', {
    results: { explore: { verdict: 'PASS' }, closeout: { result: 'final' } },
    completion: { type: 'EVALUATION_PASSED', node: 'closeout', path: '$.result' },
  })
  await p2
  await drain()
  rec = readLogical(fs, 'issue-hd')
  assert.equal(rec.segments.length, 2, '人工决策续跑不产生新的用户级 Run，追加为第 2 段')
  assert.equal(rec.segments[1].index, 2)
  assert.equal(rec.segments[1].run_id, 'run-2')
  assert.equal(rec.segments[1].trigger, 'human_decision')
  assert.equal(rec.segments[1].decision_id, 'd1')
  assert.equal(rec.lifecycle.state, 'COMPLETED')
  assert.equal(rec.completion.type, 'EVALUATION_PASSED', '完成类型镜像与 Lifecycle 分离持久化')
  // 段 2 节点实际记录只含新完成节点（explore 属段 1）
  const attempts = rec.node_attempts
  assert.equal(attempts.filter((a) => a.node === 'explore').length, 1, 'explore 仅段 1 记录一次')
  assert.equal(attempts.find((a) => a.node === 'closeout').segment, 2)
  // 逻辑运行文件唯一：一次任务一个摘要
  assert.equal(logicalFiles(fs).length, 1)
})

test('#79 model_overrides 续跑：追加 Rev2 不覆盖 Rev1，节点保留当时实际修订/模型', async () => {
  const eng = makeEngine()
  const { events, definedTools, fs } = engineEnv(eng)
  const wfRun = definedTools.find((t) => t.name === 'wf_run')
  const p1 = wfRun.execute({ templateId: 'logical-run-spec', taskId: 'issue-rev' })
  await until(() => eng.starts.length >= 1, '启动1')
  events.get('workflow/start')({ id: 'run-1', meta: { name: 'x' } })
  settleRun(eng, events, 'run-1', 'WAITING_HUMAN', {
    reason: 'ESCALATED_DECISION', decision_id: 'd1', node: 'explore',
    decision_package: { why: 'w' }, results: { explore: { verdict: 'PASS' } },
  })
  await p1
  await drain()

  const p2 = wfRun.execute({
    templateId: 'logical-run-spec', taskId: 'issue-rev', decision_id: 'd1', user_choice: 'USER_ACCEPTED',
    model_overrides: { explore: { provider: 'p2', model: 'm2' } },
  })
  await until(() => eng.starts.length >= 2, '启动2')
  // Codex R2 ②：透传的是 active 快照的合并绑定（含未覆盖节点），而非本次 delta
  assert.deepEqual(eng.starts[1].args.model_overrides, { explore: { provider: 'p2', model: 'm2' }, closeout: { provider: 'p1', model: 'm1' } }, '合并绑定透传给编译脚本')
  events.get('workflow/start')({ id: 'run-2', meta: { name: 'x' } })
  settleRun(eng, events, 'run-2', 'DONE', { results: { closeout: { result: 'ok' } } })
  await p2
  await drain()

  const rec = readLogical(fs, 'issue-rev')
  assert.equal(rec.snapshots.length, 2, '追加式修订')
  const rev1 = rec.snapshots[0]
  const rev2 = rec.snapshots[1]
  assert.equal(rev1.revision, 1)
  assert.equal(rev1.active, false, '旧修订保留但不再活跃')
  assert.equal(rev1.provider_model.explore.provider, 'p1', 'Rev1 的模型绑定不被覆盖')
  assert.equal(rev2.revision, 2)
  assert.equal(rev2.active, true)
  assert.deepEqual(rev2.provider_model.explore, { provider: 'p2', model: 'm2' })
  assert.deepEqual(rev2.provider_model.closeout, { provider: 'p1', model: 'm1' }, '未覆盖节点沿用旧绑定')
  assert.equal(rev2.script_ref, 1, '仅 Provider/Model 变更，脚本引用 Rev1 不复制')
  assert.equal(rev2.script, undefined)
  // 节点实际记录：段 1 explore 用 Rev1/p1/m1；段 2 closeout 用 Rev2/p1/m1
  const exp = rec.node_attempts.find((a) => a.node === 'explore')
  const clo = rec.node_attempts.find((a) => a.node === 'closeout')
  assert.equal(exp.snapshot_revision, 1)
  assert.deepEqual({ provider: exp.provider, model: exp.model }, { provider: 'p1', model: 'm1' })
  assert.equal(clo.snapshot_revision, 2)
  assert.deepEqual({ provider: clo.provider, model: clo.model }, { provider: 'p1', model: 'm1' })
})

test('#79 额度耗尽：WAITING_HUMAN + MAX_ROUNDS_REACHED，业务结果保留不被改写', async () => {
  const eng = makeEngine()
  const { events, definedTools, fs } = engineEnv(eng)
  const wfRun = definedTools.find((t) => t.name === 'wf_run')
  const p = wfRun.execute({ templateId: 'logical-run-spec', taskId: 'issue-budget' })
  await until(() => eng.starts.length >= 1, '启动')
  events.get('workflow/start')({ id: 'run-1', meta: { name: 'x' } })
  settleRun(eng, events, 'run-1', 'WAITING_HUMAN', {
    reason: 'MAX_ROUNDS_REACHED', node: 'explore',
    control_event: { node_id: 'explore', triggering_node_outcome: 'NEEDS_RESEARCH' },
    results: { explore: { verdict: 'NEEDS_RESEARCH' } },
  })
  await p
  await drain()
  const rec = readLogical(fs, 'issue-budget')
  assert.equal(rec.lifecycle.state, 'WAITING_HUMAN')
  assert.deepEqual(rec.lifecycle.reason, { code: 'MAX_ROUNDS_REACHED' }, '额度耗尽结构化原因码')
  assert.equal(rec.terminal, false, '额度耗尽不是失败')
  assert.equal(rec.business_outcomes.explore.outcome, 'NEEDS_RESEARCH', '触发闸门前业务结果保留')
  assert.equal(rec.lifecycle.state !== 'FAILED', true, '业务结果未被 Lifecycle 改写为失败')
})

test('#79 终态后：恢复请求被拒；重新发起派生新运行并保留来源', async () => {
  const eng = makeEngine()
  const { events, definedTools, fs } = engineEnv(eng)
  const wfRun = definedTools.find((t) => t.name === 'wf_run')
  const p1 = wfRun.execute({ templateId: 'logical-run-spec', taskId: 'issue-done' })
  await until(() => eng.starts.length >= 1, '启动1')
  events.get('workflow/start')({ id: 'run-1', meta: { name: 'x' } })
  settleRun(eng, events, 'run-1', 'DONE', { results: { explore: { verdict: 'PASS' } } })
  await p1
  await drain()

  // 终态后恢复请求拒绝
  const rejected = await wfRun.execute({ templateId: 'logical-run-spec', taskId: 'issue-done', decision_id: 'd1', user_choice: 'USER_ACCEPTED' })
  assert.ok(String(rejected).includes('已终态'), '终态后同一运行不可继续：' + rejected)
  assert.equal(eng.starts.length, 1, '拒绝路径不启动引擎')

  // 重新发起 = 派生新逻辑运行（R8）
  const p2 = wfRun.execute({ templateId: 'logical-run-spec', taskId: 'issue-done' })
  await until(() => eng.starts.length >= 2, '启动2')
  events.get('workflow/start')({ id: 'run-2', meta: { name: 'x' } })
  settleRun(eng, events, 'run-2', 'DONE', { results: { explore: { verdict: 'PASS' } } })
  await p2
  await drain()
  const first = readLogical(fs, 'issue-done')
  assert.equal(first.lifecycle.state, 'COMPLETED', '前任运行记录不被续写篡改')
  const derived = readLogical(fs, 'issue-done#2')
  assert.equal(derived.derived_from, 'issue-done', '派生保留来源关系')
  assert.equal(derived.segments.length, 1)
  assert.equal(logicalFiles(fs).length, 2)
})

test('#79 崩溃残留：同 taskId 重启后前任标 FAILED（RUNTIME_RESTARTED）并派生新运行', async () => {
  const seed = {}
  seed[LOGICAL_DIR + '/' + encodeURIComponent('issue-stale') + '.json'] = JSON.stringify({
    logical_run_id: 'issue-stale', schema: 1, task_id: 'issue-stale', template_id: 'logical-run-spec',
    title: 'x', derived_from: null, created_at: 1, updated_at: 2,
    lifecycle: { state: 'RUNNING', reason: null }, terminal: false, completion: null,
    segments: [{ index: 1, run_id: 'old-1', trigger: 'start', started_at: 1, ended_at: null, status: 'running', active: true }],
    snapshots: [], node_attempts: [], business_outcomes: {}, workspace: null,
  }, null, 2) + '\n'
  seed[RUNS_DIR + '/old-1.json'] = JSON.stringify({
    id: 'old-1', meta: { name: 'x', description: '' }, status: 'running', phase: '', logs: [], agents: [],
    taskId: 'issue-stale', workflowId: 'logical-run-spec', startedAt: 1, supersededBy: '', updatedAt: 2,
  }, null, 2) + '\n'
  const eng = makeEngine()
  const { events, definedTools, fs } = engineEnv(eng, { seed })
  const wfRun = definedTools.find((t) => t.name === 'wf_run')
  const p = wfRun.execute({ templateId: 'logical-run-spec', taskId: 'issue-stale' })
  await until(() => eng.starts.length >= 1, '启动')
  events.get('workflow/start')({ id: 'run-1', meta: { name: 'x' } })
  settleRun(eng, events, 'run-1', 'DONE', { results: { explore: { verdict: 'PASS' } } })
  await p
  await drain()
  const prior = readLogical(fs, 'issue-stale')
  assert.equal(prior.lifecycle.state, 'FAILED')
  assert.equal(prior.lifecycle.reason.code, 'RUNTIME_RESTARTED', '前任以结构化 reason 收口')
  const derived = readLogical(fs, 'issue-stale#2')
  assert.equal(derived.derived_from, 'issue-stale')
  assert.equal(derived.lifecycle.state, 'COMPLETED')
})

test('#79 旧历史记录只读兼容：旧 runs 记录无逻辑字段、磁盘内容零改写；升级后续跑新逻辑运行承接', async () => {
  const seed = {}
  seed[RUNS_DIR + '/legacy-run.json'] = JSON.stringify({
    id: 'legacy-run', meta: { name: '旧形态', description: '' }, status: 'DONE', phase: 'closeout',
    logs: [], agents: [], taskId: 'issue-legacy', workflowId: 'w', startedAt: 1000, supersededBy: '', updatedAt: 1000,
  }, null, 2) + '\n'
  const eng = makeEngine()
  const { events, definedTools, fs, handlers } = engineEnv(eng, { seed })
  const wfRun = definedTools.find((t) => t.name === 'wf_run')
  await drain()
  const list = await call(handlers, 'vwf.runs.list')
  assert.equal(list.runs.length, 1)
  assert.equal(list.runs[0].logical_run_id, undefined, '旧记录无逻辑运行归属字段（R13：不回写 runs 记录）')
  const legacyBefore = fs._files.get(RUNS_DIR + '/legacy-run.json')

  // 升级后对旧 taskId 续跑（无逻辑运行可挂）：新逻辑运行承接，不回写旧记录（R14）
  const p = wfRun.execute({ templateId: 'logical-run-spec', taskId: 'issue-legacy', entry: 'explore', approved: true })
  await until(() => eng.starts.length >= 1, '启动')
  events.get('workflow/start')({ id: 'run-1', meta: { name: 'x' } })
  settleRun(eng, events, 'run-1', 'DONE', { results: { explore: { verdict: 'PASS' } } })
  await p
  await drain()
  assert.equal(fs._files.get(RUNS_DIR + '/legacy-run.json'), legacyBefore, '旧 runs 记录文件零改写')
  const rec = readLogical(fs, 'issue-legacy')
  assert.equal(rec.segments.length, 1)
  assert.equal(rec.segments[0].trigger, 'legacy_resume')
  // 逻辑运行只读取：旧 taskId 的 runs 记录无对应摘要
  const missing = await call(handlers, 'vwf.logicalRuns.get', { logical_run_id: 'nonexistent' })
  assert.equal(missing.found, false)
})

test('#79 重启回载：逻辑运行摘要全量回载，list join 与续跑索引照常工作', async () => {
  // 实例 A：跑两段（停人工 → 续跑完成）
  const engA = makeEngine()
  const envA = engineEnv(engA)
  const wfRunA = envA.definedTools.find((t) => t.name === 'wf_run')
  const p1 = wfRunA.execute({ templateId: 'logical-run-spec', taskId: 'issue-hy' })
  await until(() => engA.starts.length >= 1, '启动1')
  envA.events.get('workflow/start')({ id: 'run-1', meta: { name: 'x' } })
  settleRun(engA, envA.events, 'run-1', 'WAITING_HUMAN', { reason: 'ESCALATED_DECISION', decision_id: 'd1', decision_package: {}, results: {} })
  await p1
  const p2 = wfRunA.execute({ templateId: 'logical-run-spec', taskId: 'issue-hy', decision_id: 'd1', user_choice: 'USER_ACCEPTED' })
  await until(() => engA.starts.length >= 2, '启动2')
  envA.events.get('workflow/start')({ id: 'run-2', meta: { name: 'x' } })
  settleRun(engA, envA.events, 'run-2', 'DONE', { results: { explore: { verdict: 'PASS' } } })
  await p2
  await drain()

  // 实例 B：同 fs 重启 → 回载后 join 索引重建、摘要在位
  const envB = env({ seed: Object.fromEntries(envA.fs._files), extra: { workflowEngine: makeEngine('b-'), agents: { requireInitiator: () => ({}), currentInitiator: () => null } } })
  await drain()
  const list = await call(envB.handlers, 'vwf.runs.list')
  const row1 = list.runs.find((r) => r.id === 'run-1')
  const row2 = list.runs.find((r) => r.id === 'run-2')
  assert.equal(row1.logical_run_id, 'issue-hy')
  assert.equal(row1.segment, 1)
  assert.equal(row1.segment_count, 2)
  assert.equal(row1.logical_state, 'COMPLETED')
  assert.equal(row2.segment, 2)
  const got = await call(envB.handlers, 'vwf.logicalRuns.get', { logical_run_id: 'issue-hy' })
  assert.equal(got.found, true)
  assert.equal(got.record.segments.length, 2)
  // 损坏摘要容错：跳过并留痕，不阻断其余回载
  envB.fs._files.set(LOGICAL_DIR + '/' + encodeURIComponent('broken') + '.json', '{oops')
  const envC = env({ seed: Object.fromEntries(envB.fs._files), extra: { workflowEngine: makeEngine('c-'), agents: { requireInitiator: () => ({}), currentInitiator: () => null } } })
  const got2 = await call(envC.handlers, 'vwf.logicalRuns.get', { logical_run_id: 'issue-hy' })
  assert.equal(got2.found, true, '单文件损坏不影响其余摘要回载')
})

test('#79 平台 workflow 工具直起：事件可得信息落退化摘要', async () => {
  const { events, fs, handlers } = env()
  events.get('workflow/start')({ id: 'plat-1', meta: { name: '平台直起' } })
  events.get('workflow/end')({ id: 'plat-1' }, { stopReason: 'completed' })
  await drain()
  const rec = readLogical(fs, 'plat-1')
  assert.equal(rec.logical_run_id, 'plat-1')
  assert.equal(rec.lifecycle.state, 'COMPLETED')
  assert.equal(rec.terminal, true)
  assert.equal(rec.completion, null, '事件层 value 被剥掉：完成类型按可得信息落档（已知限制）')
  assert.equal(rec.segments.length, 1)
  assert.equal(rec.segments[0].trigger, 'engine_event')
  assert.equal(rec.segments[0].status, 'completed')
  assert.equal(rec.snapshots.length, 0, '无 wf_run 边界：无快照冻结')
  // 取消运行 → FAILED 结构化原因
  events.get('workflow/start')({ id: 'plat-2', meta: { name: 'x' } })
  events.get('workflow/end')({ id: 'plat-2' }, { stopReason: 'cancelled' })
  await drain()
  const rec2 = readLogical(fs, 'plat-2')
  assert.equal(rec2.lifecycle.state, 'FAILED')
  assert.equal(rec2.lifecycle.reason.code, 'ENGINE_CANCELLED')
})

test('#79 #93 工作区上下文入档：身份/事件/锁复制进摘要；清理审计沿真实时序经 cleanup RPC 入档', async () => {
  const seed = { [REPO + '/scripts/workspace-isolation-host.mjs']: '//wrapper-stub' }
  const fs = makeFs({
    [REPO + '/scripts/validate-core.cjs']: validatorCoreSrc,
    [USER_DIR + '/logical-run-spec.json']: JSON.stringify(SPEC_BLUEPRINT, null, 2) + '\n',
    [SKILL_ROOT + '/logical-run-spec/script.mjs']: '//MOCK-SCRIPT',
    ...seed,
  })
  const base = makeSubprocess({ fs, compileScript: '//MOCK-SCRIPT' })
  const reader = (text) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })
  const reply = (body) => ({ pid: 1, done: Promise.resolve({ exitCode: 0, signal: null }), collected: { stdout: reader(JSON.stringify(body)), stderr: reader('') }, terminate() {}, waitForExit: async () => true })
  const origSpawn = base.spawn.bind(base)
  const wsIdentity = { workspace_id: 'ws-9', workspace_mode: 'ISOLATED_WRITE', workspace_path: '/home/workspaces/ws-9', source_path: '/home/workspaces/ws-9/source', source_revision: 'abc123', work_branch: 'wf/issue-ws', current_head: 'def456', base_commit: 'aaa000', lifecycle: 'COMPLETED', created_at: 111 }
  // 真实时序模拟：终态收尾刷新（尚未清理）context 无 cleanup；只有 cleanup 命令
  // 发生后，#93 注册表才有 archived 审计可供 context 取回。
  let cleaned = false
  base.spawn = (spec) => {
    const a = spec.argv
    if (a.some((x) => String(x).includes('workspace-isolation-host.mjs'))) {
      const cmd = a[2]
      if (cmd === 'allocate') return reply({ ok: true, workspace: { ...wsIdentity, lifecycle: 'RUNNING' } })
      if (cmd === 'cleanup') { cleaned = true; return reply({ ok: true, logical_run_id: 'issue-ws' }) }
      if (cmd === 'context') {
        return reply({
          ok: true,
          workspace: cleaned ? null : wsIdentity,
          events: [
            { at: 't1', type: 'workspace_allocated', logical_run_id: 'issue-ws', workspace_id: 'ws-9' },
            { at: 't2', type: 'lifecycle', logical_run_id: 'issue-ws', lifecycle: 'COMPLETED' },
            { at: 't3', type: 'lock_acquired', logical_run_id: 'issue-ws', resource_key: 'integration' },
          ],
          cleanup: cleaned ? { identity: { workspace_id: 'ws-9' }, audit: { at: 't4', artifacts: 'removed', records: 'retained' } } : null,
        })
      }
      return reply({ ok: true, workspace: wsIdentity })
    }
    return origSpawn(spec)
  }
  const eng = makeEngine()
  const { events, definedTools, handlers } = loadHost({ fs, subprocess: base, sandboxPolicy, workflowEngine: eng, agents: { requireInitiator: () => ({}), currentInitiator: () => null } })
  const wfRun = definedTools.find((t) => t.name === 'wf_run')
  const p = wfRun.execute({ templateId: 'logical-run-spec', taskId: 'issue-ws' })
  await until(() => eng.starts.length >= 1, '启动')
  events.get('workflow/start')({ id: 'run-1', meta: { name: 'x' } })
  settleRun(eng, events, 'run-1', 'DONE', { results: { explore: { verdict: 'PASS' } } })
  await p
  await drain()
  const rec = readLogical(fs, 'issue-ws')
  assert.equal(rec.workspace.workspace_id, 'ws-9')
  assert.equal(rec.workspace.source_revision, 'abc123', '源版本入档')
  assert.equal(rec.workspace.work_branch, 'wf/issue-ws')
  assert.equal(rec.workspace.current_head, 'def456', 'branch HEAD 入档')
  assert.equal(rec.workspace.events.length, 3, '#93 事件时间线随任务入档')
  assert.equal(rec.workspace.resource_locks.length, 1, '资源锁事件入档')
  assert.equal(rec.workspace.cleanup, null, '终态收尾时清理尚未发生：审计不可预置')
  assert.equal(eng.starts[0].args.workspace_id, 'ws-9', 'workspace 注入脚本 args')
  assert.equal(eng.starts[0].args.model_overrides, undefined, '新启不透传 model_overrides（归因闸门一致）')

  // 沿真实调用时序清理：vwf.workspace.cleanup RPC 成功后审计回写入档
  const cap = eng.starts[0].args.workspace_capability
  const cleanupResult = await call(handlers, 'vwf.workspace.cleanup', { logical_run_id: 'issue-ws', capability: cap })
  assert.equal(cleanupResult.ok, true)
  await drain()
  const after = readLogical(fs, 'issue-ws')
  assert.equal(after.workspace.cleanup.audit.records, 'retained', '清理审计入档：正式记录与溯源不随清理删除')
  assert.equal(after.workspace.workspace_id, 'ws-9', '清理后身份/事件入档保留（可追溯）')
  assert.equal(after.workspace.events.length, 3)
})

test('#79 DSH Home 探针：子进程 DSH_* 被剥离时沿祖先进程链读回真实 Home', async () => {
  // 新 harness 对子进程剥离全部 DSH_* 环境（scrubbedParentEnv）：探针自身 env 无
  // DSH_HOME 时必须沿祖先进程链 `ps eww` 读回真实 Home，而不是误落产品 ~/.dsh。
  const CUSTOM_HOME = '/custom-dev-home'
  const fs = makeFs({
    [REPO + '/scripts/validate-core.cjs']: validatorCoreSrc,
    [CUSTOM_HOME + '/visual-workflow/templates/logical-run-spec.json']: JSON.stringify(SPEC_BLUEPRINT, null, 2) + '\n',
    [CUSTOM_HOME + '/skills/logical-run-spec/script.mjs']: '//MOCK-SCRIPT',
  })
  const base = makeSubprocess({ fs, compileScript: '//MOCK-SCRIPT' })
  const reader = (text) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })
  const reply = (stdout) => ({ pid: 1, done: Promise.resolve({ exitCode: 0, signal: null }), collected: { stdout: reader(stdout), stderr: reader('') }, terminate() {}, waitForExit: async () => true })
  const origSpawn = base.spawn.bind(base)
  base.spawn = (spec) => {
    const argvStr = spec.argv.join(' ')
    if (argvStr.includes('process.env.DSH_HOME') && argvStr.includes('ps eww')) {
      return reply(CUSTOM_HOME)
    }
    return origSpawn(spec)
  }
  const eng = makeEngine()
  // processValue 不带 DSH_HOME：模拟动态 vm 沙箱（process.env 无 DSH_HOME），逼探针走祖链
  const { events, definedTools } = loadHost({ processValue: { env: { HOME: '/Users/tester' }, cwd: () => REPO }, fs, subprocess: base, sandboxPolicy, workflowEngine: eng, agents: { requireInitiator: () => ({}), currentInitiator: () => null } })
  const wfRun = definedTools.find((t) => t.name === 'wf_run')
  const p = wfRun.execute({ templateId: 'logical-run-spec', taskId: 'uat-home-01' })
  await until(() => eng.starts.length >= 1, '启动')
  events.get('workflow/start')({ id: 'run-1', meta: { name: 'x' } })
  settleRun(eng, events, 'run-1', 'DONE', { results: { explore: { verdict: 'PASS' } } })
  await p
  await drain()
  const rec = JSON.parse(fs._files.get(CUSTOM_HOME + '/visual-workflow/logical-runs/' + encodeURIComponent('uat-home-01') + '.json'))
  assert.equal(rec.task_id, 'uat-home-01', '运行摘要落在祖链解析出的真实 Home')
  assert.ok(![...fs._files.keys()].some((k) => k.startsWith(DSH_HOME + '/visual-workflow/logical-runs/')), '不再误落默认 ~/.dsh')
})

test('#79 Codex R2 ②：多轮修订累积——Rev3 只改 B 时，A 仍按 Rev2 合并值执行', async () => {
  const eng = makeEngine()
  const { events, definedTools, fs: fs0 } = engineEnv(eng)
  const wfRun = definedTools.find((t) => t.name === 'wf_run')
  // 段 1：发起（Rev1：explore=p1/m1, closeout=p1/m1）→ 停人工
  const p1 = wfRun.execute({ templateId: 'logical-run-spec', taskId: 'issue-cum' })
  await until(() => eng.starts.length >= 1, '启动1')
  events.get('workflow/start')({ id: 'run-1', meta: { name: 'x' } })
  settleRun(eng, events, 'run-1', 'WAITING_HUMAN', { reason: 'ESCALATED_DECISION', decision_id: 'd1', decision_package: {}, results: {} })
  await p1
  await drain()
  // 段 2：Rev2 = explore → p2/m2，再停人工
  const p2 = wfRun.execute({ templateId: 'logical-run-spec', taskId: 'issue-cum', decision_id: 'd1', user_choice: 'USER_ACCEPTED', model_overrides: { explore: { provider: 'p2', model: 'm2' } } })
  await until(() => eng.starts.length >= 2, '启动2')
  events.get('workflow/start')({ id: 'run-2', meta: { name: 'x' } })
  settleRun(eng, events, 'run-2', 'WAITING_HUMAN', { reason: 'ESCALATED_DECISION', decision_id: 'd2', decision_package: {}, results: {} })
  await p2
  await drain()
  // 段 3：Rev3 只改 closeout → p3/m3；explore 必须仍按 Rev2 的 p2/m2 执行
  const p3 = wfRun.execute({ templateId: 'logical-run-spec', taskId: 'issue-cum', decision_id: 'd2', user_choice: 'USER_ACCEPTED', model_overrides: { closeout: { provider: 'p3', model: 'm3' } } })
  await until(() => eng.starts.length >= 3, '启动3')
  assert.deepEqual(
    eng.starts[2].args.model_overrides,
    { explore: { provider: 'p2', model: 'm2' }, closeout: { provider: 'p3', model: 'm3' } },
    '传入的是 active 快照的合并绑定（Rev2 explore + Rev3 closeout），而非本次 delta'
  )
  events.get('workflow/start')({ id: 'run-3', meta: { name: 'x' } })
  settleRun(eng, events, 'run-3', 'DONE', { results: { explore: { verdict: 'PASS' }, closeout: { result: 'ok' } } })
  await p3
  await drain()
  const rec = readLogical(fs0, 'issue-cum')
})

test('#79 Codex R2 ①：模板等待期间被修改，续跑仍执行 Rev1 冻结脚本', async () => {
  const eng = makeEngine()
  const { events, definedTools, fs } = engineEnv(eng)
  const wfRun = definedTools.find((t) => t.name === 'wf_run')
  const p1 = wfRun.execute({ templateId: 'logical-run-spec', taskId: 'issue-frozen' })
  await until(() => eng.starts.length >= 1, '启动1')
  const scriptV1 = eng.starts[0].script
  events.get('workflow/start')({ id: 'run-1', meta: { name: 'x' } })
  settleRun(eng, events, 'run-1', 'WAITING_HUMAN', { reason: 'ESCALATED_DECISION', decision_id: 'd1', decision_package: {}, results: {} })
  await p1
  await drain()
  // 等待期间模板被改（换 id 不同名，模拟用户在编辑器另存覆盖）
  const mutated = JSON.parse(JSON.stringify(SPEC_BLUEPRINT))
  mutated.nodes[0].goal = '被修改过的目标'
  fs._files.set(USER_DIR + '/logical-run-spec.json', JSON.stringify(mutated, null, 2) + '\n')

  const p2 = wfRun.execute({ templateId: 'logical-run-spec', taskId: 'issue-frozen', decision_id: 'd1', user_choice: 'USER_ACCEPTED' })
  await until(() => eng.starts.length >= 2, '启动2')
  assert.equal(eng.starts[1].script, scriptV1, '续跑执行 Rev1 冻结脚本，而非重新编译的新脚本')
  events.get('workflow/start')({ id: 'run-2', meta: { name: 'x' } })
  settleRun(eng, events, 'run-2', 'DONE', { results: { closeout: { result: 'ok' } } })
  await p2
  await drain()
})

test('#79 Codex R2 ③：派生运行按自身 logical_run_id 分配 workspace', async () => {
  const fs = makeFs({
    [REPO + '/scripts/validate-core.cjs']: validatorCoreSrc,
    [USER_DIR + '/logical-run-spec.json']: JSON.stringify(SPEC_BLUEPRINT, null, 2) + '\n',
    [SKILL_ROOT + '/logical-run-spec/script.mjs']: '//MOCK-SCRIPT',
    [REPO + '/scripts/workspace-isolation-host.mjs']: '//wrapper-stub',
  })
  const base = makeSubprocess({ fs, compileScript: '//MOCK-SCRIPT' })
  const reader = (text) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })
  const reply = (body) => ({ pid: 1, done: Promise.resolve({ exitCode: 0, signal: null }), collected: { stdout: reader(JSON.stringify(body)), stderr: reader('') }, terminate() {}, waitForExit: async () => true })
  const origSpawn = base.spawn.bind(base)
  const allocCalls = []
  base.spawn = (spec) => {
    const a = spec.argv
    if (a.some((x) => String(x).includes('workspace-isolation-host.mjs'))) {
      const cmd = a[2]
      if (cmd === 'allocate') {
        const req = JSON.parse(a[3] || '{}')
        allocCalls.push(req.logical_run_id)
        return reply({ ok: true, workspace: { workspace_id: 'ws-' + req.logical_run_id, workspace_path: '/ws/' + req.logical_run_id, source_path: '/ws/' + req.logical_run_id + '/source' } })
      }
      return reply({ ok: true, workspace: {} })
    }
    return origSpawn(spec)
  }
  const eng = makeEngine()
  const { events, definedTools } = loadHost({ fs, subprocess: base, sandboxPolicy, workflowEngine: eng, agents: { requireInitiator: () => ({}), currentInitiator: () => null } })
  const wfRun = definedTools.find((t) => t.name === 'wf_run')
  // 第一轮完成（终态）
  const p1 = wfRun.execute({ templateId: 'logical-run-spec', taskId: 'issue-wsid' })
  await until(() => eng.starts.length >= 1, '启动1')
  events.get('workflow/start')({ id: 'run-1', meta: { name: 'x' } })
  settleRun(eng, events, 'run-1', 'DONE', { results: { explore: { verdict: 'PASS' } } })
  await p1
  await drain()
  // 重新发起 = 派生 issue-wsid#2，workspace 分配必须用派生 id
  const p2 = wfRun.execute({ templateId: 'logical-run-spec', taskId: 'issue-wsid' })
  await until(() => eng.starts.length >= 2, '启动2')
  assert.equal(eng.starts[1].args.workspace_id, 'ws-issue-wsid#2', '派生运行分配到自己的 workspace 身份')
  events.get('workflow/start')({ id: 'run-2', meta: { name: 'x' } })
  settleRun(eng, events, 'run-2', 'DONE', { results: { explore: { verdict: 'PASS' } } })
  await p2
  await drain()
  assert.deepEqual(allocCalls, ['issue-wsid', 'issue-wsid#2'], '两次分配分别用原始 id 与派生 id')
})
